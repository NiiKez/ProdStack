import { describe, expect, it } from 'vitest';

import {
  buildArgFlags,
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
