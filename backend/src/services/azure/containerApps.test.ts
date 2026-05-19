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
  mocks.DefaultAzureCredential.mockReset();
  mocks.ContainerAppsAPIClient.mockReset();

  mocks.DefaultAzureCredential.mockImplementation(() => ({ kind: 'default-cred' }));
  mocks.ContainerAppsAPIClient.mockImplementation(() => ({
    containerApps: {
      beginCreateOrUpdateAndWait: mocks.beginCreateOrUpdateAndWait,
      beginDeleteAndWait: mocks.beginDeleteAndWait,
      get: mocks.get,
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
