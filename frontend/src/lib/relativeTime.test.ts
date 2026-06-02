import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatRelative } from '@/lib/relativeTime';

const NOW = new Date('2026-06-02T12:00:00Z');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

function ago(ms: number): string {
  return formatRelative(new Date(NOW.getTime() - ms));
}

function ahead(ms: number): string {
  return formatRelative(new Date(NOW.getTime() + ms));
}

describe('formatRelative', () => {
  it('formats ~30 seconds in the past', () => {
    expect(ago(30_000)).toBe('30 seconds ago');
  });

  it('formats a few minutes in the past', () => {
    expect(ago(5 * 60_000)).toBe('5 minutes ago');
  });

  it('formats hours in the past', () => {
    expect(ago(3 * 60 * 60_000)).toBe('3 hours ago');
  });

  it('formats days in the past', () => {
    expect(ago(2 * 24 * 60 * 60_000)).toBe('2 days ago');
  });

  it('formats a future time with "in X" wording', () => {
    expect(ahead(45_000)).toBe('in 45 seconds');
    expect(ahead(2 * 60 * 60_000)).toBe('in 2 hours');
  });

  it('keeps past vs future direction correct', () => {
    const past = ago(2 * 24 * 60 * 60_000);
    const future = ahead(2 * 24 * 60 * 60_000);
    expect(past).toMatch(/ago$/);
    expect(future).toMatch(/^in /);
    expect(past).not.toBe(future);
  });

  it('uses minute granularity once past the seconds division', () => {
    // ~90s ago rounds into the minute bucket (numeric:auto wording)
    expect(ago(90_000)).toMatch(/minute/);
  });
});
