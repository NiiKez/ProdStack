-- Stop / Resume projects.
--
-- A project is ACTIVE (default) or STOPPED. When STOPPED, the owner has paused
-- the deployed Azure Container App (stopped via the SDK beginStop → 0 replicas,
-- does not wake on traffic, $0 compute). A STOPPED project ignores GitHub push
-- webhooks (no build queued) and rejects manual rebuilds until it is resumed.
-- `stoppedAt` records when it was paused (NULL while ACTIVE).
--
-- Additive + backfill-safe: the new enum column defaults to 'ACTIVE', so every
-- existing row becomes ACTIVE with no data migration. Applied in prod via
-- `prisma migrate deploy` on API boot (committed SQL only, no introspection).

-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('ACTIVE', 'STOPPED');

-- AlterTable
ALTER TABLE "Project" ADD COLUMN "status" "ProjectStatus" NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE "Project" ADD COLUMN "stoppedAt" TIMESTAMP(3);
