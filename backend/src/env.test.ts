// Guards for env.ts cross-field safety. The setup file (src/test/setup.ts) has
// already populated process.env with NODE_ENV='test' + AZURE_STUB='true', so
// importing env.ts (which validates at module load) is safe here — the unsafe
// combination is exercised by calling the exported pure function directly
// rather than re-parsing the environment.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { assertSafeEnvCombination } from './env.js';

describe('assertSafeEnvCombination (dev-backdoor fail-closed guard)', () => {
  it('throws for development + real Azure (AZURE_STUB=false)', () => {
    expect(() =>
      assertSafeEnvCombination({ NODE_ENV: 'development', AZURE_STUB: false }),
    ).toThrow();
  });

  it('does NOT throw for test + real Azure (AZURE_STUB=false) — the backdoor never mounts under test and the suite exercises real-Azure paths', () => {
    expect(() =>
      assertSafeEnvCombination({ NODE_ENV: 'test', AZURE_STUB: false }),
    ).not.toThrow();
  });

  it('does NOT throw for production + real Azure (AZURE_STUB=false)', () => {
    expect(() =>
      assertSafeEnvCombination({ NODE_ENV: 'production', AZURE_STUB: false }),
    ).not.toThrow();
  });

  it('does NOT throw for development + stubbed Azure (AZURE_STUB=true)', () => {
    expect(() =>
      assertSafeEnvCombination({ NODE_ENV: 'development', AZURE_STUB: true }),
    ).not.toThrow();
  });

  it('does NOT throw for test + stubbed Azure (AZURE_STUB=true)', () => {
    expect(() =>
      assertSafeEnvCombination({ NODE_ENV: 'test', AZURE_STUB: true }),
    ).not.toThrow();
  });
});

describe('.dockerignore excludes the dev-login backdoor source', () => {
  // env.test.ts lives at backend/src/env.test.ts → repo root is three levels up.
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const dockerignore = readFileSync(path.join(repoRoot, '.dockerignore'), 'utf8');

  it('excludes backend/src/routes/devAuth.ts', () => {
    expect(dockerignore).toContain('backend/src/routes/devAuth.ts');
  });

  it('excludes backend/scripts/seed-dev.mjs', () => {
    expect(dockerignore).toContain('backend/scripts/seed-dev.mjs');
  });
});
