import { describe, expect, it } from 'vitest';
import { formatLogClock } from './runtimeLogs';

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
