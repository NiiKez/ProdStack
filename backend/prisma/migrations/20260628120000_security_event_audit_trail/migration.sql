-- Security / audit event trail + a covering index for the log-pruning cleanup.
--
-- Additive only — safe to apply with `prisma migrate deploy` on API boot (the
-- prod path; never `migrate dev` against prod, which would drop the
-- hand-maintained partial unique indexes `project_user_slug_live` /
-- `one_active_per_project` / `preview_project_pr_open` / `project_repo_live_real`
-- that live in raw-SQL migrations and aren't expressed in schema.prisma).
--
-- 1. `SecurityEvent` is a brand-new, append-only table: app-level security
--    events (login success, owner-gate denials, env-var changes, webhook
--    signature failures, ...) used to be Container App stdout only — gone once
--    the revision rolled. They are now persisted as queryable rows, written
--    best-effort (a failed insert is logged + swallowed, never breaks the
--    request) and read back via the owner-gated GET /api/activity/security-events.
--    `userId` is nullable with ON DELETE SET NULL so the audit row OUTLIVES the
--    user it references (and a denial can carry a non-owner, no-User actor).
-- 2. `LogLine_ts_idx` backs the cleanup job's age query (delete LogLine rows
--    older than RETENTION_DAYS_LOGS) so it no longer full-scans the table.

-- CreateTable
CREATE TABLE "SecurityEvent" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "action" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "actorGithubId" INTEGER,
    "actorLogin" TEXT,
    "userId" TEXT,
    "targetType" TEXT,
    "targetId" TEXT,
    "ip" TEXT,
    "metadata" JSONB,

    CONSTRAINT "SecurityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SecurityEvent_createdAt_idx" ON "SecurityEvent"("createdAt");

-- CreateIndex
CREATE INDEX "SecurityEvent_action_idx" ON "SecurityEvent"("action");

-- CreateIndex
CREATE INDEX "LogLine_ts_idx" ON "LogLine"("ts");

-- AddForeignKey
ALTER TABLE "SecurityEvent" ADD CONSTRAINT "SecurityEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
