-- CreateEnum
CREATE TYPE "DomainStatus" AS ENUM ('pending', 'verified', 'failed');

-- CreateEnum
CREATE TYPE "SuppressionReason" AS ENUM ('manual', 'unsubscribe', 'hard_bounce', 'complaint');

-- CreateTable
CREATE TABLE "sending_domains" (
    "id" TEXT NOT NULL,
    "agency_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "resend_id" TEXT,
    "status" "DomainStatus" NOT NULL DEFAULT 'pending',
    "records" JSONB NOT NULL,
    "verified_at" TIMESTAMP(3),
    "last_checked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sending_domains_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppressions" (
    "id" TEXT NOT NULL,
    "agency_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "reason" "SuppressionReason" NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "suppressions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sending_domains_resend_id_key" ON "sending_domains"("resend_id");

-- CreateIndex
CREATE INDEX "sending_domains_agency_id_status_idx" ON "sending_domains"("agency_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "sending_domains_agency_id_name_key" ON "sending_domains"("agency_id", "name");

-- CreateIndex
CREATE INDEX "suppressions_agency_id_idx" ON "suppressions"("agency_id");

-- CreateIndex
CREATE UNIQUE INDEX "suppressions_agency_id_email_key" ON "suppressions"("agency_id", "email");

-- AddForeignKey
ALTER TABLE "sending_domains" ADD CONSTRAINT "sending_domains_agency_id_fkey" FOREIGN KEY ("agency_id") REFERENCES "agencies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suppressions" ADD CONSTRAINT "suppressions_agency_id_fkey" FOREIGN KEY ("agency_id") REFERENCES "agencies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
