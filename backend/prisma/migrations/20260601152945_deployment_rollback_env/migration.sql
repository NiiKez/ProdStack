-- DropIndex
DROP INDEX "Deployment_buildId_key";

-- AlterTable
ALTER TABLE "Deployment" ADD COLUMN     "rolledBack" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Deployment_buildId_idx" ON "Deployment"("buildId");
