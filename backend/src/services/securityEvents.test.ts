process.env.NODE_ENV = 'test';
process.env.WEB_ORIGIN = 'http://localhost:5173';
process.env.PUBLIC_API_URL = 'http://localhost:3000';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.JWT_SECRET = 'test-jwt-secret-test-jwt-secret-test-jwt-secret';
process.env.COOKIE_SECRET = 'test-cookie-secret-test-cookie-secret-test-cookie';
process.env.DATA_ENC_KEY = Buffer.alloc(32, 9).toString('base64');
process.env.GITHUB_OAUTH_CLIENT_ID = 'test-client-id';
process.env.GITHUB_OAUTH_CLIENT_SECRET = 'test-client-secret';
process.env.GITHUB_OAUTH_CALLBACK_URL = 'http://localhost:3000/api/auth/github/callback';
process.env.AZURE_STUB = 'true';
process.env.LOG_LEVEL = 'silent';

import { Prisma } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock('../db.js', () => ({
  prisma: { securityEvent: { create: mocks.create } },
}));

import { logger } from '../lib/logger.js';
import { recordSecurityEvent } from './securityEvents.js';

beforeEach(() => {
  mocks.create.mockReset();
  mocks.create.mockResolvedValue({ id: 'ev1' });
});

afterEach(() => vi.restoreAllMocks());

describe('recordSecurityEvent', () => {
  it('persists a row mapping every field through to prisma', async () => {
    await recordSecurityEvent({
      action: 'auth.login',
      outcome: 'success',
      actorGithubId: 42,
      actorLogin: 'octocat',
      userId: 'u1',
      targetType: 'project',
      targetId: 'p1',
      ip: '203.0.113.7',
      metadata: { created: true },
    });

    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create.mock.calls[0]![0]!.data).toEqual({
      action: 'auth.login',
      outcome: 'success',
      actorGithubId: 42,
      actorLogin: 'octocat',
      userId: 'u1',
      targetType: 'project',
      targetId: 'p1',
      ip: '203.0.113.7',
      metadata: { created: true },
    });
  });

  it('defaults optional fields to null and uses Prisma.JsonNull when metadata is absent', async () => {
    await recordSecurityEvent({ action: 'auth.denied_not_owner', outcome: 'denied' });

    const data = mocks.create.mock.calls[0]![0]!.data;
    expect(data).toMatchObject({
      action: 'auth.denied_not_owner',
      outcome: 'denied',
      actorGithubId: null,
      actorLogin: null,
      userId: null,
      targetType: null,
      targetId: null,
      ip: null,
    });
    expect(data.metadata).toBe(Prisma.JsonNull);
  });

  it('swallows a DB write failure — never throws — and logs the error', async () => {
    const errSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    mocks.create.mockRejectedValue(new Error('db unreachable'));

    // Best-effort contract: an audit-write failure must not break the caller.
    await expect(
      recordSecurityEvent({ action: 'auth.login', outcome: 'success', userId: 'u1' }),
    ).resolves.toBeUndefined();

    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0]![1]).toBe('failed to persist security event');
  });
});
