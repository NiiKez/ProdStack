// Runs before any test file is imported. We populate env vars here because
// `env.ts` validates `process.env` at module load and `process.exit(1)`s on
// missing required vars — and ESM imports inside test files are hoisted above
// any top-level statements.

process.env.NODE_ENV ??= 'test';
process.env.WEB_ORIGIN ??= 'http://localhost:5173';
process.env.PUBLIC_API_URL ??= 'http://localhost:3000';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.JWT_SECRET ??= 'test-jwt-secret-test-jwt-secret-test-jwt-secret';
process.env.COOKIE_SECRET ??= 'test-cookie-secret-test-cookie-secret-test-cookie';
process.env.DATA_ENC_KEY ??= Buffer.alloc(32, 9).toString('base64');
process.env.GITHUB_OAUTH_CLIENT_ID ??= 'test-client-id';
process.env.GITHUB_OAUTH_CLIENT_SECRET ??= 'test-client-secret';
process.env.GITHUB_OAUTH_CALLBACK_URL ??= 'http://localhost:3000/api/auth/github/callback';
process.env.AZURE_STUB ??= 'true';
