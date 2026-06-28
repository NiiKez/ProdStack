/**
 * Security / audit event trail (write side).
 *
 * App-level security events — login success, owner-gate denials, env-var
 * changes, webhook signature failures — used to be ephemeral Container App
 * stdout: gone the moment the revision rolled and the logs aged out, so there
 * was no persistent, queryable record of who did what. `recordSecurityEvent`
 * persists each event as an append-only `SecurityEvent` row (read back via the
 * owner-gated `GET /api/activity/security-events` endpoint) AND keeps emitting a
 * structured pino line, so the trail survives in both places.
 *
 * Best-effort by contract: the Prisma write is wrapped in try/catch and a
 * failure is logged (`logger.error`) but NEVER rethrown — an audit-write failure
 * must not break the request flow it is auditing (a login should still succeed
 * even if the audit row can't be written).
 *
 * `metadata` is keys-only structured context (changed env-var KEY names, a
 * created-vs-updated flag, ...). Callers must NEVER pass secrets, env-var values,
 * OAuth tokens, or OAuth codes into it.
 */
import { Prisma } from '@prisma/client';

import { prisma } from '../db.js';
import { logger } from '../lib/logger.js';

export type SecurityOutcome = 'allowed' | 'denied' | 'success' | 'failure';

export interface SecurityEventInput {
  /** Dotted action key, e.g. `auth.login`, `auth.denied_not_owner`, `env.updated`. */
  action: string;
  outcome: SecurityOutcome;
  /** GitHub user id of the actor (the rejected login on a denial, the owner on success). */
  actorGithubId?: number | null;
  actorLogin?: string | null;
  /** Owning User row id, when the event maps to one. */
  userId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  ip?: string | null;
  /** Keys-only structured context — NEVER secrets/values/tokens/codes. */
  metadata?: Record<string, unknown> | null;
}

/**
 * Persist a security event (best-effort) and emit a structured log line.
 *
 * Resolves whether or not the DB write succeeds — it can never throw, so it is
 * safe to `await` it directly inside a request handler without an extra guard.
 */
export async function recordSecurityEvent(input: SecurityEventInput): Promise<void> {
  // Always emit the structured pino line first, independent of the DB write, so
  // the event is visible in Container App logs even if Postgres is unreachable.
  logger.info(
    {
      action: input.action,
      outcome: input.outcome,
      actorGithubId: input.actorGithubId ?? undefined,
      actorLogin: input.actorLogin ?? undefined,
      userId: input.userId ?? undefined,
      targetType: input.targetType ?? undefined,
      targetId: input.targetId ?? undefined,
      ip: input.ip ?? undefined,
      metadata: input.metadata ?? undefined,
    },
    `security event: ${input.action}`,
  );

  try {
    await prisma.securityEvent.create({
      data: {
        action: input.action,
        outcome: input.outcome,
        actorGithubId: input.actorGithubId ?? null,
        actorLogin: input.actorLogin ?? null,
        userId: input.userId ?? null,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        ip: input.ip ?? null,
        metadata:
          input.metadata === undefined || input.metadata === null
            ? Prisma.JsonNull
            : (input.metadata as Prisma.InputJsonValue),
      },
    });
  } catch (err) {
    // Append-only audit must never break the request flow it audits. Log and move on.
    logger.error({ err, action: input.action }, 'failed to persist security event');
  }
}
