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

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  beginCreateOrUpdateAndWait: vi.fn(),
  beginDeleteAndWait: vi.fn(),
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
  mocks.beginDeleteAndWait.mockReset();
  mocks.get.mockReset();
  mocks.listSecrets.mockReset();
  mocks.DefaultAzureCredential.mockReset();
  mocks.ContainerAppsAPIClient.mockReset();

  mocks.DefaultAzureCredential.mockImplementation(() => ({ kind: 'default-cred' }));
  // Default: app has no pre-existing secrets. Individual tests override.
  mocks.listSecrets.mockResolvedValue({ value: [] });
  mocks.ContainerAppsAPIClient.mockImplementation(() => ({
    containerApps: {
      beginCreateOrUpdateAndWait: mocks.beginCreateOrUpdateAndWait,
      beginDeleteAndWait: mocks.beginDeleteAndWait,
      get: mocks.get,
      listSecrets: mocks.listSecrets,
    },
  }));
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
