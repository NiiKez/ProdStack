// Unit tests for the env-var read side. The security-critical guarantee is that
// `loadEnvVarMeta` (the only loader the API surfaces to the client) never
// decrypts a value — env-var values are write-only.
process.env.NODE_ENV = 'test';
process.env.DATA_ENC_KEY ??= Buffer.alloc(32, 9).toString('base64');
process.env.JWT_SECRET ??= 'x'.repeat(40);
process.env.COOKIE_SECRET ??= 'y'.repeat(40);
process.env.WEB_ORIGIN ??= 'http://localhost:5173';
process.env.GITHUB_OAUTH_CLIENT_ID ??= 'cid';
process.env.GITHUB_OAUTH_CLIENT_SECRET ??= 'csecret';
process.env.GITHUB_OAUTH_CALLBACK_URL ??= 'http://localhost:3000/api/auth/github/callback';
process.env.DATABASE_URL ??= 'postgresql://test/test';
process.env.LOG_LEVEL ??= 'silent';
process.env.AZURE_STUB = 'true';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  envVarFindMany: vi.fn(),
  decrypt: vi.fn(),
}));

vi.mock('../db.js', () => ({
  prisma: { envVar: { findMany: mocks.envVarFindMany } },
}));

vi.mock('../lib/crypto.js', () => ({ decrypt: mocks.decrypt }));

const { loadEnvVarMeta, loadDecryptedEnvVars } = await import('./projectEnv.js');

beforeEach(() => {
  mocks.envVarFindMany.mockReset();
  mocks.decrypt.mockReset();
});

describe('loadEnvVarMeta', () => {
  it('returns {key,hasValue} for each row WITHOUT decrypting', async () => {
    mocks.envVarFindMany.mockResolvedValue([{ key: 'API_KEY' }, { key: 'DB_URL' }]);

    const meta = await loadEnvVarMeta('p1');

    expect(meta).toEqual([
      { key: 'API_KEY', hasValue: true },
      { key: 'DB_URL', hasValue: true },
    ]);
    // The write-only contract: no plaintext is ever produced on the read path.
    expect(mocks.decrypt).not.toHaveBeenCalled();
    // And the query only selects the key column — ciphertext is never loaded.
    const arg = mocks.envVarFindMany.mock.calls[0]![0] as { select?: unknown };
    expect(arg.select).toEqual({ key: true });
  });

  it('returns an empty list for a project with no env vars', async () => {
    mocks.envVarFindMany.mockResolvedValue([]);
    expect(await loadEnvVarMeta('p1')).toEqual([]);
    expect(mocks.decrypt).not.toHaveBeenCalled();
  });
});

describe('loadDecryptedEnvVars', () => {
  it('still decrypts (used by the deploy path, never by an HTTP response)', async () => {
    mocks.envVarFindMany.mockResolvedValue([
      {
        key: 'API_KEY',
        valueCiphertext: 'ct',
        valueIv: 'iv',
        valueAuthTag: 'tag',
        valueKeyVersion: 1,
      },
    ]);
    mocks.decrypt.mockReturnValue('secret');

    const vars = await loadDecryptedEnvVars('p1');

    expect(vars).toEqual([{ name: 'API_KEY', value: 'secret' }]);
    expect(mocks.decrypt).toHaveBeenCalledOnce();
  });
});
