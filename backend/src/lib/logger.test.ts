process.env.NODE_ENV = 'test';
process.env.WEB_ORIGIN = 'http://localhost:5173';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.JWT_SECRET = 'test-jwt-secret-test-jwt-secret-test-jwt-secret';
process.env.COOKIE_SECRET = 'test-cookie-secret-test-cookie-secret-test-cookie';
process.env.DATA_ENC_KEY = Buffer.alloc(32, 9).toString('base64');
process.env.GITHUB_OAUTH_CLIENT_ID = 'cid';
process.env.GITHUB_OAUTH_CLIENT_SECRET = 'csecret';
process.env.GITHUB_OAUTH_CALLBACK_URL = 'http://localhost:3000/api/auth/github/callback';
process.env.AZURE_STUB = 'true';
process.env.LOG_LEVEL = 'silent';

import { pino } from 'pino';
import { describe, expect, it } from 'vitest';

import { REDACT_PATHS, safeErrSerializer } from './logger.js';

describe('REDACT_PATHS', () => {
  it('redacts every auth/credential header so secrets never hit logs', () => {
    for (const path of [
      'req.headers.authorization',
      'req.headers["proxy-authorization"]',
      'req.headers.cookie',
      'req.headers["x-deploy-token"]',
      'req.headers["x-admin-token"]',
      'req.headers["x-hub-signature-256"]',
      'res.headers["set-cookie"]',
    ]) {
      expect(REDACT_PATHS).toContain(path);
    }

    // Build a pino over the real redact config and a capture stream, then log a
    // request-shaped record exactly as pino-http would. Asserts the redaction
    // actually fires (not just that the path string is present).
    const lines: string[] = [];
    const capture = pino(
      { redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } },
      { write: (s: string) => lines.push(s) },
    );
    capture.info({
      req: {
        method: 'POST',
        url: '/api/admin/deploy',
        headers: {
          'x-deploy-token': 'super-secret-deploy-token-1234567890',
          'x-admin-token': 'super-secret-admin-token-0987654321',
          'x-hub-signature-256': 'sha256=leak-hmac',
          authorization: 'Bearer leak-me',
          'proxy-authorization': 'Basic leak-proxy',
          cookie: 'sid=leak-me-too',
        },
      },
    });

    const out = lines.join('');
    expect(out).not.toContain('super-secret-deploy-token-1234567890');
    expect(out).not.toContain('super-secret-admin-token-0987654321');
    expect(out).not.toContain('sha256=leak-hmac');
    expect(out).not.toContain('Bearer leak-me');
    expect(out).not.toContain('Basic leak-proxy');
    expect(out).not.toContain('sid=leak-me-too');
    expect(out).toContain('[REDACTED]');
  });
});

describe('safeErrSerializer', () => {
  it('strips the failed HTTP request/response so plaintext secrets cannot leak', () => {
    // Shape of an Azure SDK RestError: the failed PUT request body embeds the
    // decrypted env-var values in configuration.secrets[].value.
    const err = new Error('Operation returned an invalid status code 400');
    Object.assign(err, {
      code: 'ContainerAppInvalid',
      statusCode: 400,
      request: {
        body: JSON.stringify({
          configuration: { secrets: [{ name: 'env-x', value: 'SUPER_SECRET_VALUE_123' }] },
        }),
        headers: { authorization: 'Bearer ey.token.here' },
      },
      response: { bodyAsText: 'noise' },
      config: { data: 'SUPER_SECRET_VALUE_123' },
    });

    const out = safeErrSerializer(err);
    const serialized = JSON.stringify(out);

    expect(serialized).not.toContain('SUPER_SECRET_VALUE_123');
    expect(serialized).not.toContain('Bearer');
    expect(out).not.toHaveProperty('request');
    expect(out).not.toHaveProperty('response');
    expect(out).not.toHaveProperty('config');

    // …while keeping what's actually useful for debugging.
    expect(out.message).toContain('invalid status code 400');
    expect(out.code).toBe('ContainerAppInvalid');
  });
});
