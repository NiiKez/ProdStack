import { describe, expect, it } from 'vitest';
import { buildQuery } from '@/hooks/useProjectBuilds';

describe('buildQuery', () => {
  it('emits only limit for empty filters', () => {
    const p = new URLSearchParams(buildQuery({}));
    expect(p.get('limit')).toBe('20');
    expect(p.get('status')).toBeNull();
    expect(p.get('branch')).toBeNull();
    expect(p.get('cursor')).toBeNull();
  });

  it('joins a status array with commas', () => {
    const p = new URLSearchParams(buildQuery({ status: ['READY', 'FAILED'] }));
    expect(p.get('status')).toBe('READY,FAILED');
    expect(p.get('limit')).toBe('20');
  });

  it('omits an empty status array', () => {
    const p = new URLSearchParams(buildQuery({ status: [] }));
    expect(p.get('status')).toBeNull();
    expect(p.get('limit')).toBe('20');
  });

  it('maps branch to its param', () => {
    const p = new URLSearchParams(buildQuery({ branch: 'main' }));
    expect(p.get('branch')).toBe('main');
  });

  it('maps sort to its param', () => {
    const p = new URLSearchParams(buildQuery({ sort: 'duration' }));
    expect(p.get('sort')).toBe('duration');
  });

  it('maps order to its param', () => {
    const p = new URLSearchParams(buildQuery({ order: 'asc' }));
    expect(p.get('order')).toBe('asc');
  });

  it('maps since to its param', () => {
    const since = '2026-06-01T00:00:00.000Z';
    const p = new URLSearchParams(buildQuery({ since }));
    expect(p.get('since')).toBe(since);
  });

  it('adds cursor when provided', () => {
    const p = new URLSearchParams(buildQuery({}, 'abc123'));
    expect(p.get('cursor')).toBe('abc123');
    expect(p.get('limit')).toBe('20');
  });

  it('omits cursor when not provided', () => {
    const p = new URLSearchParams(buildQuery({ branch: 'dev' }));
    expect(p.get('cursor')).toBeNull();
  });

  it('produces all params for combined filters', () => {
    const since = '2026-05-30T12:00:00.000Z';
    const p = new URLSearchParams(
      buildQuery(
        {
          status: ['READY', 'FAILED'],
          branch: 'release',
          sort: 'created',
          order: 'desc',
          since,
        },
        'cur-9',
      ),
    );
    expect(p.get('status')).toBe('READY,FAILED');
    expect(p.get('branch')).toBe('release');
    expect(p.get('sort')).toBe('created');
    expect(p.get('order')).toBe('desc');
    expect(p.get('since')).toBe(since);
    expect(p.get('limit')).toBe('20');
    expect(p.get('cursor')).toBe('cur-9');
  });
});
