-- CreateTable
CREATE TABLE "templates" (
    "id" TEXT NOT NULL,
    "agency_id" TEXT NOT NULL,
    "client_id" TEXT,
    "name" TEXT NOT NULL,
    "mjml_source" JSONB NOT NULL,
    "thumbnail_url" TEXT,
    "category" TEXT,
    "is_starter" BOOLEAN NOT NULL DEFAULT false,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "templates_agency_id_idx" ON "templates"("agency_id");

-- CreateIndex
CREATE INDEX "templates_client_id_archived_updated_at_idx" ON "templates"("client_id", "archived", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "templates_agency_id_is_starter_idx" ON "templates"("agency_id", "is_starter");

-- AddForeignKey
ALTER TABLE "templates" ADD CONSTRAINT "templates_agency_id_fkey" FOREIGN KEY ("agency_id") REFERENCES "agencies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "templates" ADD CONSTRAINT "templates_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "templates" ADD CONSTRAINT "templates_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
