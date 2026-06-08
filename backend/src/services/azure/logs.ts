/**
 * Azure Log Analytics "runtime logs" wrapper.
 *
 * Reads a Container App's stdout/stderr from the Log Analytics workspace that
 * the managed environment forwards console output to (table
 * `ContainerAppConsoleLogs_CL`). Mirrors the two-branch shape used by
 * `containerApps.ts`:
 *
 *  - **Stub** (`AZURE_STUB=true`): returns deterministic fake log lines so the
 *    Logs UI / API can be exercised locally and in tests without Azure.
 *
 *  - **Real** (`AZURE_STUB=false`): queries the workspace named by
 *    `LOG_ANALYTICS_WORKSPACE_ID` via `@azure/monitor-query`'s
 *    `LogsQueryClient`. Credentials come from `DefaultAzureCredential` so the
 *    API picks up its system-assigned managed identity in production.
 *
 * This function NEVER throws: a missing workspace id or any query failure
 * degrades to `{ lines: [], available: false, note }` so the caller can show a
 * friendly "logs unavailable" state instead of a 500.
 */
import {
  LogsQueryClient,
  LogsQueryResultStatus,
  type LogsQueryResult,
  type LogsTable,
} from '@azure/monitor-query';
import { DefaultAzureCredential } from '@azure/identity';
import pino from 'pino';

import { env } from '../../env.js';
import { logger } from '../../lib/logger.js';

// --- Public contract -------------------------------------------------------

export interface RuntimeLogLine {
  ts: string;
  message: string;
  stream: 'stdout' | 'stderr' | 'unknown';
  revision: string | null;
}

export interface RuntimeLogsResult {
  lines: RuntimeLogLine[];
  available: boolean;
  note?: string;
}

export interface QueryRuntimeLogsOpts {
  containerAppName: string;
  sinceMinutes?: number;
  afterTs?: string;
  limit?: number;
}

// --- Constants -------------------------------------------------------------

const DEFAULT_SINCE_MINUTES = 15;
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 1000;

const NOTE_NOT_CONFIGURED = 'Runtime logs are not configured for this environment.';
const NOTE_UNAVAILABLE = 'Runtime logs are temporarily unavailable.';

/**
 * Container App names are validated upstream (and here) against this pattern,
 * so they cannot contain characters that would break out of the KQL string
 * literal. We still validate defensively before interpolating.
 */
const APP_NAME_RE = /^[a-z0-9-]{1,32}$/;

const stubLog = pino({ name: 'azure-logs-stub' });

// --- Stub branch -----------------------------------------------------------

/**
 * Exported so the demo path (`routes/projects.ts`) can synthesize runtime log
 * lines for a demo project regardless of `AZURE_STUB` (prod runs
 * `AZURE_STUB=false`, but a demo project has no real Log Analytics data).
 * Behavior is unchanged — the same deterministic generator the
 * `AZURE_STUB=true` branch uses. See docs/DEMO_MODE.md §6.5.
 */
export function stubRuntimeLogs(opts: QueryRuntimeLogsOpts): RuntimeLogsResult {
  stubLog.info(
    {
      op: 'queryRuntimeLogs',
      name: opts.containerAppName,
      sinceMinutes: opts.sinceMinutes ?? DEFAULT_SINCE_MINUTES,
      afterTs: opts.afterTs,
      limit: clampLimit(opts.limit),
    },
    'stub: query runtime logs',
  );

  // Simulate a tailing cursor: nothing new has happened since `afterTs`.
  if (opts.afterTs) {
    return { lines: [], available: true };
  }

  const revision = `${opts.containerAppName}--stub`;
  const now = Date.now();
  const at = (offsetMs: number): string => new Date(now + offsetMs).toISOString();

  const lines: RuntimeLogLine[] = [
    { ts: at(-4000), message: 'Server listening on :3000', stream: 'stdout', revision },
    { ts: at(-3000), message: 'GET /healthz 200 2ms', stream: 'stdout', revision },
    { ts: at(-2000), message: 'GET / 200 11ms', stream: 'stdout', revision },
    { ts: at(-1000), message: 'GET /api/projects 200 7ms', stream: 'stdout', revision },
  ];

  return { lines, available: true };
}

// --- Real branch -----------------------------------------------------------

let cachedClient: LogsQueryClient | undefined;

function getClient(): LogsQueryClient {
  if (cachedClient) return cachedClient;
  cachedClient = new LogsQueryClient(new DefaultAzureCredential());
  return cachedClient;
}

function clampLimit(limit: number | undefined): number {
  const n = limit ?? DEFAULT_LIMIT;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

/** ISO8601 duration (e.g. `PT15M`) for the query timespan from a minute count. */
function minutesToDuration(sinceMinutes: number | undefined): string {
  const m = sinceMinutes ?? DEFAULT_SINCE_MINUTES;
  if (!Number.isFinite(m) || m <= 0) return `PT${DEFAULT_SINCE_MINUTES}M`;
  return `PT${Math.ceil(m)}M`;
}

function buildKql(opts: { name: string; afterTs?: string; limit: number }): string {
  // `name` is guaranteed `^[a-z0-9-]{1,32}$` by the caller-side validation, so
  // it cannot contain `"` — but we still escape defensively.
  const safeName = opts.name.replace(/["\\]/g, '');
  const afterClause = opts.afterTs
    ? `| where TimeGenerated > datetime("${escapeKqlDatetime(opts.afterTs)}")\n`
    : '';
  // `take` after a sort returns the FIRST N rows of the sorted output, so to
  // keep the NEWEST N we sort descending, take N, then re-sort ascending for
  // chronological display (otherwise a high-volume app silently drops its most
  // recent lines — the opposite of what a log tail wants).
  return (
    'ContainerAppConsoleLogs_CL\n' +
    `| where ContainerAppName_s == "${safeName}"\n` +
    afterClause +
    '| project TimeGenerated, Log_s, Stream_s, RevisionName_s\n' +
    '| order by TimeGenerated desc\n' +
    `| take ${opts.limit}\n` +
    '| order by TimeGenerated asc'
  );
}

/** Strip anything that isn't part of an ISO8601 timestamp before interpolating. */
function escapeKqlDatetime(value: string): string {
  return value.replace(/[^0-9TZ:.+-]/g, '');
}

function normalizeStream(value: unknown): RuntimeLogLine['stream'] {
  if (value === 'stdout' || value === 'stderr') return value;
  return 'unknown';
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? value : d.toISOString();
  }
  return new Date(0).toISOString();
}

function asStringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

/**
 * Pull the populated table out of a successful result. `realRuntimeLogs`
 * early-returns `available:false` on PartialFailure, so this is only ever
 * called on a Success.
 */
function tableFrom(result: LogsQueryResult): LogsTable | undefined {
  if (result.status === LogsQueryResultStatus.Success) {
    return result.tables[0];
  }
  return undefined;
}

function rowsToLines(table: LogsTable | undefined): RuntimeLogLine[] {
  if (!table) return [];

  const colIndex = new Map<string, number>();
  table.columnDescriptors.forEach((col, i) => {
    if (col.name) colIndex.set(col.name, i);
  });

  const tsIdx = colIndex.get('TimeGenerated');
  const logIdx = colIndex.get('Log_s');
  const streamIdx = colIndex.get('Stream_s');
  const revIdx = colIndex.get('RevisionName_s');

  return table.rows.map((row) => {
    const message = logIdx === undefined ? '' : (asStringOrNull(row[logIdx]) ?? '');
    return {
      ts: tsIdx === undefined ? new Date(0).toISOString() : toIso(row[tsIdx]),
      message,
      stream: streamIdx === undefined ? 'unknown' : normalizeStream(row[streamIdx]),
      revision: revIdx === undefined ? null : asStringOrNull(row[revIdx]),
    };
  });
}

async function realRuntimeLogs(opts: QueryRuntimeLogsOpts): Promise<RuntimeLogsResult> {
  const workspaceId = env.LOG_ANALYTICS_WORKSPACE_ID;
  if (!workspaceId) {
    return { lines: [], available: false, note: NOTE_NOT_CONFIGURED };
  }

  if (!APP_NAME_RE.test(opts.containerAppName)) {
    logger.warn(
      { name: opts.containerAppName },
      'queryRuntimeLogs: rejected invalid container app name',
    );
    return { lines: [], available: false, note: NOTE_UNAVAILABLE };
  }

  const limit = clampLimit(opts.limit);
  const query = buildKql({ name: opts.containerAppName, afterTs: opts.afterTs, limit });
  // The KQL also filters on `afterTs` when provided; the timespan is the outer
  // bound. We use the duration form so callers don't need clock-synced Dates.
  const duration = minutesToDuration(opts.sinceMinutes);

  try {
    // `serverTimeoutInSeconds` caps the Azure-side query so a hung call can't
    // tie up a polling request indefinitely.
    const result = await getClient().queryWorkspace(
      workspaceId,
      query,
      { duration },
      { serverTimeoutInSeconds: 30 },
    );

    // `queryWorkspace` resolves to `Success | PartialFailure`; a hard `Failure`
    // surfaces as a thrown error (handled by the catch below).
    if (result.status === LogsQueryResultStatus.PartialFailure) {
      logger.warn(
        { name: opts.containerAppName, err: result.partialError },
        'queryRuntimeLogs: Log Analytics query partially failed',
      );
      return { lines: [], available: false, note: NOTE_UNAVAILABLE };
    }

    return { lines: rowsToLines(tableFrom(result)), available: true };
  } catch (err) {
    logger.warn({ err, name: opts.containerAppName }, 'queryRuntimeLogs failed');
    return { lines: [], available: false, note: NOTE_UNAVAILABLE };
  }
}

// --- Public entrypoint -----------------------------------------------------

export function isStub(): boolean {
  return env.AZURE_STUB;
}

/**
 * Fetch recent runtime (stdout/stderr) log lines for a Container App.
 *
 * Never throws — failures degrade to `{ available: false }` with a `note`.
 */
export async function queryRuntimeLogs(
  opts: QueryRuntimeLogsOpts,
): Promise<RuntimeLogsResult> {
  return isStub() ? stubRuntimeLogs(opts) : realRuntimeLogs(opts);
}
