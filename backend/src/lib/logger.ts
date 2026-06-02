import { pino, stdSerializers, type Logger } from 'pino';

import { env, isProd } from '../env.js';

/**
 * Error serializer that strips the failed HTTP request/response off logged
 * errors before they hit any sink.
 *
 * Why this matters: an Azure SDK `RestError` (and axios-style errors) hang the
 * originating request on `err.request` / `err.config`. Our Container App PUT
 * body embeds **decrypted env-var values** in `configuration.secrets[].value`
 * (see `containerApps.ts` → `realUpdate`). If such an error were logged raw —
 * e.g. by the unhandled-error middleware (`errors.ts`) on a failed rollback, or
 * by the build runner / env-var-save redeploy on a failed `updateContainerApp`
 * — those plaintext secrets would spill into Log Analytics. Keeping
 * `message`/`code`/`statusCode`/`stack` (the std serializer's output) is plenty
 * for debugging; the request/response bodies are the only leak vector and we
 * don't need them in logs.
 *
 * Note on the real Azure `RestError`: the SDK marks `request`/`response` as
 * *non-enumerable*, so pino's `stdSerializers.err` never copies them in the
 * first place — for that error shape the SDK's own non-enumerability (plus its
 * `util.inspect` sanitizer that drops the body) is the primary defense. These
 * deletes are the belt-and-suspenders that catch enumerable-own-property shapes
 * (axios `config`/`request`, hand-rolled errors) the std serializer *would*
 * copy. Pino flattens a nested `.cause` only into the `stack` string, so a
 * secret on `cause.request.body` is never serialized as structured data either.
 */
export function safeErrSerializer(err: Error): Record<string, unknown> {
  const serialized = stdSerializers.err(err) as Record<string, unknown>;
  delete serialized.request;
  delete serialized.response;
  delete serialized.config;
  return serialized;
}

/**
 * Auth material that pino-http would otherwise log per request (it serializes
 * the full request/response headers at `info` by default). `x-deploy-token` is
 * the M6 CI/CD self-deploy credential (POST /api/admin/deploy) — without this
 * the plaintext deploy token (and every brute-force *guess*) would land in Log
 * Analytics, where a wider audience than the Key Vault secret could recover it.
 * Header names are lower-cased by Node, so the lookup key is `x-deploy-token`.
 * `x-admin-token` is the M6 cost-safeguard cleanup credential (POST
 * /api/admin/cleanup/*) — same reasoning, kept out of Log Analytics.
 * `proxy-authorization` (would-be upstream proxy creds) and `x-hub-signature-256`
 * (the GitHub webhook HMAC — not strictly secret since it's per-payload, but
 * needless to log) are belt-and-suspenders for any future inbound auth header.
 * Exported so logger.test.ts guards this exact list against regressions.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers["proxy-authorization"]',
  'req.headers.cookie',
  'req.headers["x-deploy-token"]',
  'req.headers["x-admin-token"]',
  'req.headers["x-hub-signature-256"]',
  'res.headers["set-cookie"]',
];

export const logger: Logger = pino({
  level: env.LOG_LEVEL,
  serializers: { err: safeErrSerializer },
  // Belt-and-suspenders alongside the err serializer.
  redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  ...(isProd ? {} : { transport: { target: 'pino-pretty' } }),
});
