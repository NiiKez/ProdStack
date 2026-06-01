/**
 * Project environment variables: the read side of the encrypted `EnvVar`
 * rows. The write side lives in the project PATCH handler (`routes/projects.ts`),
 * which stores each value AES-256-GCM-encrypted at rest.
 *
 * Both the build deploy step (`runBuild`) and rollback (`services/deploy.ts`)
 * call `loadDecryptedEnvVars` so a project's env vars are re-applied to its
 * Container App on every revision roll — that's how they get "surfaced as
 * Container App secrets" (PLAN.md M5 §2.2/§2.4). Decryption happens here, in
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
