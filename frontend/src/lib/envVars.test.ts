import { describe, expect, it } from 'vitest';
import { buildEnvPayload, envRowsDirty, rowsFromServer, type EnvRow } from './envVars';
import type { ProjectEnvVar } from '@/types/api';

const server: ProjectEnvVar[] = [
  { key: 'API_KEY', hasValue: true },
  { key: 'DB_URL', hasValue: true },
];

describe('rowsFromServer', () => {
  it('seeds masked stored rows (no value, stored:true, edited:false)', () => {
    expect(rowsFromServer(server)).toEqual([
      { key: 'API_KEY', value: '', stored: true, edited: false },
      { key: 'DB_URL', value: '', stored: true, edited: false },
    ]);
  });

  it('returns [] for undefined', () => {
    expect(rowsFromServer(undefined)).toEqual([]);
  });
});

describe('buildEnvPayload', () => {
  it('omits the value for an untouched stored row (keep stored secret)', () => {
    const rows = rowsFromServer(server);
    expect(buildEnvPayload(rows)).toEqual([{ key: 'API_KEY' }, { key: 'DB_URL' }]);
    // Critically: no `value` is sent for an unedited row.
    expect(buildEnvPayload(rows).every((e) => !('value' in e))).toBe(true);
  });

  it('sends the value only for the edited row, keeps the untouched one', () => {
    const rows: EnvRow[] = [
      { key: 'API_KEY', value: '', stored: true, edited: false },
      { key: 'DB_URL', value: 'postgres://new', stored: true, edited: true },
    ];
    expect(buildEnvPayload(rows)).toEqual([
      { key: 'API_KEY' },
      { key: 'DB_URL', value: 'postgres://new' },
    ]);
  });

  it('sends the value for a brand-new row', () => {
    const rows: EnvRow[] = [
      ...rowsFromServer(server),
      { key: 'NEW_VAR', value: 'v', stored: false, edited: true },
    ];
    expect(buildEnvPayload(rows)).toEqual([
      { key: 'API_KEY' },
      { key: 'DB_URL' },
      { key: 'NEW_VAR', value: 'v' },
    ]);
  });

  it('drops blank-key (in-progress) rows', () => {
    const rows: EnvRow[] = [
      { key: '', value: 'orphan', stored: false, edited: true },
      { key: 'API_KEY', value: '', stored: true, edited: false },
    ];
    expect(buildEnvPayload(rows)).toEqual([{ key: 'API_KEY' }]);
  });

  it('omits a removed key entirely (so the backend deletes it)', () => {
    // DB_URL dropped from the editor → not in the payload → deleted server-side.
    const rows: EnvRow[] = [{ key: 'API_KEY', value: '', stored: true, edited: false }];
    expect(buildEnvPayload(rows)).toEqual([{ key: 'API_KEY' }]);
  });
});

describe('envRowsDirty', () => {
  it('not dirty when only unedited stored rows are present', () => {
    expect(envRowsDirty(rowsFromServer(server), server)).toBe(false);
  });

  it('dirty when a stored row is edited', () => {
    const rows: EnvRow[] = [
      { key: 'API_KEY', value: 'rotated', stored: true, edited: true },
      { key: 'DB_URL', value: '', stored: true, edited: false },
    ];
    expect(envRowsDirty(rows, server)).toBe(true);
  });

  it('dirty when a new key is added', () => {
    const rows: EnvRow[] = [
      ...rowsFromServer(server),
      { key: 'NEW_VAR', value: 'v', stored: false, edited: true },
    ];
    expect(envRowsDirty(rows, server)).toBe(true);
  });

  it('dirty when a key is removed', () => {
    const rows: EnvRow[] = [{ key: 'API_KEY', value: '', stored: true, edited: false }];
    expect(envRowsDirty(rows, server)).toBe(true);
  });

  it('not dirty against an empty server when no rows', () => {
    expect(envRowsDirty([], undefined)).toBe(false);
  });
});
