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
 */
export function safeErrSerializer(err: Error): Record<string, unknown> {
  const serialized = stdSerializers.err(err) as Record<string, unknown>;
  delete serialized.request;
  delete serialized.response;
  delete serialized.config;
  return serialized;
}

export const logger: Logger = pino({
  level: env.LOG_LEVEL,
  serializers: { err: safeErrSerializer },
  // Belt-and-suspenders alongside the err serializer: scrub auth material that
  // pino-http would otherwise log per request.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
    ],
    censor: '[REDACTED]',
  },
  ...(isProd ? {} : { transport: { target: 'pino-pretty' } }),
});
