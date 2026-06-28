import { describe, expect, it } from 'vitest';
import { formatLogClock, formatLogField, parseLogLine } from './runtimeLogs';

describe('formatLogClock', () => {
  it('formats an ISO timestamp as HH:MM:SS', () => {
    // Use a local-time constructor so the assertion is timezone-independent.
    const d = new Date(2026, 5, 3, 9, 7, 4);
    expect(formatLogClock(d.toISOString())).toBe('09:07:04');
  });

  it('zero-pads single-digit components', () => {
    const d = new Date(2026, 0, 1, 1, 2, 3);
    expect(formatLogClock(d.toISOString())).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(formatLogClock(d.toISOString())).toBe('01:02:03');
  });

  it('returns a stable placeholder for unparseable input', () => {
    expect(formatLogClock('not-a-date')).toBe('--:--:--');
    expect(formatLogClock('')).toBe('--:--:--');
  });
});

describe('parseLogLine', () => {
  it('decodes a winston-style JSON line: string level, message promoted, rest in fields', () => {
    const line = JSON.stringify({
      env: 'production',
      level: 'info',
      message: 'GET /api/v1/manager/employees 304 26ms',
      meta: { requestId: 'abc', responseTime: 26, userId: 7 },
      service: 'expense-management-api',
      timestamp: '2026-06-28T16:10:22.014+00:00',
      version: 'unknown',
    });
    const out = parseLogLine(line);
    expect(out.kind).toBe('json');
    if (out.kind !== 'json') return;
    expect(out.level).toBe('info');
    expect(out.severity).toBe('info');
    expect(out.message).toBe('GET /api/v1/manager/employees 304 26ms');
    // level + message + timestamp are consumed; everything else survives in fields.
    expect(out.fields).toEqual({
      env: 'production',
      meta: { requestId: 'abc', responseTime: 26, userId: 7 },
      service: 'expense-management-api',
      version: 'unknown',
    });
    expect(out.fields).not.toHaveProperty('level');
    expect(out.fields).not.toHaveProperty('message');
    expect(out.fields).not.toHaveProperty('timestamp');
  });

  it('maps a pino numeric level and the `msg` alias', () => {
    const out = parseLogLine('{"level":50,"time":1782662055734,"msg":"db connection lost","code":"ECONN"}');
    expect(out.kind).toBe('json');
    if (out.kind !== 'json') return;
    expect(out.level).toBe('error'); // 50 → error
    expect(out.severity).toBe('error');
    expect(out.message).toBe('db connection lost');
    expect(out.fields).toEqual({ code: 'ECONN' }); // time consumed, msg consumed
  });

  it('buckets warn and debug levels for colour', () => {
    expect((parseLogLine('{"level":"warn","msg":"slow query"}') as { severity: unknown }).severity).toBe('warn');
    expect((parseLogLine('{"level":"debug","msg":"cache hit"}') as { severity: unknown }).severity).toBe('debug');
  });

  it('keeps an unrecognized level label but leaves severity null', () => {
    const out = parseLogLine('{"level":"audit","message":"login"}');
    expect(out.kind).toBe('json');
    if (out.kind !== 'json') return;
    expect(out.level).toBe('audit');
    expect(out.severity).toBeNull();
  });

  it('falls back to raw for a plain-text line', () => {
    expect(parseLogLine('Server listening on :3000')).toEqual({
      kind: 'raw',
      text: 'Server listening on :3000',
    });
  });

  it('falls back to raw for JSON that is not an object (array / scalar)', () => {
    expect(parseLogLine('[1,2,3]').kind).toBe('raw');
    expect(parseLogLine('42').kind).toBe('raw');
    expect(parseLogLine('"just a string"').kind).toBe('raw');
  });

  it('falls back to raw for a JSON object with no message/msg field', () => {
    const out = parseLogLine('{"level":"info","service":"api","status":200}');
    expect(out).toEqual({ kind: 'raw', text: '{"level":"info","service":"api","status":200}' });
  });

  it('falls back to raw for malformed JSON (looks like an object but is broken)', () => {
    expect(parseLogLine('{"message": broken').kind).toBe('raw');
    expect(parseLogLine('{"message":"x",}').kind).toBe('raw');
  });

  it('handles a JSON object with a level but no extra fields (no detail to expand)', () => {
    const out = parseLogLine('{"level":"info","message":"ready"}');
    expect(out.kind).toBe('json');
    if (out.kind !== 'json') return;
    expect(out.message).toBe('ready');
    expect(out.fields).toEqual({});
  });
});

describe('formatLogField', () => {
  it('passes strings through and stringifies scalars', () => {
    expect(formatLogField('hello')).toBe('hello');
    expect(formatLogField(26)).toBe('26');
    expect(formatLogField(true)).toBe('true');
  });

  it('renders null and nested objects/arrays as JSON', () => {
    expect(formatLogField(null)).toBe('null');
    expect(formatLogField({ a: 1, b: 'x' })).toBe('{"a":1,"b":"x"}');
    expect(formatLogField([1, 2])).toBe('[1,2]');
  });
});
