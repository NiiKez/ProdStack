import type { NextFunction, Request, Response } from 'express';

/**
 * CSRF gate: every state-changing request must carry
 * `X-Requested-With: XMLHttpRequest`. Browsers refuse to send custom headers
 * on simple cross-origin form submissions, so requiring this header turns
 * away classic CSRF (image tag, hidden form) attacks without a token round-trip.
 *
 * Safe methods (GET/HEAD/OPTIONS) skip the check.
 */
export function requireXRequestedWith(req: Request, res: Response, next: NextFunction): void {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    next();
    return;
  }

  if (req.header('x-requested-with') !== 'XMLHttpRequest') {
    res.status(403).json({
      error: 'CSRF',
      message: 'Missing X-Requested-With header',
    });
    return;
  }

  next();
}
