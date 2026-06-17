-- Preview / PR environments.
--
-- Each open pull request on a project's repo (when previews are enabled and the
-- PR author is trusted) gets its own ephemeral Azure Container App, built and
-- deployed through the same Kaniko pipeline as the main app but targeting a
-- per-PR app name. See docs/PREVIEW_ENVIRONMENTS.md.
--
-- Additive + backfill-safe:
--   * `PreviewEnvironment` is a brand-new table.
--   * `Build.previewId` is nullable (NULL = normal main-branch build) with an
--     ON DELETE SET NULL FK so build history survives a preview teardown.
--   * `Project.previewsEnabled` defaults to true, so every existing row becomes
--     preview-enabled with no data migration (the global ENABLE_PREVIEWS master
--     switch still gates the feature off until explicitly turned on).
-- Applied in prod via `prisma migrate deploy` on API boot (committed SQL only,
-- no introspection) — do NOT `prisma migrate dev` against prod.

-- CreateEnum
CREATE TYPE "PreviewStatus" AS ENUM ('PENDING', 'ACTIVE', 'FAILED', 'TORN_DOWN');

-- AlterTable
ALTER TABLE "Build" ADD COLUMN     "previewId" TEXT;

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "previewsEnabled" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "PreviewEnvironment" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "prNumber" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "headRef" TEXT NOT NULL,
    "headSha" TEXT NOT NULL,
    "authorLogin" TEXT NOT NULL,
    "status" "PreviewStatus" NOT NULL DEFAULT 'PENDING',
    "containerAppName" TEXT NOT NULL,
    "liveUrl" TEXT,
    "revisionName" TEXT,
    "lastBuildId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PreviewEnvironment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PreviewEnvironment_projectId_createdAt_idx" ON "PreviewEnvironment"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "PreviewEnvironment_status_expiresAt_idx" ON "PreviewEnvironment"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "Build_previewId_idx" ON "Build"("previewId");

-- AddForeignKey
ALTER TABLE "Build" ADD CONSTRAINT "Build_previewId_fkey" FOREIGN KEY ("previewId") REFERENCES "PreviewEnvironment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PreviewEnvironment" ADD CONSTRAINT "PreviewEnvironment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Partial unique index: one OPEN preview per (project, PR number). A PR number
-- becomes reusable once its preview is torn down (closedAt set). Prisma can't
-- express a WHERE-filtered unique in the schema, so it lives here (mirrors
-- project_user_slug_live / one_active_per_project). See schema.prisma note on
-- PreviewEnvironment.
CREATE UNIQUE INDEX "preview_project_pr_open" ON "PreviewEnvironment"("projectId", "prNumber") WHERE "closedAt" IS NULL;
