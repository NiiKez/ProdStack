process.env.NODE_ENV = 'test';
process.env.DATA_ENC_KEY ??= Buffer.alloc(32, 9).toString('base64');
process.env.JWT_SECRET ??= 'x'.repeat(40);
process.env.COOKIE_SECRET ??= 'y'.repeat(40);
process.env.WEB_ORIGIN ??= 'http://localhost:5173';
process.env.GITHUB_OAUTH_CLIENT_ID ??= 'cid';
process.env.GITHUB_OAUTH_CLIENT_SECRET ??= 'csecret';
process.env.GITHUB_OAUTH_CALLBACK_URL ??= 'http://localhost:3000/api/auth/github/callback';
process.env.DATABASE_URL ??= 'postgresql://test/test';
process.env.LOG_LEVEL ??= 'silent';
// Force real-branch path through the SDK mocks below.
process.env.AZURE_STUB = 'false';
process.env.AZURE_SUBSCRIPTION_ID = 'sub-test';
process.env.AZURE_RESOURCE_GROUP = 'prodstack';
process.env.AZURE_REGION = 'francecentral';
process.env.CONTAINER_APPS_ENV_ID =
  '/subscriptions/sub-test/resourceGroups/prodstack/providers/Microsoft.App/managedEnvironments/prodstack-env';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  beginCreateOrUpdateAndWait: vi.fn(),
  beginCreateOrUpdate: vi.fn(),
  beginDeleteAndWait: vi.fn(),
  beginStopAndWait: vi.fn(),
  beginStartAndWait: vi.fn(),
  get: vi.fn(),
  listSecrets: vi.fn(),
  DefaultAzureCredential: vi.fn(),
  ContainerAppsAPIClient: vi.fn(),
}));

vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: mocks.DefaultAzureCredential,
}));

vi.mock('@azure/arm-appcontainers', () => ({
  ContainerAppsAPIClient: mocks.ContainerAppsAPIClient,
}));

beforeEach(() => {
  vi.resetModules();
  mocks.beginCreateOrUpdateAndWait.mockReset();
  mocks.beginCreateOrUpdate.mockReset();
  mocks.beginDeleteAndWait.mockReset();
  mocks.beginStopAndWait.mockReset();
  mocks.beginStartAndWait.mockReset();
  mocks.get.mockReset();
  mocks.listSecrets.mockReset();
  mocks.DefaultAzureCredential.mockReset();
  mocks.ContainerAppsAPIClient.mockReset();

  // Regular `function` (not an arrow): these mocks are invoked with `new` in
  // the source (`new DefaultAzureCredential()`, `new ContainerAppsAPIClient()`),
  // and vitest 4 refuses to construct an arrow-function mock implementation.
  mocks.DefaultAzureCredential.mockImplementation(function () {
    return { kind: 'default-cred' };
  });
  // Default: app has no pre-existing secrets. Individual tests override.
  mocks.listSecrets.mockResolvedValue({ value: [] });
  mocks.ContainerAppsAPIClient.mockImplementation(function () {
    return {
      containerApps: {
        beginCreateOrUpdateAndWait: mocks.beginCreateOrUpdateAndWait,
        beginCreateOrUpdate: mocks.beginCreateOrUpdate,
        beginDeleteAndWait: mocks.beginDeleteAndWait,
        beginStopAndWait: mocks.beginStopAndWait,
        beginStartAndWait: mocks.beginStartAndWait,
        get: mocks.get,
        listSecrets: mocks.listSecrets,
      },
    };
  });
});

describe('createContainerApp (real branch)', () => {
  it('PUTs a typed envelope and returns the FQDN from the response', async () => {
    mocks.beginCreateOrUpdateAndWait.mockResolvedValue({
      configuration: { ingress: { fqdn: 'octocat-demo.example.azurecontainerapps.io' } },
    });

    const { createContainerApp } = await import('./containerApps.js');
    const ref = await createContainerApp({ name: 'octocat-demo' });

    expect(ref).toEqual({
      name: 'octocat-demo',
      liveUrl: 'https://octocat-demo.example.azurecontainerapps.io',
    });

    expect(mocks.ContainerAppsAPIClient).toHaveBeenCalledWith(
      { kind: 'default-cred' },
      'sub-test',
    );
    expect(mocks.beginCreateOrUpdateAndWait).toHaveBeenCalledTimes(1);
    const [rg, name, envelope] = mocks.beginCreateOrUpdateAndWait.mock.calls[0]!;
    expect(rg).toBe('prodstack');
    expect(name).toBe('octocat-demo');
    expect(envelope).toMatchObject({
      location: 'francecentral',
      environmentId: process.env.CONTAINER_APPS_ENV_ID,
      configuration: {
        ingress: { external: true, targetPort: 80, transport: 'auto' },
      },
      template: {
        containers: [
          {
            name: 'octocat-demo',
            image: 'mcr.microsoft.com/k8se/quickstart:latest',
          },
        ],
        scale: { minReplicas: 0, maxReplicas: 2 },
      },
    });
  });

  it('falls back to a synthetic live URL when the SDK omits an FQDN', async () => {
    mocks.beginCreateOrUpdateAndWait.mockResolvedValue({});
    const { createContainerApp } = await import('./containerApps.js');
    const ref = await createContainerApp({ name: 'no-fqdn' });
    expect(ref.liveUrl).toBe('https://no-fqdn.unknown.azurecontainerapps.io');
  });

  it('rejects invalid Container App names before calling the SDK', async () => {
    const { createContainerApp } = await import('./containerApps.js');
    await expect(createContainerApp({ name: 'UPPER' })).rejects.toThrow(
      /Invalid Container App name/,
    );
    expect(mocks.beginCreateOrUpdateAndWait).not.toHaveBeenCalled();
  });

  it('throws a useful error when AZURE_SUBSCRIPTION_ID is missing', async () => {
    process.env.AZURE_SUBSCRIPTION_ID = '';
    const { createContainerApp } = await import('./containerApps.js');
    await expect(createContainerApp({ name: 'demo' })).rejects.toThrow(
      /AZURE_SUBSCRIPTION_ID not configured/,
    );
    process.env.AZURE_SUBSCRIPTION_ID = 'sub-test';
  });
});

describe('deleteContainerApp (real branch)', () => {
  it('calls beginDeleteAndWait with the resource group and name', async () => {
    mocks.beginDeleteAndWait.mockResolvedValue(undefined);
    const { deleteContainerApp } = await import('./containerApps.js');
    await deleteContainerApp('octocat-demo');
    expect(mocks.beginDeleteAndWait).toHaveBeenCalledWith('prodstack', 'octocat-demo');
  });
});

describe('stopContainerApp / startContainerApp (real branch)', () => {
  it('stopContainerApp calls beginStopAndWait with the resource group and name', async () => {
    mocks.beginStopAndWait.mockResolvedValue({});
    const { stopContainerApp } = await import('./containerApps.js');
    await stopContainerApp('octocat-demo');
    expect(mocks.beginStopAndWait).toHaveBeenCalledWith('prodstack', 'octocat-demo');
    // A stop must never roll/modify a revision (no create-or-update PUT).
    expect(mocks.beginCreateOrUpdateAndWait).not.toHaveBeenCalled();
  });

  it('startContainerApp calls beginStartAndWait with the resource group and name', async () => {
    mocks.beginStartAndWait.mockResolvedValue({});
    const { startContainerApp } = await import('./containerApps.js');
    await startContainerApp('octocat-demo');
    expect(mocks.beginStartAndWait).toHaveBeenCalledWith('prodstack', 'octocat-demo');
    expect(mocks.beginCreateOrUpdateAndWait).not.toHaveBeenCalled();
  });

  it('rejects an invalid app name before any SDK call', async () => {
    const { stopContainerApp, startContainerApp } = await import('./containerApps.js');
    await expect(stopContainerApp('Bad Name!')).rejects.toThrow();
    await expect(startContainerApp('Bad Name!')).rejects.toThrow();
    expect(mocks.beginStopAndWait).not.toHaveBeenCalled();
    expect(mocks.beginStartAndWait).not.toHaveBeenCalled();
  });
});

describe('env vars surfaced as Container App secrets', () => {
  it('createContainerApp maps env vars to secrets + secretRef (no plaintext value)', async () => {
    mocks.beginCreateOrUpdateAndWait.mockResolvedValue({
      configuration: { ingress: { fqdn: 'demo.example.azurecontainerapps.io' } },
      latestRevisionName: 'demo--abc123',
    });

    const { createContainerApp } = await import('./containerApps.js');
    const ref = await createContainerApp({
      name: 'octocat-demo',
      envVars: [{ name: 'API_KEY', value: 'super-secret' }],
    });

    expect(ref.revisionName).toBe('demo--abc123');

    const [, , envelope] = mocks.beginCreateOrUpdateAndWait.mock.calls[0]!;
    const secrets = envelope.configuration.secrets as Array<{ name: string; value: string }>;
    const containerEnv = envelope.template.containers[0].env as Array<{
      name: string;
      value?: string;
      secretRef?: string;
    }>;

    expect(secrets).toHaveLength(1);
    expect(secrets[0]!.value).toBe('super-secret');
    expect(secrets[0]!.name).toMatch(/^env-api-key-[0-9a-f]{8}$/);
    expect(containerEnv).toEqual([{ name: 'API_KEY', secretRef: secrets[0]!.name }]);
    // The plaintext value must never appear as a container env value.
    expect(containerEnv[0]!.value).toBeUndefined();
  });

  it('updateContainerApp merges env secrets onto the existing app and returns the new revision', async () => {
    mocks.get.mockResolvedValue({
      location: 'francecentral',
      environmentId: process.env.CONTAINER_APPS_ENV_ID,
      configuration: { ingress: { external: true, targetPort: 80 }, secrets: [] },
      template: { containers: [{ name: 'octocat-demo', image: 'old:tag' }], scale: {} },
    });
    mocks.beginCreateOrUpdateAndWait.mockResolvedValue({
      configuration: { ingress: { fqdn: 'demo.example.azurecontainerapps.io' } },
      latestRevisionName: 'demo--rev2',
    });

    const { updateContainerApp } = await import('./containerApps.js');
    const ref = await updateContainerApp({
      name: 'octocat-demo',
      image: 'new:tag',
      envVars: [{ name: 'FOO', value: 'bar' }],
    });

    expect(ref.revisionName).toBe('demo--rev2');
    const [, , envelope] = mocks.beginCreateOrUpdateAndWait.mock.calls[0]!;
    expect(envelope.template.containers[0].image).toBe('new:tag');
    expect((envelope.configuration.secrets as unknown[]).length).toBe(1);
    expect(envelope.template.containers[0].env).toEqual([
      { name: 'FOO', secretRef: (envelope.configuration.secrets as Array<{ name: string }>)[0]!.name },
    ]);
  });

  it('updateContainerApp preserves non-env secrets when applying env vars', async () => {
    mocks.get.mockResolvedValue({
      location: 'francecentral',
      environmentId: process.env.CONTAINER_APPS_ENV_ID,
      // `get` returns secret names without values.
      configuration: {
        ingress: { external: true, targetPort: 80 },
        secrets: [{ name: 'registry-password' }, { name: 'env-old-deadbeef' }],
        registries: [{ server: 'prodstack.azurecr.io', passwordSecretRef: 'registry-password' }],
      },
      template: { containers: [{ name: 'demo', image: 'old:tag' }], scale: {} },
    });
    // `listSecrets` returns the real values we must round-trip.
    mocks.listSecrets.mockResolvedValue({
      value: [
        { name: 'registry-password', value: 'acr-pw' },
        { name: 'env-old-deadbeef', value: 'stale' },
      ],
    });
    mocks.beginCreateOrUpdateAndWait.mockResolvedValue({
      configuration: { ingress: { fqdn: 'demo.example.azurecontainerapps.io' } },
      latestRevisionName: 'demo--rev3',
    });

    const { updateContainerApp } = await import('./containerApps.js');
    await updateContainerApp({ name: 'demo', image: 'new:tag', envVars: [{ name: 'FOO', value: 'bar' }] });

    const [, , envelope] = mocks.beginCreateOrUpdateAndWait.mock.calls[0]!;
    const secrets = envelope.configuration.secrets as Array<{ name: string; value?: string }>;
    // Registry password preserved verbatim; the stale env- secret is dropped
    // and replaced by the current env var's secret.
    expect(secrets).toContainEqual({ name: 'registry-password', value: 'acr-pw' });
    expect(secrets.some((s) => s.name === 'env-old-deadbeef')).toBe(false);
    expect(secrets.some((s) => s.name.startsWith('env-foo-') && s.value === 'bar')).toBe(true);
    // Registry binding survives so the next image pull still authenticates.
    expect(envelope.configuration.registries).toEqual([
      { server: 'prodstack.azurecr.io', passwordSecretRef: 'registry-password' },
    ]);
  });

  it('updateContainerApp leaves env + secrets untouched on a plain image roll', async () => {
    mocks.get.mockResolvedValue({
      configuration: { ingress: {}, secrets: [{ name: 'env-keep-1234abcd', value: 'x' }] },
      template: {
        containers: [
          { name: 'demo', image: 'old', env: [{ name: 'KEEP', secretRef: 'env-keep-1234abcd' }] },
        ],
      },
    });
    mocks.beginCreateOrUpdateAndWait.mockResolvedValue({ configuration: { ingress: {} } });

    const { updateContainerApp } = await import('./containerApps.js');
    await updateContainerApp({ name: 'demo', image: 'new' });

    const [, , envelope] = mocks.beginCreateOrUpdateAndWait.mock.calls[0]!;
    expect(envelope.template.containers[0].image).toBe('new');
    // No envVars passed → existing secrets + env preserved.
    expect(envelope.configuration.secrets).toEqual([{ name: 'env-keep-1234abcd', value: 'x' }]);
    expect(envelope.template.containers[0].env).toEqual([
      { name: 'KEEP', secretRef: 'env-keep-1234abcd' },
    ]);
  });
});

describe('forceNewRevision (env-redeploy rolls a fresh revision)', () => {
  const existingApp = (latestRevisionName: string) => ({
    location: 'francecentral',
    environmentId: process.env.CONTAINER_APPS_ENV_ID,
    latestRevisionName,
    configuration: { ingress: { external: true, targetPort: 80 }, secrets: [] },
    template: { containers: [{ name: 'demo', image: 'img:tag' }], scale: {} },
  });

  it('stamps a content-addressed revisionSuffix when forceNewRevision is set', async () => {
    mocks.get.mockResolvedValue(existingApp('demo--0000001'));
    mocks.beginCreateOrUpdateAndWait.mockResolvedValue({
      configuration: { ingress: {} },
      latestRevisionName: 'demo--cfg',
    });

    const { updateContainerApp } = await import('./containerApps.js');
    await updateContainerApp({
      name: 'demo',
      image: 'img:tag',
      envVars: [{ name: 'SITE_PASSWORD', value: 'hunter2' }],
      forceNewRevision: true,
    });

    const [, , envelope] = mocks.beginCreateOrUpdateAndWait.mock.calls[0]!;
    // A valid ACA revision suffix: lowercase alphanumeric, here `cfg` + 12 hex.
    expect(envelope.template.revisionSuffix).toMatch(/^cfg[0-9a-f]{12}$/);
  });

  it('blanks the revisionSuffix without the flag (so ACA auto-generates a fresh one)', async () => {
    mocks.get.mockResolvedValue(existingApp('demo--0000001'));
    mocks.beginCreateOrUpdateAndWait.mockResolvedValue({ configuration: { ingress: {} } });

    const { updateContainerApp } = await import('./containerApps.js');
    await updateContainerApp({
      name: 'demo',
      image: 'img:tag',
      envVars: [{ name: 'SITE_PASSWORD', value: 'hunter2' }],
    });

    const [, , envelope] = mocks.beginCreateOrUpdateAndWait.mock.calls[0]!;
    // Empty string ≡ unset for ARM → ACA picks a unique suffix.
    expect(envelope.template.revisionSuffix).toBe('');
  });

  it('does NOT inherit an explicit suffix from the live revision on a plain roll', async () => {
    // Regression: a prior env-redeploy (or a manual `--revision-suffix`) leaves the
    // live revision created with an explicit suffix, which `get()` echoes back in
    // `template.revisionSuffix`. Re-PUTting it makes ARM reject the roll with
    // "revision with suffix <x> already exists" — wedging every future build deploy.
    // A plain image roll must blank it, not carry it over.
    mocks.get.mockResolvedValue({
      ...existingApp('demo--cfg9950b2a7451b'),
      template: {
        containers: [{ name: 'demo', image: 'old:tag' }],
        scale: {},
        revisionSuffix: 'cfg9950b2a7451b',
      },
    });
    mocks.beginCreateOrUpdateAndWait.mockResolvedValue({ configuration: { ingress: {} } });

    const { updateContainerApp } = await import('./containerApps.js');
    await updateContainerApp({ name: 'demo', image: 'new:tag' });

    const [, , envelope] = mocks.beginCreateOrUpdateAndWait.mock.calls[0]!;
    expect(envelope.template.revisionSuffix).toBe('');
    expect(envelope.template.revisionSuffix).not.toBe('cfg9950b2a7451b');
  });

  it('changes the suffix when an env value changes (so the rotation actually rolls)', async () => {
    const suffixFor = async (value: string): Promise<string> => {
      mocks.beginCreateOrUpdateAndWait.mockReset();
      mocks.get.mockResolvedValue(existingApp('demo--0000001'));
      mocks.beginCreateOrUpdateAndWait.mockResolvedValue({ configuration: { ingress: {} } });
      const { updateContainerApp } = await import('./containerApps.js');
      await updateContainerApp({
        name: 'demo',
        image: 'img:tag',
        envVars: [{ name: 'SITE_PASSWORD', value }],
        forceNewRevision: true,
      });
      const [, , envelope] = mocks.beginCreateOrUpdateAndWait.mock.calls[0]!;
      return envelope.template.revisionSuffix as string;
    };

    const a = await suffixFor('old-password');
    const b = await suffixFor('new-password');
    expect(a).not.toBe(b);
  });

  it('stays unique on an A→B→A revert by salting with the current revision name', async () => {
    // Same env value, but the app has rolled to a new latest revision in between
    // — the salt must make the suffix differ so ACA does not reject reusing a
    // historical revision name.
    const suffixWithRevision = async (rev: string): Promise<string> => {
      mocks.beginCreateOrUpdateAndWait.mockReset();
      mocks.get.mockResolvedValue(existingApp(rev));
      mocks.beginCreateOrUpdateAndWait.mockResolvedValue({ configuration: { ingress: {} } });
      const { updateContainerApp } = await import('./containerApps.js');
      await updateContainerApp({
        name: 'demo',
        image: 'img:tag',
        envVars: [{ name: 'SITE_PASSWORD', value: 'same' }],
        forceNewRevision: true,
      });
      const [, , envelope] = mocks.beginCreateOrUpdateAndWait.mock.calls[0]!;
      return envelope.template.revisionSuffix as string;
    };

    const first = await suffixWithRevision('demo--cfgaaaaaaaaaaaa');
    const second = await suffixWithRevision('demo--cfgbbbbbbbbbbbb');
    expect(first).not.toBe(second);
  });
});

describe('ingress targetPort on update (zero-Dockerfile auto-build)', () => {
  it('re-points ingress to the requested port, preserving the other ingress fields', async () => {
    mocks.get.mockResolvedValue({
      location: 'francecentral',
      environmentId: process.env.CONTAINER_APPS_ENV_ID,
      configuration: {
        ingress: {
          external: true,
          targetPort: 80,
          transport: 'auto',
          fqdn: 'demo.example.azurecontainerapps.io',
        },
        secrets: [],
      },
      template: { containers: [{ name: 'demo', image: 'old' }], scale: {} },
    });
    mocks.beginCreateOrUpdateAndWait.mockResolvedValue({
      configuration: { ingress: { fqdn: 'demo.example.azurecontainerapps.io' } },
      latestRevisionName: 'demo--rev9',
    });

    const { updateContainerApp } = await import('./containerApps.js');
    await updateContainerApp({ name: 'demo', image: 'new:tag', targetPort: 3000 });

    const [, , envelope] = mocks.beginCreateOrUpdateAndWait.mock.calls[0]!;
    // Only targetPort changes; external/transport/fqdn are preserved.
    expect(envelope.configuration.ingress).toEqual({
      external: true,
      targetPort: 3000,
      transport: 'auto',
      fqdn: 'demo.example.azurecontainerapps.io',
    });
    expect(envelope.template.containers[0].image).toBe('new:tag');
  });

  it('does not blank a plain-value secret on a port-only change', async () => {
    mocks.get.mockResolvedValue({
      location: 'francecentral',
      environmentId: process.env.CONTAINER_APPS_ENV_ID,
      // get() returns the secret name WITHOUT its value.
      configuration: {
        ingress: { external: true, targetPort: 80 },
        secrets: [{ name: 'some-literal' }],
      },
      template: { containers: [{ name: 'demo', image: 'old' }], scale: {} },
    });
    mocks.listSecrets.mockResolvedValue({ value: [{ name: 'some-literal', value: 'keepme' }] });
    mocks.beginCreateOrUpdateAndWait.mockResolvedValue({
      configuration: { ingress: {} },
      latestRevisionName: 'r',
    });

    const { updateContainerApp } = await import('./containerApps.js');
    // No envVars, no image — purely a port change. The configuration block is
    // still re-PUT, so secrets must round-trip via listSecrets, not get().
    await updateContainerApp({ name: 'demo', targetPort: 8080 });

    expect(mocks.listSecrets).toHaveBeenCalledTimes(1);
    const [, , envelope] = mocks.beginCreateOrUpdateAndWait.mock.calls[0]!;
    expect(envelope.configuration.ingress.targetPort).toBe(8080);
    const secrets = envelope.configuration.secrets as Array<{ name: string; value?: string }>;
    expect(secrets).toContainEqual({ name: 'some-literal', value: 'keepme' });
  });
});

describe('ACR pull auth (private-registry credentials on user apps)', () => {
  // env is parsed once per module load; `vi.resetModules()` in the top-level
  // beforeEach lets us re-import with these set so `acrPullAuth()` activates.
  beforeEach(() => {
    process.env.ACR_NAME = 'prodstack';
    process.env.ACR_USERNAME = 'prodstack';
    process.env.ACR_PASSWORD = 'acr-pw';
  });
  afterEach(() => {
    delete process.env.ACR_NAME;
    delete process.env.ACR_USERNAME;
    delete process.env.ACR_PASSWORD;
  });

  const EXPECTED_REGISTRY = {
    server: 'prodstack.azurecr.io',
    username: 'prodstack',
    passwordSecretRef: 'acr-pull-password',
  };

  it('createContainerApp wires the ACR registry + pull secret so the first roll can pull', async () => {
    mocks.beginCreateOrUpdateAndWait.mockResolvedValue({
      configuration: { ingress: { fqdn: 'demo.example.azurecontainerapps.io' } },
    });

    const { createContainerApp } = await import('./containerApps.js');
    await createContainerApp({ name: 'octocat-demo' });

    const [, , envelope] = mocks.beginCreateOrUpdateAndWait.mock.calls[0]!;
    expect(envelope.configuration.registries).toEqual([EXPECTED_REGISTRY]);
    expect(envelope.configuration.secrets).toContainEqual({
      name: 'acr-pull-password',
      value: 'acr-pw',
    });
  });

  it('updateContainerApp repairs a missing registry on roll and preserves live secret values', async () => {
    // App provisioned before pull-auth wiring: no registries, plus a non-env secret.
    mocks.get.mockResolvedValue({
      location: 'francecentral',
      environmentId: process.env.CONTAINER_APPS_ENV_ID,
      configuration: { ingress: { external: true, targetPort: 80 }, secrets: [{ name: 'other' }] },
      template: { containers: [{ name: 'octocat-demo', image: 'old' }], scale: {} },
    });
    mocks.listSecrets.mockResolvedValue({ value: [{ name: 'other', value: 'keep' }] });
    mocks.beginCreateOrUpdateAndWait.mockResolvedValue({
      configuration: { ingress: { fqdn: 'demo.example.azurecontainerapps.io' } },
      latestRevisionName: 'demo--rev2',
    });

    const { updateContainerApp } = await import('./containerApps.js');
    await updateContainerApp({
      name: 'octocat-demo',
      image: 'prodstack.azurecr.io/octocat-demo:sha',
      envVars: [],
    });

    const [, , envelope] = mocks.beginCreateOrUpdateAndWait.mock.calls[0]!;
    const secrets = envelope.configuration.secrets as Array<{ name: string; value?: string }>;
    expect(envelope.configuration.registries).toEqual([EXPECTED_REGISTRY]);
    // Existing secret round-trips with its real value (not blanked), acr secret added.
    expect(secrets).toContainEqual({ name: 'other', value: 'keep' });
    expect(secrets).toContainEqual({ name: 'acr-pull-password', value: 'acr-pw' });
    expect(envelope.template.containers[0].image).toBe('prodstack.azurecr.io/octocat-demo:sha');
  });

  it('updateContainerApp does not duplicate a registry/secret that already exists', async () => {
    mocks.get.mockResolvedValue({
      location: 'francecentral',
      environmentId: process.env.CONTAINER_APPS_ENV_ID,
      configuration: {
        ingress: { external: true, targetPort: 80 },
        secrets: [{ name: 'acr-pull-password' }],
        registries: [EXPECTED_REGISTRY],
      },
      template: { containers: [{ name: 'octocat-demo', image: 'old' }], scale: {} },
    });
    mocks.listSecrets.mockResolvedValue({ value: [{ name: 'acr-pull-password', value: 'acr-pw' }] });
    mocks.beginCreateOrUpdateAndWait.mockResolvedValue({
      configuration: { ingress: { fqdn: 'demo.example.azurecontainerapps.io' } },
      latestRevisionName: 'demo--rev3',
    });

    const { updateContainerApp } = await import('./containerApps.js');
    await updateContainerApp({
      name: 'octocat-demo',
      image: 'prodstack.azurecr.io/octocat-demo:sha',
      envVars: [],
    });

    const [, , envelope] = mocks.beginCreateOrUpdateAndWait.mock.calls[0]!;
    const secrets = envelope.configuration.secrets as Array<{ name: string }>;
    expect(envelope.configuration.registries).toHaveLength(1);
    expect(secrets.filter((s) => s.name === 'acr-pull-password')).toHaveLength(1);
  });
});

describe('rollPlatformApp (real branch — M6 CI/CD self-deploy)', () => {
  it('re-supplies live secret values so a plain-value secret is not blanked on roll', async () => {
    // `get` returns secret names with KV-ref metadata but NO value for literal
    // secrets (acr-username/-password) — replaying these verbatim is exactly
    // what triggered the ContainerAppSecretInvalid 400 in prod on app=api.
    mocks.get.mockResolvedValue({
      location: 'francecentral',
      environmentId: process.env.CONTAINER_APPS_ENV_ID,
      configuration: {
        ingress: {
          external: true,
          targetPort: 3000,
          fqdn: 'prodstack-api.example.azurecontainerapps.io',
        },
        secrets: [
          {
            name: 'database-url',
            keyVaultUrl: 'https://kv.vault.azure.net/secrets/database-url',
            identity: 'system',
          },
          { name: 'acr-username' },
          { name: 'acr-password' },
        ],
      },
      template: {
        containers: [{ name: 'prodstack-api', image: 'prodstack.azurecr.io/prodstack-api:old' }],
        scale: { minReplicas: 1, maxReplicas: 1 },
      },
    });
    // `listSecrets` returns the real values; Key Vault refs keep their
    // keyVaultUrl+identity so they round-trip as refs, not literals.
    mocks.listSecrets.mockResolvedValue({
      value: [
        {
          name: 'database-url',
          keyVaultUrl: 'https://kv.vault.azure.net/secrets/database-url',
          identity: 'system',
        },
        { name: 'acr-username', value: 'prodstack' },
        { name: 'acr-password', value: 'pw-123' },
      ],
    });
    mocks.beginCreateOrUpdate.mockResolvedValue({});

    const { rollPlatformApp } = await import('./containerApps.js');
    const ref = await rollPlatformApp({
      name: 'prodstack-api',
      image: 'prodstack.azurecr.io/prodstack-api:newsha',
    });

    expect(mocks.beginCreateOrUpdate).toHaveBeenCalledTimes(1);
    const [rg, name, envelope] = mocks.beginCreateOrUpdate.mock.calls[0]!;
    expect(rg).toBe('prodstack');
    expect(name).toBe('prodstack-api');
    expect(envelope.template.containers[0].image).toBe(
      'prodstack.azurecr.io/prodstack-api:newsha',
    );
    const secrets = envelope.configuration.secrets as Array<{
      name: string;
      value?: string;
      keyVaultUrl?: string;
      identity?: string;
    }>;
    // Plain secrets carry their real value (NOT blanked) → no 400.
    expect(secrets).toContainEqual({ name: 'acr-username', value: 'prodstack' });
    expect(secrets).toContainEqual({ name: 'acr-password', value: 'pw-123' });
    // KV ref preserved as a reference (never converted to a literal value).
    expect(secrets).toContainEqual({
      name: 'database-url',
      keyVaultUrl: 'https://kv.vault.azure.net/secrets/database-url',
      identity: 'system',
    });
    expect(ref.liveUrl).toBe('https://prodstack-api.example.azurecontainerapps.io');
  });

  it('overrides a stale pinned revisionSuffix so the async roll cannot collide', async () => {
    // Reproduces the silent CI-deploy no-op: the live revision was created by a
    // manual roll with an explicit suffix (`demoon1`), so `get()` returns it on
    // `template.revisionSuffix`. Replaying it would make ARM accept the PUT but
    // fail provisioning ("revision with suffix demoon1 already exists"). The roll
    // must stamp a FRESH suffix instead of inheriting the stale one.
    mocks.get.mockResolvedValue({
      location: 'francecentral',
      environmentId: process.env.CONTAINER_APPS_ENV_ID,
      latestRevisionName: 'prodstack-api--demoon1',
      configuration: {
        ingress: { external: true, targetPort: 3000, fqdn: 'prodstack-api.example.azurecontainerapps.io' },
      },
      template: {
        revisionSuffix: 'demoon1',
        containers: [{ name: 'prodstack-api', image: 'prodstack.azurecr.io/prodstack-api:old' }],
      },
    });
    mocks.listSecrets.mockResolvedValue({ value: [] });
    mocks.beginCreateOrUpdate.mockResolvedValue({});

    const { rollPlatformApp } = await import('./containerApps.js');
    await rollPlatformApp({ name: 'prodstack-api', image: 'prodstack.azurecr.io/prodstack-api:newsha' });

    const [, , envelope] = mocks.beginCreateOrUpdate.mock.calls[0]!;
    expect(envelope.template.revisionSuffix).not.toBe('demoon1');
    expect(envelope.template.revisionSuffix).toMatch(/^roll[0-9a-f]{12}$/);
  });

  it('derives a different suffix once the latest revision advances (same image redeploy)', async () => {
    const rollWith = async (latestRevisionName: string): Promise<string> => {
      mocks.get.mockResolvedValue({
        location: 'francecentral',
        environmentId: process.env.CONTAINER_APPS_ENV_ID,
        latestRevisionName,
        configuration: { ingress: { external: true, targetPort: 3000, fqdn: 'x.example.azurecontainerapps.io' } },
        template: { containers: [{ name: 'prodstack-api', image: 'prodstack.azurecr.io/prodstack-api:old' }] },
      });
      mocks.listSecrets.mockResolvedValue({ value: [] });
      mocks.beginCreateOrUpdate.mockReset();
      mocks.beginCreateOrUpdate.mockResolvedValue({});
      const { rollPlatformApp } = await import('./containerApps.js');
      // Same image both times — only the live revision name differs (as it does
      // after a successful roll), which must still produce a unique suffix.
      await rollPlatformApp({ name: 'prodstack-api', image: 'prodstack.azurecr.io/prodstack-api:samesha' });
      return mocks.beginCreateOrUpdate.mock.calls[0]![2].template.revisionSuffix as string;
    };

    const first = await rollWith('prodstack-api--demoon1');
    const second = await rollWith('prodstack-api--roll-after-first');
    expect(first).not.toBe(second);
  });

  it('refuses to roll a Container App outside the platform allow-list', async () => {
    const { rollPlatformApp } = await import('./containerApps.js');
    await expect(
      rollPlatformApp({ name: 'octocat-demo', image: 'prodstack.azurecr.io/x:y' }),
    ).rejects.toThrow(/not a platform Container App/);
    expect(mocks.beginCreateOrUpdate).not.toHaveBeenCalled();
  });
});
