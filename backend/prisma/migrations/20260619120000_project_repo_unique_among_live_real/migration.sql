-- Make inbound GitHub-webhook routing deterministic + constrained.
--
-- Additive only — safe to apply with `prisma migrate deploy` on API boot (the
-- prod path; never `migrate dev` against prod, which would drop the
-- hand-maintained partial unique indexes `project_user_slug_live` /
-- `one_active_per_project` / `preview_project_pr_open`).
--
-- Before: the webhook handler resolves a delivery to its project by
-- `githubRepoId` (then verifies the HMAC against THAT project's secret), but
-- nothing guaranteed only one live non-demo project backs a given repo. If two
-- ever did, the lookup was non-deterministic -> the HMAC could be checked
-- against the wrong project's secret (dropped deploys, 401) or a build/preview
-- queued under the WRONG owner (cross-tenant). A Postgres partial unique index
-- can only reference the table's own columns, and "non-demo" lives on
-- User.isDemo, so denormalize isDemo onto Project (mirrors Build.isDemo) and add
-- a partial unique index over live, real (non-demo) rows.
--
-- Demo rows are EXCLUDED from the constraint: demo sessions reuse synthetic /
-- fixture repo ids (multiple demo projects can share one), and demo deliveries
-- are already filtered out of the webhook lookup, so they need no uniqueness.

-- Project: denormalized demo flag (so the partial unique index can filter on it
-- without joining to User).
ALTER TABLE "Project" ADD COLUMN "isDemo" BOOLEAN NOT NULL DEFAULT false;

-- Backfill from the owning user (new rows set it explicitly on create).
UPDATE "Project" p SET "isDemo" = u."isDemo" FROM "User" u WHERE p."userId" = u."id";

-- Self-heal any pre-existing duplicates so the unique index below can be built.
-- Nothing enforced repo-uniqueness before this migration, so a prod DB could
-- already hold two live non-demo projects on one repo. Building the index over
-- such data raises a duplicate-key error that ABORTS the whole migration inside
-- `migrate deploy` on boot — and Prisma then records it failed, so every later
-- deploy fails with P3009 until someone runs `migrate resolve` against the
-- firewalled DB. Avoid that: keep the OLDEST row per repo (exactly the one the
-- webhook handler's `orderBy: createdAt asc, id asc` already routes to) and
-- soft-delete the rest. A no-op on a clean DB (the expected case).
WITH ranked AS (
  SELECT "id",
         row_number() OVER (
           PARTITION BY "githubRepoId"
           ORDER BY "createdAt" ASC, "id" ASC
         ) AS rn
  FROM "Project"
  WHERE "deletedAt" IS NULL AND "isDemo" = false
)
UPDATE "Project" p
SET "deletedAt" = now()
FROM ranked
WHERE p."id" = ranked."id" AND ranked.rn > 1;

-- One live project per GitHub repo among real (non-demo) users -> deterministic
-- webhook routing. Partial so soft-deleted tombstones and demo rows don't
-- participate. Mirrors the hand-maintained `project_user_slug_live` index
-- (migration 20260605200000).
CREATE UNIQUE INDEX "project_repo_live_real"
  ON "Project" ("githubRepoId")
  WHERE "deletedAt" IS NULL AND "isDemo" = false;
