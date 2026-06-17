/**
 * One-off backfill: add the `pull_request` event to EXISTING projects' GitHub
 * webhooks so preview / PR environments work for projects created before the
 * feature shipped. New projects already register both `push` + `pull_request`
 * (services/github.ts createRepoWebhook). This PATCHes each existing hook's
 * event list in place — the hook id + secret are preserved (no delete/recreate).
 *
 * Idempotent: re-running just re-asserts the same event set. Safe to run before
 * flipping ENABLE_PREVIEWS=true — subscribing to `pull_request` is inert until
 * the feature switch + per-project toggle are on (the webhook receiver
 * acknowledges and ignores PR deliveries while previews are off).
 *
 * Requires the API's environment (DATABASE_URL, DATA_ENC_KEY, GitHub creds).
 * Run from the repo root:
 *   DRY_RUN=1 npx tsx backend/scripts/backfill-pr-webhooks.ts   # preview
 *   npx tsx backend/scripts/backfill-pr-webhooks.ts             # apply
 */
import { PrismaClient } from '@prisma/client';

import { decrypt } from '../src/lib/crypto.js';
import {
  getRepoWebhookEvents,
  GithubWebhookError,
  octokitForUser,
  PRODSTACK_WEBHOOK_EVENTS,
  updateRepoWebhookEvents,
} from '../src/services/github.js';

const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const prisma = new PrismaClient();

async function main(): Promise<void> {
  const projects = await prisma.project.findMany({
    where: { deletedAt: null, webhookId: { not: null }, user: { isDemo: false } },
    include: { user: true },
  });

  console.log(
    `[backfill] ${projects.length} live project(s) with a webhook${DRY_RUN ? ' (DRY RUN)' : ''}`,
  );

  let ok = 0;
  let skipped = 0;
  let failed = 0;
  for (const project of projects) {
    const [owner, repo] = project.githubRepoFullName.split('/');
    if (owner === undefined || repo === undefined || project.webhookId === null) {
      console.warn(`[backfill] skip ${project.githubRepoFullName}: unparseable repo / no hook id`);
      continue;
    }
    const hookId = project.webhookId;
    const label = `${project.githubRepoFullName} (hook ${hookId})`;
    try {
      const token = decrypt({
        ciphertext: project.user.githubTokenCiphertext,
        iv: project.user.githubTokenIv,
        authTag: project.user.githubTokenAuthTag,
        keyVersion: project.user.githubTokenKeyVersion,
      });
      const octokit = octokitForUser(token);

      // Read-then-merge: the PATCH is REPLACE-semantics (see github.ts), so union
      // the hook's current events with ours rather than overwriting — that way a
      // hook with an extra manually-added event keeps it. Skip the write entirely
      // when nothing is missing, making a re-run a true no-op.
      const current = await getRepoWebhookEvents(octokit, { owner, repo, hookId });
      const missing = PRODSTACK_WEBHOOK_EVENTS.filter((e) => !current.includes(e));
      if (missing.length === 0) {
        console.log(`[backfill] = ${label} already has ${PRODSTACK_WEBHOOK_EVENTS.join(',')} — skipping`);
        skipped += 1;
        continue;
      }
      const desired = Array.from(new Set([...current, ...PRODSTACK_WEBHOOK_EVENTS]));
      if (DRY_RUN) {
        console.log(`[backfill] would add ${missing.join(',')} → events become ${desired.join(',')} on ${label}`);
        ok += 1;
        continue;
      }
      await updateRepoWebhookEvents(octokit, { owner, repo, hookId, events: desired });
      console.log(`[backfill] ✓ ${label} → ${desired.join(',')}`);
      ok += 1;
    } catch (err) {
      failed += 1;
      const detail =
        err instanceof GithubWebhookError ? `${err.status ?? '?'} ${err.githubMessage ?? err.message}` : String(err);
      console.error(`[backfill] ✗ ${label}: ${detail}`);
    }
  }

  console.log(`[backfill] done — ${ok} updated, ${skipped} already-current, ${failed} failed`);
  // Surface partial failure to the caller (CI / operator) — main() returning
  // normally would otherwise exit 0 even when some hooks 404'd / hit a bad token.
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error('[backfill] fatal', err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
