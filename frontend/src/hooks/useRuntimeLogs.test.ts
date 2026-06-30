import { describe, expect, it } from 'vitest';
import { logsPollIntervalMs } from './useRuntimeLogs';

// Pure cadence logic for the runtime-log auto-refresh. The cutoffs must line up
// with the Logs-tab range picker (15m/1h → fast tail, 6h/24h → gentle, 7d/30d →
// manual) so a wide historical window doesn't re-scan days of Log Analytics
// every few seconds.
describe('logsPollIntervalMs', () => {
  it('polls fast (8s) for a near-live tail up to 1h', () => {
    expect(logsPollIntervalMs(15)).toBe(8_000);
    expect(logsPollIntervalMs(60)).toBe(8_000);
  });

  it('polls gently (30s) for 6h–24h windows', () => {
    expect(logsPollIntervalMs(61)).toBe(30_000);
    expect(logsPollIntervalMs(360)).toBe(30_000);
    expect(logsPollIntervalMs(1440)).toBe(30_000);
  });

  it('turns auto-refresh off for historical 7d/30d windows', () => {
    expect(logsPollIntervalMs(10_080)).toBe(false);
    expect(logsPollIntervalMs(43_200)).toBe(false);
  });
});
