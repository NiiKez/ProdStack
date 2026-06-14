import { Prisma } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';
import { ZodError, type ZodIssue } from 'zod';

import { logger } from './logger.js';

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'HttpError';
  }
}

export interface SerializedIssue {
  path: string;
  message: string;
  code: string;
}

export function serializeZodIssues(error: ZodError): SerializedIssue[] {
  return error.issues.map((issue: ZodIssue) => ({
    path: issue.path.join('.'),
    message: issue.message,
    code: issue.code,
  }));
}

export function errorMiddleware(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: 'VALIDATION_FAILED',
      issues: serializeZodIssues(err),
    });
    return;
  }

  if (err instanceof HttpError) {
    res.status(err.status).json({
      error: err.code,
      ...(err.message && err.message !== err.code ? { message: err.message } : {}),
    });
    return;
  }

  // A unique-constraint violation that reaches here is a genuine conflict (route
  // handlers that expect P2002 catch it themselves). Surface it as a clean 409
  // instead of a generic 500 — e.g. recreating a project whose slug is still
  // held by a live row.
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    res.status(409).json({ error: 'CONFLICT' });
    return;
  }

  // Body-parser size cap (`express.raw`/`express.json` `limit`): an over-limit
  // request is rejected by the parser BEFORE any route handler runs. Surface it
  // as a clean 413 rather than a generic 500 so a too-large body is
  // distinguishable from an internal fault. The webhook body cap (app.ts) leans
  // on this rejection to bound the unauthenticated parse/HMAC work a forged
  // delivery can force. `raw-body` tags the error with `type: 'entity.too.large'`.
  if (
    typeof err === 'object' &&
    err !== null &&
    (err as { type?: unknown }).type === 'entity.too.large'
  ) {
    res.status(413).json({ error: 'PAYLOAD_TOO_LARGE' });
    return;
  }

  logger.error({ err }, 'unhandled error');
  res.status(500).json({ error: 'INTERNAL' });
}
