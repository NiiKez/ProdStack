-- DropIndex
DROP INDEX "Build_status_idx";

-- AlterTable
ALTER TABLE "Build" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "claimedAt" TIMESTAMP(3),
ADD COLUMN     "claimedBy" TEXT;

-- CreateIndex
CREATE INDEX "Build_status_claimedAt_createdAt_idx" ON "Build"("status", "claimedAt", "createdAt");
