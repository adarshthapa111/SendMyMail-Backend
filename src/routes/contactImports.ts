import { Router } from 'express';
import { z } from 'zod';
import { Prisma, type ImportJobStatus } from '@prisma/client';
import multer from 'multer';
import Papa from 'papaparse';
import { createReadStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { nanoid } from 'nanoid';
import { prisma } from '../lib/prisma';
import { requireAuth, requireClientScope, requireRole } from '../middleware/auth';
import { notFound, badRequest } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { roleAccountRate, ROLE_ACCOUNT_REJECT_THRESHOLD } from '../lib/roleAccounts';

/* /v1/clients/:clientId/contacts/imports — PR 2 of feature-contacts-lists.
   ─────────────────────────────────────────────────────────────────────────
   Async CSV import. POST queues an ImportJob and returns immediately; the
   job processes in the background. The frontend polls GET /:jobId every
   second for progress.

   Streaming + batching keeps memory flat regardless of file size:
   - multer writes the upload to os.tmpdir() (not memory)
   - papaparse Node API streams rows via `step` callbacks
   - We accumulate rows in chunks of 100 and createMany with skipDuplicates
   - Row-by-row state: only 100 contacts in RAM at any moment

   See tasks/feature-contacts-lists/change_log.md → "PR 2" for the design. */

export const contactImportsRouter = Router({ mergeParams: true });

/* ─── Multer setup ──────────────────────────────────────────────────────── */

const MAX_FILE_BYTES = 10 * 1024 * 1024;   // 10 MB
const TMP_DIR = tmpdir();

const upload = multer({
  storage: multer.diskStorage({
    destination: TMP_DIR,
    filename: (_req, _file, cb) => cb(null, `import-${nanoid(12)}.csv`),
  }),
  limits: {
    fileSize: MAX_FILE_BYTES,
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    // Accept .csv by MIME or extension (some browsers send octet-stream for CSVs)
    const ok =
      file.mimetype === 'text/csv' ||
      file.mimetype === 'application/vnd.ms-excel' ||
      file.mimetype === 'application/octet-stream' ||
      file.originalname.toLowerCase().endsWith('.csv');
    cb(null, ok);
  },
});

/* ─── Types + constants ─────────────────────────────────────────────────── */

type StandardField = 'email' | 'firstName' | 'lastName' | 'phone' | 'city' | 'birthday';
type MappingTarget = StandardField | 'skip' | `custom:${string}`;
type ColumnMapping = Record<string, MappingTarget>;   // { csvHeader: target }

const BATCH_SIZE = 100;
const MAX_ERRORS = 100;
const SAMPLE_SIZE_FOR_QUALITY = 200;

/* ─── Helpers ───────────────────────────────────────────────────────────── */

async function assertClientExists(req: import('express').Request): Promise<string> {
  const clientId = String(req.params.clientId ?? '');
  const exists = await prisma.client.findFirst({
    where: { id: clientId, agencyId: req.auth!.agency_id, status: { not: 'archived' } },
    select: { id: true },
  });
  if (!exists) throw notFound();
  return clientId;
}

function serialize(job: {
  id: string; agencyId: string; clientId: string; listId: string | null;
  createdBy: string; status: ImportJobStatus; rejectedReason: string | null;
  filename: string; fileSize: number; totalRows: number; processedRows: number;
  importedRows: number; skippedRows: number; rejectedRows: number;
  columnMapping: Prisma.JsonValue; consentText: string;
  errors: Prisma.JsonValue | null;
  startedAt: Date | null; completedAt: Date | null; createdAt: Date;
}) {
  return {
    id:             job.id,
    clientId:       job.clientId,
    listId:         job.listId,
    status:         job.status,
    rejectedReason: job.rejectedReason,
    filename:       job.filename,
    fileSize:       job.fileSize,
    totalRows:      job.totalRows,
    processedRows:  job.processedRows,
    importedRows:   job.importedRows,
    skippedRows:    job.skippedRows,
    rejectedRows:   job.rejectedRows,
    columnMapping:  job.columnMapping,
    errors:         job.errors,
    startedAt:      job.startedAt?.toISOString()   ?? null,
    completedAt:    job.completedAt?.toISOString() ?? null,
    createdAt:      job.createdAt.toISOString(),
  };
}

const mappingSchema = z.record(
  z.string(),     // CSV header
  z.string(),     // 'email' | 'firstName' | … | 'skip' | 'custom:foo'
);

/* ─── POST / — upload a CSV ──────────────────────────────────────────────── */

contactImportsRouter.post(
  '/',
  requireAuth(),
  requireClientScope,
  requireRole('admin'),                                    // only admin+ can import (sender-reputation risk)
  upload.single('file'),
  async (req, res, next) => {
    try {
      const clientId = await assertClientExists(req);
      const agencyId = req.auth!.agency_id;
      const userId   = req.auth!.sub;

      if (!req.file) throw badRequest('file_required', 'Upload a CSV file.', { field: 'file' });

      const rawMapping  = String(req.body.columnMapping ?? '');
      const consentText = String(req.body.consentText ?? '').trim();
      const listId      = req.body.listId ? String(req.body.listId) : null;

      // Parse + validate column mapping. The string values are validated at
      // read-time (we look for 'email' / 'firstName' / … / 'custom:foo'),
      // so the runtime shape is { csvHeader: string } here.
      let mapping: ColumnMapping;
      try {
        const parsed = mappingSchema.parse(JSON.parse(rawMapping));
        mapping = parsed as ColumnMapping;
      } catch {
        await unlink(req.file.path).catch(() => {});
        throw badRequest('invalid_mapping', 'columnMapping must be valid JSON of { csvHeader: target }.', {
          field: 'columnMapping',
        });
      }

      // Exactly one column must map to 'email'
      const emailCols = Object.entries(mapping).filter(([, t]) => t === 'email');
      if (emailCols.length === 0) {
        await unlink(req.file.path).catch(() => {});
        throw badRequest('email_column_required', 'Map one CSV column to "Email".', { field: 'columnMapping' });
      }
      if (emailCols.length > 1) {
        await unlink(req.file.path).catch(() => {});
        throw badRequest('email_column_duplicate', 'Only one column can map to "Email".', { field: 'columnMapping' });
      }

      if (!consentText) {
        await unlink(req.file.path).catch(() => {});
        throw badRequest('consent_required', 'Consent declaration is required.', { field: 'consentText' });
      }

      // Validate listId belongs to this client (if supplied)
      if (listId) {
        const lst = await prisma.list.findFirst({
          where: { id: listId, clientId, archived: false },
          select: { id: true },
        });
        if (!lst) {
          await unlink(req.file.path).catch(() => {});
          throw badRequest('invalid_list', 'The chosen list does not exist for this client.', { field: 'listId' });
        }
      }

      // Create the ImportJob row in `pending`; return immediately, process async
      const job = await prisma.importJob.create({
        data: {
          agencyId,
          clientId,
          listId,
          createdBy:     userId,
          status:        'pending',
          filename:      req.file.originalname,
          fileSize:      req.file.size,
          columnMapping: mapping as Prisma.InputJsonValue,
          consentText,
        },
      });

      writeAudit({
        agencyId,
        actorUserId: userId,
        action:      'contacts.import_started',
        targetType:  'import_job',
        targetId:    job.id,
        metadata:    { clientId, listId, filename: req.file.originalname, fileSize: req.file.size },
        req,
      });

      // Kick off processing — do NOT await. The response goes out now.
      processImport(job.id, req.file.path, mapping, listId, clientId, agencyId).catch((err) => {
        console.error(`[import ${job.id}] failed catastrophically:`, err);
      });

      res.status(201).json({ data: { job: serialize({ ...job, errors: null }) } });
    } catch (err) {
      next(err);
    }
  },
);

/* ─── GET / — list past imports for this client ─────────────────────────── */

contactImportsRouter.get('/', requireAuth(), requireClientScope, async (req, res, next) => {
  try {
    const clientId = String(req.params.clientId ?? '');
    const agencyId = req.auth!.agency_id;
    const jobs = await prisma.importJob.findMany({
      where: { clientId, agencyId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    res.json({ data: { items: jobs.map(serialize) } });
  } catch (err) {
    next(err);
  }
});

/* ─── GET /:jobId — single job (poll target) ────────────────────────────── */

contactImportsRouter.get('/:jobId', requireAuth(), requireClientScope, async (req, res, next) => {
  try {
    const jobId    = String(req.params.jobId ?? '');
    const clientId = String(req.params.clientId ?? '');
    const job = await prisma.importJob.findFirst({
      where: { id: jobId, clientId, agencyId: req.auth!.agency_id },
    });
    if (!job) throw notFound();
    res.json({ data: { job: serialize(job) } });
  } catch (err) {
    next(err);
  }
});

/* ─── Async processing ──────────────────────────────────────────────────── */

interface RowError { row: number; email?: string; reason: string }

async function processImport(
  jobId: string,
  filePath: string,
  mapping: ColumnMapping,
  listId: string | null,
  clientId: string,
  agencyId: string,
): Promise<void> {
  const startedAt = new Date();
  await prisma.importJob.update({
    where: { id: jobId },
    data:  { status: 'parsing', startedAt },
  });

  try {
    /* ─── Phase 1: count rows + role-account quality check on a sample ─── */
    const { totalRows, sampleEmails, headerIssues } = await scanFile(filePath, mapping);
    if (headerIssues.length > 0) {
      await prisma.importJob.update({
        where: { id: jobId },
        data: {
          status:         'failed',
          rejectedReason: 'invalid_csv',
          errors:         headerIssues.slice(0, MAX_ERRORS) as unknown as Prisma.InputJsonValue,
          completedAt:    new Date(),
        },
      });
      await unlink(filePath).catch(() => {});
      return;
    }

    if (sampleEmails.length > 0) {
      const rate = roleAccountRate(sampleEmails);
      if (rate > ROLE_ACCOUNT_REJECT_THRESHOLD) {
        await prisma.importJob.update({
          where: { id: jobId },
          data: {
            status:         'failed',
            rejectedReason: 'too_many_role_accounts',
            totalRows,
            errors:         [{ row: 0, reason: `${Math.round(rate * 100)}% of sampled rows are role accounts (info@, admin@, …). Importing these tanks deliverability for everyone. Edit your list and try again.` }],
            completedAt:    new Date(),
          },
        });
        await unlink(filePath).catch(() => {});
        return;
      }
    }

    await prisma.importJob.update({
      where: { id: jobId },
      data: { status: 'importing', totalRows },
    });

    /* ─── Phase 2: streaming import in chunks ──────────────────────────── */
    await streamImport({
      jobId, filePath, mapping, listId, clientId, agencyId,
    });

    await prisma.importJob.update({
      where: { id: jobId },
      data: { status: 'done', completedAt: new Date() },
    });
  } catch (err) {
    console.error(`[import ${jobId}] processing error:`, err);
    await prisma.importJob.update({
      where: { id: jobId },
      data: {
        status:         'failed',
        rejectedReason: 'parse_error',
        errors:         [{ row: 0, reason: err instanceof Error ? err.message : String(err) }],
        completedAt:    new Date(),
      },
    }).catch(() => {});
  } finally {
    await unlink(filePath).catch(() => {});
  }
}

/* Pre-pass over the file: counts total rows + collects role-account sample. */
async function scanFile(
  filePath: string,
  mapping: ColumnMapping,
): Promise<{ totalRows: number; sampleEmails: string[]; headerIssues: RowError[] }> {
  return new Promise((resolve, reject) => {
    let totalRows = 0;
    const sampleEmails: string[] = [];
    const headerIssues: RowError[] = [];
    let headersSeen: string[] | null = null;

    // Find which CSV header maps to 'email'
    const emailHeader = Object.entries(mapping).find(([, t]) => t === 'email')?.[0];

    Papa.parse(createReadStream(filePath, { encoding: 'utf-8' }), {
      header: true,
      skipEmptyLines: 'greedy',
      step: (results, parser) => {
        if (!headersSeen && results.meta.fields) {
          headersSeen = results.meta.fields;
          if (!emailHeader || !headersSeen.includes(emailHeader)) {
            headerIssues.push({
              row: 0,
              reason: `CSV is missing the column you mapped to Email${emailHeader ? ` ("${emailHeader}")` : ''}.`,
            });
            parser.abort();
            return;
          }
        }
        totalRows++;
        if (sampleEmails.length < SAMPLE_SIZE_FOR_QUALITY) {
          const row = results.data as Record<string, string>;
          const e = (row[emailHeader!] ?? '').trim();
          if (e) sampleEmails.push(e);
        }
      },
      complete: () => resolve({ totalRows, sampleEmails, headerIssues }),
      error: (err) => reject(err),
    });
  });
}

interface StreamCtx {
  jobId: string;
  filePath: string;
  mapping: ColumnMapping;
  listId: string | null;
  clientId: string;
  agencyId: string;
}

async function streamImport(ctx: StreamCtx): Promise<void> {
  const emailHeader = Object.entries(ctx.mapping).find(([, t]) => t === 'email')?.[0];
  if (!emailHeader) throw new Error('email column missing');

  // Helpers for reading values from a row using the mapping
  function readField(row: Record<string, string>, field: StandardField): string | null {
    const csvCol = Object.entries(ctx.mapping).find(([, t]) => t === field)?.[0];
    if (!csvCol) return null;
    const v = (row[csvCol] ?? '').trim();
    return v ? v : null;
  }
  function readCustomFields(row: Record<string, string>): Record<string, string> | null {
    const out: Record<string, string> = {};
    let n = 0;
    for (const [csvCol, target] of Object.entries(ctx.mapping)) {
      if (typeof target === 'string' && target.startsWith('custom:')) {
        const key = target.slice('custom:'.length);
        const v = (row[csvCol] ?? '').trim();
        if (key && v) { out[key] = v; n++; }
      }
    }
    return n > 0 ? out : null;
  }

  const seenInBatch = new Set<string>();
  const errors: RowError[] = [];
  let buffer: Array<{
    email: string; emailLower: string;
    firstName: string | null; lastName: string | null;
    phone: string | null; city: string | null;
    birthday: Date | null; custom: Prisma.InputJsonValue | null;
  }> = [];
  let imported = 0;
  let skipped  = 0;
  let rejected = 0;
  let processed = 0;
  let lastProgressTick = Date.now();

  async function flushChunk(): Promise<void> {
    if (buffer.length === 0) return;
    const chunk = buffer;
    buffer = [];

    // Insert contacts (skip duplicates against unique (client_id, email_lower))
    const inserted = await prisma.contact.createMany({
      data: chunk.map((r) => ({
        agencyId:   ctx.agencyId,
        clientId:   ctx.clientId,
        email:      r.email,
        emailLower: r.emailLower,
        firstName:  r.firstName,
        lastName:   r.lastName,
        phone:      r.phone,
        city:       r.city,
        birthday:   r.birthday,
        custom:     r.custom ?? undefined,
        source:     'csv_import',
      })),
      skipDuplicates: true,
    });
    imported += inserted.count;
    skipped  += chunk.length - inserted.count;

    // Membership if listId set — need contact ids, query back by emailLower
    if (ctx.listId && inserted.count > 0) {
      const emails = chunk.map((r) => r.emailLower);
      const rows = await prisma.contact.findMany({
        where: { clientId: ctx.clientId, emailLower: { in: emails }, deletedAt: null },
        select: { id: true, emailLower: true },
      });
      if (rows.length > 0) {
        await prisma.listContact.createMany({
          data: rows.map((r) => ({ listId: ctx.listId!, contactId: r.id })),
          skipDuplicates: true,
        });
      }
    }
  }

  await new Promise<void>((resolve, reject) => {
    Papa.parse(createReadStream(ctx.filePath, { encoding: 'utf-8' }), {
      header: true,
      skipEmptyLines: 'greedy',
      step: (results, parser) => {
        processed++;
        const row = results.data as Record<string, string>;
        const rawEmail = (row[emailHeader] ?? '').trim();

        // Validate email
        if (!rawEmail) {
          rejected++;
          if (errors.length < MAX_ERRORS) errors.push({ row: processed, reason: 'empty email' });
          return;
        }
        const emailLower = rawEmail.toLowerCase();
        if (!emailLower.includes('@') || emailLower.length < 5 || emailLower.length > 254) {
          rejected++;
          if (errors.length < MAX_ERRORS) errors.push({ row: processed, email: rawEmail, reason: 'invalid format' });
          return;
        }

        // Dedupe within the batch
        if (seenInBatch.has(emailLower)) {
          skipped++;
          return;
        }
        seenInBatch.add(emailLower);

        // Birthday parse — optional
        const bdayRaw = readField(row, 'birthday');
        let birthday: Date | null = null;
        if (bdayRaw) {
          if (/^\d{4}-\d{2}-\d{2}$/.test(bdayRaw)) {
            birthday = new Date(`${bdayRaw}T00:00:00Z`);
            if (Number.isNaN(birthday.getTime())) birthday = null;
          }
        }

        buffer.push({
          email:      rawEmail,
          emailLower,
          firstName:  readField(row, 'firstName'),
          lastName:   readField(row, 'lastName'),
          phone:      readField(row, 'phone'),
          city:       readField(row, 'city'),
          birthday,
          custom:     readCustomFields(row) as Prisma.InputJsonValue | null,
        });

        if (buffer.length >= BATCH_SIZE) {
          parser.pause();
          flushChunk()
            .then(async () => {
              // Update progress at most once per second (avoid hammering the DB)
              const now = Date.now();
              if (now - lastProgressTick > 1000) {
                lastProgressTick = now;
                await prisma.importJob.update({
                  where: { id: ctx.jobId },
                  data: {
                    processedRows: processed,
                    importedRows:  imported,
                    skippedRows:   skipped,
                    rejectedRows:  rejected,
                  },
                });
              }
              parser.resume();
            })
            .catch((err) => {
              parser.abort();
              reject(err);
            });
        }
      },
      complete: () => {
        flushChunk()
          .then(() => prisma.importJob.update({
            where: { id: ctx.jobId },
            data: {
              processedRows: processed,
              importedRows:  imported,
              skippedRows:   skipped,
              rejectedRows:  rejected,
              errors:        errors.length > 0 ? (errors as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
            },
          }))
          .then(() => resolve())
          .catch(reject);
      },
      error: (err) => reject(err),
    });
  });
}
