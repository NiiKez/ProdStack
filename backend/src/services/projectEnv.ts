/**
 * Project environment variables: the read side of the encrypted `EnvVar`
 * rows. The write side lives in the project PATCH handler (`routes/projects.ts`),
 * which stores each value AES-256-GCM-encrypted at rest.
 *
 * Both the build deploy step (`runBuild`) and rollback (`services/deploy.ts`)
 * call `loadDecryptedEnvVars` so a project's env vars are re-applied to its
 * Container App on every revision roll — that's how they get "surfaced as
 * Container App secrets". Decryption happens here, in
 * memory, immediately before handing off to the Azure SDK wrapper; the
 * plaintext never touches the DB or the logs.
 */
import { prisma } from '../db.js';
import { decrypt } from '../lib/crypto.js';
import type { EnvVarInput } from './azure/containerApps.js';

export async function loadDecryptedEnvVars(projectId: string): Promise<EnvVarInput[]> {
  const rows = await prisma.envVar.findMany({
    where: { projectId },
    orderBy: { key: 'asc' },
  });
  return rows.map((row) => ({
    name: row.key,
    value: decrypt({
      ciphertext: row.valueCiphertext,
      iv: row.valueIv,
      authTag: row.valueAuthTag,
      keyVersion: row.valueKeyVersion,
    }),
  }));
}

/** A project env var with its value masked — the only env-var shape the API ever
 * returns to the client. A value is always stored (a key can't exist without one),
 * so `hasValue` is effectively `true` for every row; it's kept explicit so the
 * client can render a "(set)" placeholder and reason about the write-only contract. */
export interface EnvVarMeta {
  key: string;
  hasValue: boolean;
}

/**
 * Load a project's env-var *keys* without decrypting any value. This is the
 * read side the API surfaces: env-var values are write-only — the encrypted
 * plaintext is never returned in an HTTP response, so a leaked session/HAR or
 * an XSS can't exfiltrate the project's secrets. Editing a value requires the
 * client to submit a replacement; an untouched value is kept server-side
 * (see the project PATCH handler's partial-update semantics).
 */
export async function loadEnvVarMeta(projectId: string): Promise<EnvVarMeta[]> {
  const rows = await prisma.envVar.findMany({
    where: { projectId },
    orderBy: { key: 'asc' },
    select: { key: true },
  });
  return rows.map((row) => ({ key: row.key, hasValue: true }));
}
