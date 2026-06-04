import { describe, expect, it } from 'vitest';

import { buildArgFlags, buildCommand, type KanikoOptions } from './kaniko.js';

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
