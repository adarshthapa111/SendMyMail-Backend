import argon2 from 'argon2';

/* Password hashing — argon2id (OWASP-recommended).
   Memory cost 64 MiB, 3 iterations, 1 parallel lane.
   These params target ~100 ms hash time on modern hardware. */
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65_536, // 64 MiB
  timeCost: 3,
  parallelism: 1,
} as const;

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, ARGON2_OPTIONS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

/* Strength check — V1 minimum: 8 chars, ≥ 1 number, ≥ 1 symbol.
   Surface specific errors so the frontend can show inline helper text. */
export function validatePasswordStrength(plain: string): { ok: true } | { ok: false; reason: string } {
  if (plain.length < 8) return { ok: false, reason: 'Password must be at least 8 characters.' };
  if (!/[0-9]/.test(plain)) return { ok: false, reason: 'Password must include at least one number.' };
  if (!/[^A-Za-z0-9]/.test(plain)) return { ok: false, reason: 'Password must include at least one symbol.' };
  return { ok: true };
}
