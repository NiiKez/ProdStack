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

import { EventEmitter } from 'node:events';

import { pino } from 'pino';
import { pinoHttp } from 'pino-http';
import { describe, expect, it } from 'vitest';

import { REDACT_PATHS, safeErrSerializer, safeReqSerializer } from './logger.js';

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

describe('safeReqSerializer', () => {
  const callbackUrl = '/api/auth/github/callback?code=SECRETCODE123&state=SECRETSTATE456';

  it('strips the query string from url and keeps only the param keys', () => {
    // Shape pino-std-serializers' wrapRequestSerializer hands us: the already
    // serialized pino request, where the default Express path puts the full
    // originalUrl on `url` and the parsed query object on `query`.
    const out = safeReqSerializer({
      id: undefined,
      method: 'GET',
      url: callbackUrl,
      headers: {},
      remoteAddress: '127.0.0.1',
      remotePort: 4567,
      params: {},
      query: { code: 'SECRETCODE123', state: 'SECRETSTATE456' },
      // raw is non-enumerable in the real shape; not needed by the serializer.
    } as never);

    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('SECRETCODE123');
    expect(serialized).not.toContain('SECRETSTATE456');
    expect(out.url).toBe('/api/auth/github/callback');
    // The param keys survive (never the values) so "which params were sent"
    // is still diagnosable.
    expect(out.query).toEqual(['code', 'state']);
  });

  it('leaves a query-less path untouched', () => {
    const out = safeReqSerializer({
      id: undefined,
      method: 'GET',
      url: '/api/health',
      headers: {},
      remoteAddress: '127.0.0.1',
      remotePort: 4567,
      params: {},
      query: {},
    } as never);
    expect(out.url).toBe('/api/health');
  });

  it('does not leak OAuth code/state through the real pino-http access log', () => {
    // End-to-end-ish: drive the actual pino-http middleware wired exactly as
    // app.ts does (serializers.req = safeReqSerializer) and assert the captured
    // access-log line never contains the authorization code/state.
    const lines: string[] = [];
    const captureLogger = pino(
      { redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } },
      { write: (s: string) => lines.push(s) },
    );
    const middleware = pinoHttp({
      logger: captureLogger,
      serializers: { req: safeReqSerializer },
    });

    // Minimal Express-like request: originalUrl + parsed query are the two leak
    // vectors the default serializer would copy.
    const req = {
      method: 'GET',
      url: callbackUrl,
      originalUrl: callbackUrl,
      query: { code: 'SECRETCODE123', state: 'SECRETSTATE456' },
      headers: { host: 'prodstack.live' },
      socket: { remoteAddress: '127.0.0.1', remotePort: 4567 },
    } as never;
    const res = Object.assign(new EventEmitter(), {
      statusCode: 302,
      headersSent: true,
      getHeaders: () => ({}),
    }) as never;

    middleware(req, res, () => {});
    (res as unknown as EventEmitter).emit('finish');

    const out = lines.join('');
    expect(out).not.toContain('SECRETCODE123');
    expect(out).not.toContain('SECRETSTATE456');
    // The clean path is still recorded.
    expect(out).toContain('/api/auth/github/callback');
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
