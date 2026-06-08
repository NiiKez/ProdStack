import type { ProjectEnvVar, UpdateEnvVar } from '@/types/api';

/**
 * One row in the env-var editor. Env-var values are write-only — the server
 * never sends the cleartext — so a row that came from the server carries no
 * `value`, only the fact that one is stored (`stored: true`). The user types a
 * replacement into `value`; until they do, the field shows a "(set)"
 * placeholder. A row the user added from scratch has `stored: false`.
 */
export interface EnvRow {
  key: string;
  /** The user-typed (new) value. Empty for an unedited stored row. */
  value: string;
  /** True when the server reported a value already stored for this key. */
  stored: boolean;
  /** True once the user has typed into the value field (a real replacement). */
  edited: boolean;
}

/** Seed editor rows from the server's masked env-var metadata. */
export function rowsFromServer(envVars: ProjectEnvVar[] | undefined): EnvRow[] {
  return (envVars ?? []).map((e) => ({
    key: e.key,
    value: '',
    stored: e.hasValue,
    edited: false,
  }));
}

/**
 * Build the PATCH `envVars` payload from the editor rows.
 *
 * Per key, mirroring the backend's write-only partial-update contract:
 * - a new or edited row → send `{ key, value }` (the value is set/encrypted),
 * - an unedited stored row → send `{ key }` with NO value (keep the stored one),
 * - rows absent from the list → omitted entirely (deleted server-side).
 *
 * Blank-key rows are dropped (they're in-progress UI rows, not real vars).
 */
export function buildEnvPayload(rows: EnvRow[]): UpdateEnvVar[] {
  const payload: UpdateEnvVar[] = [];
  for (const row of rows) {
    if (row.key.trim() === '') continue;
    // A row "has a new value" when the user added it (not stored) or edited it.
    if (!row.stored || row.edited) {
      payload.push({ key: row.key, value: row.value });
    } else {
      payload.push({ key: row.key });
    }
  }
  return payload;
}

/**
 * True when the editor differs from the server state in a way that needs saving:
 * a new/edited value, a removed key, or an added key. An unedited stored row on
 * its own is not dirty (the masked placeholder == "no change").
 */
export function envRowsDirty(rows: EnvRow[], server: ProjectEnvVar[] | undefined): boolean {
  const serverKeys = new Set((server ?? []).map((e) => e.key));
  const rowKeys = rows.filter((r) => r.key.trim() !== '').map((r) => r.key);
  // Any added/edited value?
  if (rows.some((r) => r.key.trim() !== '' && (!r.stored || r.edited))) return true;
  // Any server key dropped, or any extra key added?
  if (rowKeys.length !== serverKeys.size) return true;
  return rowKeys.some((k) => !serverKeys.has(k));
}
