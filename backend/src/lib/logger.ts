import { pino, type Logger } from 'pino';

import { env, isProd } from '../env.js';

export const logger: Logger = pino({
  level: env.LOG_LEVEL,
  ...(isProd ? {} : { transport: { target: 'pino-pretty' } }),
});
