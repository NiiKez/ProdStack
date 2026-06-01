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

import { describe, expect, it } from 'vitest';

import { safeErrSerializer } from './logger.js';

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
