import { describe, expect, it } from 'vitest';

import {
  buildArgFlags,
  buildChildEnv,
  buildCommand,
  cacheOrSnapshotFlags,
  type KanikoOptions,
} from './kaniko.js';

describe('buildArgFlags', () => {
  it('renders one --build-arg=NAME=VALUE token per var', () => {
    expect(
      buildArgFlags([
        { name: 'NEXT_PUBLIC_URL', value: 'https://x.supabase.co' },
        { name: 'VITE_MODE', value: 'prod' },
      ]),
    ).toEqual([
      '--build-arg=NEXT_PUBLIC_URL=https://x.supabase.co',
      '--build-arg=VITE_MODE=prod',
    ]);
  });

  it('returns [] for empty/undefined input', () => {
    expect(buildArgFlags()).toEqual([]);
    expect(buildArgFlags([])).toEqual([]);
  });

  it('keeps `=` and spaces inside the value in a single argv token (no shell)', () => {
    expect(buildArgFlags([{ name: 'PUBLIC_X', value: 'a=b c' }])).toEqual([
      '--build-arg=PUBLIC_X=a=b c',
    ]);
  });
});

describe('buildCommand — build args', () => {
  // Default test env: BUILD_RUNNER_MODE=stub → buildCommand takes the
  // kaniko-executor branch (it only special-cases 'docker'), which is the prod
  // path. The docker branch reuses the same buildArgFlags() helper.
  const base: KanikoOptions = {
    contextDir: '/var/builds/b1/repo',
    authDir: '/var/builds/b1/auth',
    dockerfile: '/var/builds/b1/repo/.prodstack.Dockerfile',
    destinations: ['acr.azurecr.io/app:sha'],
    onLine: () => {},
    timeoutMs: 1000,
  };

  it('emits --build-arg flags, positioned before the destinations', () => {
    const { command, args } = buildCommand(
      { ...base, buildArgs: [{ name: 'NEXT_PUBLIC_URL', value: 'https://x' }] },
      '/var/builds/b1/auth/.docker',
    );
    expect(command).toBe('/kaniko/executor');
    expect(args).toContain('--build-arg=NEXT_PUBLIC_URL=https://x');
    const argIdx = args.indexOf('--build-arg=NEXT_PUBLIC_URL=https://x');
    const destIdx = args.indexOf('--destination=acr.azurecr.io/app:sha');
    expect(argIdx).toBeGreaterThan(-1);
    expect(destIdx).toBeGreaterThan(argIdx);
  });

  it('emits no --build-arg flags when there are none', () => {
    const { args } = buildCommand(base, '/var/builds/b1/auth/.docker');
    expect(args.some((a) => a.startsWith('--build-arg'))).toBe(false);
  });
});

describe('buildChildEnv — minimal allow-listed child env (Finding 2)', () => {
  // A source env stuffed with every platform secret the worker process holds.
  // Kaniko runs UNTRUSTED user-Dockerfile `RUN` steps, so NONE of these may
  // pass through into the spawned executor's environment.
  const SECRETY_SOURCE: NodeJS.ProcessEnv = {
    // Allowed (non-secret) keys:
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: '/home/builder',
    HTTPS_PROXY: 'http://proxy:3128',
    no_proxy: 'localhost,127.0.0.1',
    DOCKER_HOST: 'unix:///run/user/1000/docker.sock',
    // Secrets that must be DROPPED:
    DATABASE_URL: 'postgresql://u:p@db:5432/x',
    DATA_ENC_KEY: 'enc-key-secret',
    JWT_SECRET: 'jwt-secret',
    COOKIE_SECRET: 'cookie-secret',
    ACR_PASSWORD: 'acr-password',
    ACR_USERNAME: 'acr-username',
    DOCKERHUB_TOKEN: 'dckr_pat_secret',
    DEPLOY_TOKEN: 'deploy-token',
    ADMIN_TOKEN: 'admin-token',
    AWS_SECRET_ACCESS_KEY: 'aws-secret',
  };

  const PLATFORM_SECRETS = [
    'DATABASE_URL',
    'DATA_ENC_KEY',
    'JWT_SECRET',
    'COOKIE_SECRET',
    'ACR_PASSWORD',
    'ACR_USERNAME',
    'DOCKERHUB_TOKEN',
    'DEPLOY_TOKEN',
    'ADMIN_TOKEN',
    'AWS_SECRET_ACCESS_KEY',
  ];

  it('forwards ONLY the non-secret allow-list, dropping every platform secret', () => {
    const childEnv = buildChildEnv({}, SECRETY_SOURCE);
    expect(childEnv).toEqual({
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: '/home/builder',
      HTTPS_PROXY: 'http://proxy:3128',
      no_proxy: 'localhost,127.0.0.1',
      DOCKER_HOST: 'unix:///run/user/1000/docker.sock',
    });
    for (const secret of PLATFORM_SECRETS) {
      expect(childEnv[secret]).toBeUndefined();
    }
  });

  it('merges `extra` (e.g. DOCKER_CONFIG) and lets it win on a key clash', () => {
    const childEnv = buildChildEnv(
      { DOCKER_CONFIG: '/var/builds/b1/auth/.docker', PATH: '/override' },
      SECRETY_SOURCE,
    );
    expect(childEnv.DOCKER_CONFIG).toBe('/var/builds/b1/auth/.docker');
    expect(childEnv.PATH).toBe('/override');
    // Adding extra must not reopen the door to a dropped secret.
    expect(childEnv.DATABASE_URL).toBeUndefined();
    expect(childEnv.DATA_ENC_KEY).toBeUndefined();
  });

  it('omits an allow-list var that is absent from the source (no undefined keys)', () => {
    const childEnv = buildChildEnv({}, { PATH: '/bin' });
    expect(childEnv).toEqual({ PATH: '/bin' });
    expect('DOCKER_HOST' in childEnv).toBe(false);
    expect('HOME' in childEnv).toBe(false);
  });
});

describe('buildCommand — child env hygiene (Finding 2)', () => {
  // Default test env: BUILD_RUNNER_MODE=stub → buildCommand takes the
  // kaniko-executor branch (the prod path). The global test setup seeds
  // process.env with DATABASE_URL / JWT_SECRET / COOKIE_SECRET / DATA_ENC_KEY,
  // so this proves the real worker secrets don't leak into the spawned child.
  const base: KanikoOptions = {
    contextDir: '/var/builds/b1/repo',
    authDir: '/var/builds/b1/auth',
    dockerfile: '/var/builds/b1/repo/.prodstack.Dockerfile',
    destinations: ['acr.azurecr.io/app:sha'],
    onLine: () => {},
    timeoutMs: 1000,
  };

  it('hands the kaniko executor DOCKER_CONFIG + PATH but NONE of the platform secrets on process.env', () => {
    const { env: childEnv } = buildCommand(base, '/var/builds/b1/auth/.docker');

    expect(childEnv.DOCKER_CONFIG).toBe('/var/builds/b1/auth/.docker');
    expect(childEnv.PATH).toBeDefined();

    // The worker secrets the global setup put on process.env must NOT reach the
    // untrusted user-Dockerfile build.
    expect(childEnv.DATABASE_URL).toBeUndefined();
    expect(childEnv.JWT_SECRET).toBeUndefined();
    expect(childEnv.COOKIE_SECRET).toBeUndefined();
    expect(childEnv.DATA_ENC_KEY).toBeUndefined();

    // Not the full process.env (guards against a regression to `{...process.env}`).
    expect(childEnv).not.toBe(process.env);
  });
});

describe('cacheOrSnapshotFlags', () => {
  it('emits --single-snapshot and no cache flags when cache is unset', () => {
    expect(cacheOrSnapshotFlags(undefined)).toEqual(['--single-snapshot']);
  });

  it('emits --cache flags and drops --single-snapshot when cache is set', () => {
    expect(
      cacheOrSnapshotFlags({ repo: 'acr.azurecr.io/buildcache/p1', ttl: '168h' }),
    ).toEqual([
      '--cache=true',
      '--cache-repo=acr.azurecr.io/buildcache/p1',
      '--cache-ttl=168h',
    ]);
  });
});

describe('buildCommand — layer cache', () => {
  // Same default test env as above: BUILD_RUNNER_MODE=stub → kaniko-executor
  // branch. Both runner modes spread the shared cacheOrSnapshotFlags() helper,
  // so the argv shape proven here is identical in docker mode.
  const base: KanikoOptions = {
    contextDir: '/var/builds/b1/repo',
    authDir: '/var/builds/b1/auth',
    dockerfile: '/var/builds/b1/repo/.prodstack.Dockerfile',
    destinations: ['acr.azurecr.io/app:sha'],
    onLine: () => {},
    timeoutMs: 1000,
  };

  it('keeps --single-snapshot and emits no cache flags when cache is unset', () => {
    const { args } = buildCommand(base, '/var/builds/b1/auth/.docker');
    expect(args).toContain('--single-snapshot');
    expect(args.some((a) => a.startsWith('--cache'))).toBe(false);
  });

  it('adds --cache flags and drops --single-snapshot when cache is set', () => {
    const { args } = buildCommand(
      { ...base, cache: { repo: 'acr.azurecr.io/buildcache/p1', ttl: '168h' } },
      '/var/builds/b1/auth/.docker',
    );
    expect(args).toContain('--cache=true');
    expect(args).toContain('--cache-repo=acr.azurecr.io/buildcache/p1');
    expect(args).toContain('--cache-ttl=168h');
    expect(args).not.toContain('--single-snapshot');
    // Cache flags sit before the destinations, like the build-args do.
    const cacheIdx = args.indexOf('--cache=true');
    const destIdx = args.indexOf('--destination=acr.azurecr.io/app:sha');
    expect(destIdx).toBeGreaterThan(cacheIdx);
  });
});
