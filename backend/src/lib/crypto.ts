import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * App-layer AES-256-GCM encryption for sensitive fields stored in Postgres
 * (GitHub OAuth tokens, per-project webhook secrets, env-var values).
 *
 * Key source: `process.env.DATA_ENC_KEY` — base64-encoded, must decode to
 * exactly 32 bytes. Read lazily so tests can mutate `process.env` before
 * the first call; there are no top-level side effects beyond constants.
 *
 * See `backend/prisma/SCHEMA_NOTES.md` for the on-disk column convention.
 */

/**
 * Prisma's `Bytes` columns are typed as `Uint8Array<ArrayBuffer>` since v6. Node's `Buffer`
 * is `Uint8Array<ArrayBufferLike>` and is not assignable without a copy. We normalize at
 * encrypt time so callers can pass our outputs straight to Prisma.
 */
export interface EncryptedField {
  ciphertext: Uint8Array<ArrayBuffer>;
  iv: Uint8Array<ArrayBuffer>;
  authTag: Uint8Array<ArrayBuffer>;
  keyVersion: number;
}

export const CURRENT_KEY_VERSION = 1;

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;

let cachedKey: Buffer | null = null;
let cachedKeySource: string | undefined;

function getKey(): Buffer {
  const raw = process.env.DATA_ENC_KEY;

  if (raw === undefined || raw === '') {
    // Invalidate cache so a later set of the env var is picked up.
    cachedKey = null;
    cachedKeySource = undefined;
    throw new Error(
      'DATA_ENC_KEY is not set. Provide a base64-encoded 32-byte key via the DATA_ENC_KEY environment variable.',
    );
  }

  if (cachedKey !== null && cachedKeySource === raw) {
    return cachedKey;
  }

  let decoded: Buffer;
  try {
    decoded = Buffer.from(raw, 'base64');
  } catch {
    throw new Error('DATA_ENC_KEY is not valid base64.');
  }

  if (decoded.length !== KEY_BYTES) {
    throw new Error(
      `DATA_ENC_KEY must decode to exactly ${KEY_BYTES} bytes (got ${decoded.length}). Generate one with: openssl rand -base64 32`,
    );
  }

  cachedKey = decoded;
  cachedKeySource = raw;
  return decoded;
}

export function encrypt(plaintext: string): EncryptedField {
  const key = getKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // `new Uint8Array(arrayLike)` copies into a fresh ArrayBuffer, satisfying Prisma's
  // strict `Uint8Array<ArrayBuffer>` Bytes type.
  return {
    ciphertext: new Uint8Array(ciphertext),
    iv: new Uint8Array(iv),
    authTag: new Uint8Array(authTag),
    keyVersion: CURRENT_KEY_VERSION,
  };
}

export function decrypt(field: {
  ciphertext: Uint8Array;
  iv: Uint8Array;
  authTag: Uint8Array;
  keyVersion?: number | null;
}): string {
  const version = field.keyVersion ?? CURRENT_KEY_VERSION;
  if (version !== CURRENT_KEY_VERSION) {
    throw new Error('Unknown DATA_ENC_KEY version');
  }

  const key = getKey();
  const decipher = createDecipheriv(ALGORITHM, key, field.iv);
  decipher.setAuthTag(field.authTag);
  // `final()` throws on auth-tag mismatch (tampering, wrong key) — let it propagate.
  const plaintext = Buffer.concat([decipher.update(field.ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}
