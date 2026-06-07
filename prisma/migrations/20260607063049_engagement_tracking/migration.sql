-- CreateEnum
CREATE TYPE "EmailEventType" AS ENUM ('open', 'click');

-- AlterTable
ALTER TABLE "sends" ADD COLUMN     "click_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "first_opened_at" TIMESTAMP(3),
ADD COLUMN     "last_clicked_at" TIMESTAMP(3),
ADD COLUMN     "open_count" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "email_events" (
    "id" TEXT NOT NULL,
    "send_id" TEXT NOT NULL,
    "type" "EmailEventType" NOT NULL,
    "url" TEXT,
    "recipient_ip" TEXT,
    "user_agent" VARCHAR(500),
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "email_events_send_id_type_idx" ON "email_events"("send_id", "type");

-- CreateIndex
CREATE INDEX "email_events_send_id_occurred_at_idx" ON "email_events"("send_id", "occurred_at" DESC);

-- AddForeignKey
ALTER TABLE "email_events" ADD CONSTRAINT "email_events_send_id_fkey" FOREIGN KEY ("send_id") REFERENCES "sends"("id") ON DELETE CASCADE ON UPDATE CASCADE;
