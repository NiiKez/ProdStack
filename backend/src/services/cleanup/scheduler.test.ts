// Env must be set before importing the module under test (env.ts validates at
// module load). Mirrors the env-before-import pattern in cleanupBuilds.test.ts.
process.env.NODE_ENV = 'test';
process.env.WEB_ORIGIN = 'http://localhost:5173';
process.env.PUBLIC_API_URL = 'http://localhost:3000';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.JWT_SECRET = 'test-jwt-secret-test-jwt-secret-0123456789';
process.env.COOKIE_SECRET = 'test-cookie-secret-0123456789-abcdefghij';
process.env.DATA_ENC_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.GITHUB_OAUTH_CLIENT_ID = 'test-client-id';
process.env.GITHUB_OAUTH_CLIENT_SECRET = 'test-client-secret';
process.env.GITHUB_OAUTH_CALLBACK_URL = 'http://localhost:3000/api/auth/github/callback';
process.env.AZURE_STUB = 'true';
process.env.LOG_LEVEL = 'silent';
process.env.RETENTION_DAYS_IMAGES = '30';
process.env.RETENTION_DAYS_LOGS = '30';
process.env.RETENTION_DAYS_BUILDS = '90';

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Capture every cron.schedule(expression, fn) call and hand back a fake task
// whose stop() we can assert. This is the integration contract the scheduler
// relies on from node-cron — it nearly drifted on the v3 -> v4 major bump
// (the schedule() signature + ScheduledTask.stop() shape), so this test pins it.
const mocks = vi.hoisted(() => ({
  scheduled: [] as Array<{ expression: string; fn: () => unknown; stop: ReturnType<typeof vi.fn> }>,
  schedule: vi.fn(),
  cleanupImages: vi.fn(),
  cleanupBuilds: vi.fn(),
  cleanupDemo: vi.fn(),
}));

mocks.schedule.mockImplementation((expression: string, fn: () => unknown) => {
  const stop = vi.fn();
  mocks.scheduled.push({ expression, fn, stop });
  return { id: `task-${mocks.scheduled.length}`, stop };
});

vi.mock('node-cron', () => ({
  default: { schedule: mocks.schedule },
  schedule: mocks.schedule,
}));

vi.mock('./cleanupImages.js', () => ({ cleanupImages: mocks.cleanupImages }));
vi.mock('./cleanupBuilds.js', () => ({ cleanupBuilds: mocks.cleanupBuilds }));
vi.mock('./cleanupDemo.js', () => ({ cleanupDemo: mocks.cleanupDemo }));

const { startCleanupScheduler } = await import('./scheduler.js');

describe('startCleanupScheduler', () => {
  beforeEach(() => {
    mocks.scheduled.length = 0;
    mocks.schedule.mockClear();
    mocks.cleanupImages.mockReset().mockResolvedValue({ deleted: 0 });
    mocks.cleanupBuilds.mockReset().mockResolvedValue({ logLines: 0, builds: 0 });
    mocks.cleanupDemo.mockReset().mockResolvedValue({ demoUsersDeleted: 0 });
  });

  it('schedules the two daily jobs at 03:17 and the hourly demo reaper at :42', () => {
    startCleanupScheduler();
    expect(mocks.schedule).toHaveBeenCalledTimes(3);
    const expressions = mocks.scheduled.map((t) => t.expression);
    // Two daily (image + build/log) + one hourly (demo reaper).
    expect(expressions.filter((e) => e === '17 3 * * *')).toHaveLength(2);
    expect(expressions.filter((e) => e === '42 * * * *')).toHaveLength(1);
  });

  it('wires the scheduled callbacks to the image, build, and demo cleanup jobs', async () => {
    startCleanupScheduler();
    // Fire each scheduled callback as node-cron would on a tick.
    for (const task of mocks.scheduled) task.fn();
    await vi.waitFor(() => {
      expect(mocks.cleanupImages).toHaveBeenCalledTimes(1);
      expect(mocks.cleanupBuilds).toHaveBeenCalledTimes(1);
      expect(mocks.cleanupDemo).toHaveBeenCalledTimes(1);
    });
  });

  it('stop() stops every scheduled task', () => {
    const handle = startCleanupScheduler();
    handle.stop();
    for (const task of mocks.scheduled) {
      expect(task.stop).toHaveBeenCalledTimes(1);
    }
  });

  it('a failing cleanup job is swallowed and never throws out of the tick', async () => {
    mocks.cleanupImages.mockRejectedValue(new Error('ACR throttled'));
    startCleanupScheduler();
    // Invoking the tick callback must not reject — the job wraps its own errors.
    for (const task of mocks.scheduled) expect(() => task.fn()).not.toThrow();
    await vi.waitFor(() => expect(mocks.cleanupImages).toHaveBeenCalled());
  });
});
