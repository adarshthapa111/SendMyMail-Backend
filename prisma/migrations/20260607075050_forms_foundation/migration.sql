-- CreateEnum
CREATE TYPE "FormStatus" AS ENUM ('active', 'paused');

-- CreateTable
CREATE TABLE "forms" (
    "id" TEXT NOT NULL,
    "agency_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "list_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "headline" TEXT,
    "subheadline" TEXT,
    "button_text" TEXT NOT NULL DEFAULT 'Subscribe',
    "thank_you_message" TEXT NOT NULL DEFAULT 'Thanks! We''ll be in touch.',
    "collect_first_name" BOOLEAN NOT NULL DEFAULT false,
    "collect_last_name" BOOLEAN NOT NULL DEFAULT false,
    "brand_color" TEXT,
    "require_consent" BOOLEAN NOT NULL DEFAULT false,
    "consent_text" TEXT,
    "status" "FormStatus" NOT NULL DEFAULT 'active',
    "submission_count" INTEGER NOT NULL DEFAULT 0,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "forms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "form_submissions" (
    "id" TEXT NOT NULL,
    "form_id" TEXT NOT NULL,
    "contact_id" TEXT,
    "email" TEXT NOT NULL,
    "first_name" TEXT,
    "last_name" TEXT,
    "submitted_ip" TEXT,
    "user_agent" VARCHAR(500),
    "consent_given" BOOLEAN NOT NULL DEFAULT false,
    "is_new_contact" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "form_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "forms_slug_key" ON "forms"("slug");

-- CreateIndex
CREATE INDEX "forms_agency_id_archived_idx" ON "forms"("agency_id", "archived");

-- CreateIndex
CREATE INDEX "forms_client_id_archived_idx" ON "forms"("client_id", "archived");

-- CreateIndex
CREATE INDEX "form_submissions_form_id_created_at_idx" ON "form_submissions"("form_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "form_submissions_form_id_is_new_contact_idx" ON "form_submissions"("form_id", "is_new_contact");

-- AddForeignKey
ALTER TABLE "forms" ADD CONSTRAINT "forms_agency_id_fkey" FOREIGN KEY ("agency_id") REFERENCES "agencies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forms" ADD CONSTRAINT "forms_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forms" ADD CONSTRAINT "forms_list_id_fkey" FOREIGN KEY ("list_id") REFERENCES "lists"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_form_id_fkey" FOREIGN KEY ("form_id") REFERENCES "forms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
