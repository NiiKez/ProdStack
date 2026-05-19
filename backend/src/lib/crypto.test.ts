// Set DATA_ENC_KEY BEFORE importing the module under test so the lazy key
// getter sees a valid key on first call. The module has no top-level side
// effects, so a plain static import below is still safe.
process.env.DATA_ENC_KEY = Buffer.alloc(32, 7).toString('base64');

import { describe, expect, it, vi } from 'vitest';

import { CURRENT_KEY_VERSION, decrypt, encrypt } from './crypto.js';

describe('crypto round-trip', () => {
  it('encrypts and decrypts a simple ASCII string', () => {
    const field = encrypt('hello world');
    expect(decrypt(field)).toBe('hello world');
  });

  it('round-trips Unicode (emoji, CJK, combining marks)', () => {
    const plaintext = 'héllo 🌍 世界 ́';
    const field = encrypt(plaintext);
    expect(decrypt(field)).toBe(plaintext);
  });

  it('round-trips a 4KB payload', () => {
    const plaintext = 'A'.repeat(4096);
    const field = encrypt(plaintext);
    expect(decrypt(field)).toBe(plaintext);
  });

  it('returns Uint8Array<ArrayBuffer> instances (Prisma Bytes-compatible)', () => {
    const field = encrypt('hello');
    expect(field.ciphertext).toBeInstanceOf(Uint8Array);
    expect(field.iv).toBeInstanceOf(Uint8Array);
    expect(field.authTag).toBeInstanceOf(Uint8Array);
    expect(field.iv.buffer).toBeInstanceOf(ArrayBuffer);
    expect(field.iv.length).toBe(12);
    expect(field.authTag.length).toBe(16);
    expect(field.keyVersion).toBe(CURRENT_KEY_VERSION);
  });
});

describe('crypto tampering detection', () => {
  it('throws when ciphertext is mutated', () => {
    const field = encrypt('hello world');
    const tampered = Buffer.from(field.ciphertext);
    tampered[0] = tampered[0]! ^ 1;
    expect(() =>
      decrypt({
        ciphertext: tampered,
        iv: field.iv,
        authTag: field.authTag,
        keyVersion: field.keyVersion,
      }),
    ).toThrow();
  });

  it('throws when authTag is wrong', () => {
    const field = encrypt('hello world');
    const badAuthTag = Buffer.alloc(field.authTag.length, 0);
    expect(() =>
      decrypt({
        ciphertext: field.ciphertext,
        iv: field.iv,
        authTag: badAuthTag,
        keyVersion: field.keyVersion,
      }),
    ).toThrow();
  });

  it('throws on unknown future keyVersion', () => {
    const field = encrypt('hello');
    expect(() =>
      decrypt({
        ciphertext: field.ciphertext,
        iv: field.iv,
        authTag: field.authTag,
        keyVersion: 2,
      }),
    ).toThrow(/Unknown DATA_ENC_KEY version/);
  });
});

describe('crypto nonce uniqueness', () => {
  it('produces a different IV for each encryption of the same plaintext', () => {
    const a = encrypt('hello world');
    const b = encrypt('hello world');
    expect(Buffer.from(a.iv).equals(Buffer.from(b.iv))).toBe(false);
    expect(Buffer.from(a.ciphertext).equals(Buffer.from(b.ciphertext))).toBe(false);
  });
});

describe('crypto key configuration errors', () => {
  it('throws a clear error when DATA_ENC_KEY is missing', async () => {
    const original = process.env.DATA_ENC_KEY;
    delete process.env.DATA_ENC_KEY;
    try {
      // Reset the module registry so the in-module key cache is rebuilt with
      // the freshly mutated env.
      vi.resetModules();
      const fresh = await import('./crypto.js');
      expect(() => fresh.encrypt('x')).toThrow(/DATA_ENC_KEY is not set/);
    } finally {
      if (original !== undefined) {
        process.env.DATA_ENC_KEY = original;
      }
      vi.resetModules();
    }
  });

  it('throws a clear error when DATA_ENC_KEY decodes to the wrong length', async () => {
    const original = process.env.DATA_ENC_KEY;
    process.env.DATA_ENC_KEY = Buffer.alloc(16, 1).toString('base64'); // 16 bytes, not 32
    try {
      vi.resetModules();
      const fresh = await import('./crypto.js');
      expect(() => fresh.encrypt('x')).toThrow(/must decode to exactly 32 bytes/);
    } finally {
      if (original !== undefined) {
        process.env.DATA_ENC_KEY = original;
      } else {
        delete process.env.DATA_ENC_KEY;
      }
      vi.resetModules();
    }
  });
});
