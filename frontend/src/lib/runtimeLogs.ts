/**
 * Format an ISO timestamp as a local `HH:MM:SS` clock for the runtime-log
 * gutter. Returns a stable placeholder for unparseable input so the viewport
 * never renders "Invalid Date".
 */
export function formatLogClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Coarse severity bucket used only to pick a colour for the level chip. The raw
 * level label (e.g. "info", "warn", a pino "30") is preserved separately.
 */
export type LogSeverity = 'debug' | 'info' | 'warn' | 'error';

/** A structured (JSON) log line we could decode into level + message + fields. */
export interface ParsedJsonLog {
  kind: 'json';
  /** Display label for the level chip (lower-cased), or null if absent. */
  level: string | null;
  /** Colour bucket, or null when the level isn't recognized. */
  severity: LogSeverity | null;
  /** The human-facing message (the `message`/`msg` field). */
  message: string;
  /** Every remaining key — rendered in the collapsible detail, never inline. */
  fields: Record<string, unknown>;
}

/** A line we render verbatim — not JSON, or JSON without a usable message. */
export interface RawLog {
  kind: 'raw';
  text: string;
}

export type ParsedLogLine = ParsedJsonLog | RawLog;

// Field-name aliases across the common structured loggers (winston, pino,
// bunyan, .NET/Serilog). First match wins.
const MESSAGE_KEYS = ['message', 'msg'] as const;
const LEVEL_KEYS = ['level', 'severity', 'lvl', 'loglevel'] as const;
// Dropped from the detail: redundant with the gutter clock (which uses the
// Azure ingestion timestamp), and noisy.
const TIME_KEYS = ['timestamp', 'time', 'ts', '@timestamp', 'datetime'] as const;

// pino emits numeric levels; map them to names so a `"level":30` line still
// shows "info" and colours correctly.
const PINO_NUMERIC_LEVELS: Record<number, string> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};

function severityOf(level: string): LogSeverity | null {
  switch (level) {
    case 'trace':
    case 'debug':
    case 'verbose':
      return 'debug';
    case 'info':
    case 'information':
    case 'notice':
      return 'info';
    case 'warn':
    case 'warning':
      return 'warn';
    case 'error':
    case 'err':
    case 'fatal':
    case 'crit':
    case 'critical':
      return 'error';
    default:
      return null;
  }
}

function extractLevel(record: Record<string, unknown>): {
  level: string | null;
  severity: LogSeverity | null;
} {
  let raw: unknown;
  for (const k of LEVEL_KEYS) {
    if (record[k] !== undefined) {
      raw = record[k];
      break;
    }
  }
  if (typeof raw === 'number') {
    const name = PINO_NUMERIC_LEVELS[raw] ?? String(raw);
    return { level: name, severity: severityOf(name) };
  }
  if (typeof raw === 'string' && raw.length > 0) {
    const name = raw.toLowerCase();
    return { level: name, severity: severityOf(name) };
  }
  return { level: null, severity: null };
}

/**
 * Decode one runtime-log line. Many deployed apps log structured JSON (one
 * object per line) — great for Log Analytics queries, unreadable in a raw tail.
 * When a line is a JSON OBJECT carrying a string `message`/`msg`, we surface the
 * level + human message and tuck the rest into `fields`; everything else
 * (plain-text logs, JSON arrays/scalars, JSON objects with no message) renders
 * verbatim, so an app that doesn't log JSON looks exactly as before.
 *
 * Pure + exported so it's unit-tested in isolation (logic, not markup).
 */
export function parseLogLine(message: string): ParsedLogLine {
  const trimmed = message.trim();
  // Cheap reject before paying for JSON.parse: only object-shaped lines qualify.
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return { kind: 'raw', text: message };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { kind: 'raw', text: message };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'raw', text: message };
  }
  const record = parsed as Record<string, unknown>;

  // Require a usable human message — otherwise we'd render a structured line
  // with an empty headline, which reads worse than the raw JSON.
  const messageKey = MESSAGE_KEYS.find(
    (k) => typeof record[k] === 'string' && (record[k] as string).length > 0,
  );
  if (messageKey === undefined) {
    return { kind: 'raw', text: message };
  }

  const { level, severity } = extractLevel(record);

  const consumed = new Set<string>([messageKey, ...LEVEL_KEYS, ...TIME_KEYS]);
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (!consumed.has(k)) fields[k] = v;
  }

  return { kind: 'json', level, severity, message: record[messageKey] as string, fields };
}

/** Render one structured-log field value for the collapsible detail. */
export function formatLogField(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
