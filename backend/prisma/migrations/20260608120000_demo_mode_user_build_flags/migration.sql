-- Demo mode (docs/DEMO_MODE.md). Additive only — safe to apply with
-- `prisma migrate deploy` on API boot (the prod path; never `migrate dev`
-- against prod, which would drop the hand-maintained partial unique indexes
-- `project_user_slug_live` / `one_active_per_project`).
--
-- Each public demo session is its own ephemeral User row (isDemo=true,
-- demoExpiresAt set). The hourly reaper cascade-deletes expired demo users.
-- Build.isDemo is denormalized from the owning user so the worker's hot
-- claim/recovery queries can exclude demo builds without a join.

-- User: demo-session flags + reaper index.
ALTER TABLE "User" ADD COLUMN "isDemo" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "demoExpiresAt" TIMESTAMP(3);

CREATE INDEX "User_isDemo_demoExpiresAt_idx" ON "User"("isDemo", "demoExpiresAt");

-- Build: denormalized demo flag (hot-path exclusion in the worker claim query).
ALTER TABLE "Build" ADD COLUMN "isDemo" BOOLEAN NOT NULL DEFAULT false;
