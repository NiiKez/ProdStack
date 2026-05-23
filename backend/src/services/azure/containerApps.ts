/**
 * Azure Container Apps wrapper.
 *
 * Two implementations live behind a single contract:
 *
 *  - **Stub** (`AZURE_STUB=true`): logs structured calls and returns
 *    deterministic placeholder data. Used by tests and local dev so the
 *    project CRUD / webhook / build flow can exercise end-to-end without
 *    touching Azure.
 *
 *  - **Real** (`AZURE_STUB=false`): uses `@azure/arm-appcontainers` against
 *    the managed environment named by `CONTAINER_APPS_ENV_ID`. Credentials
 *    come from `DefaultAzureCredential` so the API picks up its system-
 *    assigned managed identity in production and falls through to az-CLI /
 *    env vars for local debugging — Service Principals aren't usable in the
 *    deployment tenant (see `CLAUDE.md`).
 *
 * The two branches share the public shape so callers (e.g. the Project
 * service) never need to know which is active beyond `isStub()`.
 */
import { ContainerAppsAPIClient, type ContainerApp } from '@azure/arm-appcontainers';
import { DefaultAzureCredential } from '@azure/identity';
import pino from 'pino';

import { env } from '../../env.js';

// --- Public contract -------------------------------------------------------

export interface ContainerAppRef {
  name: string;
  liveUrl: string;
}

export interface EnvVarInput {
  name: string;
  value: string;
}

export interface CreateContainerAppOpts {
  name: string;
  image?: string;
  targetPort?: number;
  envVars?: EnvVarInput[];
  minReplicas?: number;
  maxReplicas?: number;
}

export interface UpdateContainerAppOpts {
  name: string;
  image?: string;
  envVars?: EnvVarInput[];
}

// --- Constants -------------------------------------------------------------

const DEFAULT_IMAGE = 'mcr.microsoft.com/k8se/quickstart:latest';
const DEFAULT_TARGET_PORT = 80;
const DEFAULT_MIN_REPLICAS = 0; // scale-to-zero per SPEC §13
const DEFAULT_MAX_REPLICAS = 2;

/**
 * Azure Container Apps naming rules: 2–32 chars, lowercase alphanumeric
 * and hyphens, must start and end with alphanumeric.
 */
const CONTAINER_APP_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const CONTAINER_APP_NAME_MAX = 32;

function assertValidName(name: string): void {
  if (name.length > CONTAINER_APP_NAME_MAX || !CONTAINER_APP_NAME_RE.test(name)) {
    throw new Error(
      `Invalid Container App name: ${JSON.stringify(name)} ` +
        `(must be 1-32 lowercase alphanumeric/hyphen chars, ` +
        `starting and ending with alphanumeric)`,
    );
  }
}

function envVarKeys(envVars: EnvVarInput[] | undefined): string[] {
  return (envVars ?? []).map((e) => e.name);
}

// --- Stub branch -----------------------------------------------------------

const stubLog = pino({ name: 'azure-stub' });

const STUB_LIVE_URL = (name: string): string => `https://${name}.stub.prodstack.local`;
const STUB_DELAY_MS = 50;

const stubDelay = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, STUB_DELAY_MS));

async function stubCreate(opts: CreateContainerAppOpts): Promise<ContainerAppRef> {
  stubLog.info(
    {
      op: 'createContainerApp',
      name: opts.name,
      image: opts.image ?? DEFAULT_IMAGE,
      targetPort: opts.targetPort ?? DEFAULT_TARGET_PORT,
      envVarKeys: envVarKeys(opts.envVars),
      minReplicas: opts.minReplicas ?? DEFAULT_MIN_REPLICAS,
      maxReplicas: opts.maxReplicas ?? DEFAULT_MAX_REPLICAS,
    },
    'stub: create Container App',
  );
  await stubDelay();
  return { name: opts.name, liveUrl: STUB_LIVE_URL(opts.name) };
}

async function stubUpdate(opts: UpdateContainerAppOpts): Promise<ContainerAppRef> {
  stubLog.info(
    {
      op: 'updateContainerApp',
      name: opts.name,
      image: opts.image,
      envVarKeys: envVarKeys(opts.envVars),
    },
    'stub: update Container App',
  );
  await stubDelay();
  return { name: opts.name, liveUrl: STUB_LIVE_URL(opts.name) };
}

async function stubDelete(name: string): Promise<void> {
  stubLog.info({ op: 'deleteContainerApp', name }, 'stub: delete Container App');
  await stubDelay();
}

// --- Real branch -----------------------------------------------------------

let cachedClient: ContainerAppsAPIClient | undefined;

function requireSubscriptionId(): string {
  if (!env.AZURE_SUBSCRIPTION_ID) {
    throw new Error(
      'AZURE_SUBSCRIPTION_ID not configured — set AZURE_STUB=true for local dev',
    );
  }
  return env.AZURE_SUBSCRIPTION_ID;
}

function requireResourceGroup(): string {
  if (!env.AZURE_RESOURCE_GROUP) {
    throw new Error(
      'AZURE_RESOURCE_GROUP not configured — set AZURE_STUB=true for local dev',
    );
  }
  return env.AZURE_RESOURCE_GROUP;
}

function requireEnvironmentId(): string {
  if (!env.CONTAINER_APPS_ENV_ID) {
    throw new Error(
      'CONTAINER_APPS_ENV_ID not configured — set AZURE_STUB=true for local dev',
    );
  }
  return env.CONTAINER_APPS_ENV_ID;
}

function getClient(): ContainerAppsAPIClient {
  if (cachedClient) return cachedClient;

  const subscriptionId = requireSubscriptionId();
  cachedClient = new ContainerAppsAPIClient(new DefaultAzureCredential(), subscriptionId);
  return cachedClient;
}

function fqdnToLiveUrl(name: string, fqdn: string | undefined): string {
  return fqdn ? `https://${fqdn}` : `https://${name}.unknown.azurecontainerapps.io`;
}

function buildEnvelope(opts: CreateContainerAppOpts, environmentId: string): ContainerApp {
  return {
    location: env.AZURE_REGION,
    environmentId,
    configuration: {
      ingress: {
        external: true,
        targetPort: opts.targetPort ?? DEFAULT_TARGET_PORT,
        transport: 'auto',
      },
      secrets: [],
    },
    template: {
      containers: [
        {
          name: opts.name,
          image: opts.image ?? DEFAULT_IMAGE,
          env: opts.envVars,
        },
      ],
      scale: {
        minReplicas: opts.minReplicas ?? DEFAULT_MIN_REPLICAS,
        maxReplicas: opts.maxReplicas ?? DEFAULT_MAX_REPLICAS,
      },
    },
  };
}

async function realCreate(opts: CreateContainerAppOpts): Promise<ContainerAppRef> {
  const client = getClient();
  const resourceGroup = requireResourceGroup();
  const envelope = buildEnvelope(opts, requireEnvironmentId());

  const result = await client.containerApps.beginCreateOrUpdateAndWait(
    resourceGroup,
    opts.name,
    envelope,
  );

  return { name: opts.name, liveUrl: fqdnToLiveUrl(opts.name, result.configuration?.ingress?.fqdn) };
}

async function realUpdate(opts: UpdateContainerAppOpts): Promise<ContainerAppRef> {
  // TODO M3/M5: fetch the existing Container App, merge `template`
  // (image + env), and re-PUT via `beginCreateOrUpdateAndWait`. The
  // dedicated `beginUpdateAndWait` is intentionally avoided — its PATCH
  // semantics don't carry over the immutable `environmentId` / `location`
  // and quietly drop fields we don't echo back.
  const client = getClient();
  const resourceGroup = requireResourceGroup();

  const existing = await client.containerApps.get(resourceGroup, opts.name);
  const containers = existing.template?.containers ?? [];
  const merged: ContainerApp = {
    ...existing,
    template: {
      ...existing.template,
      containers: containers.length > 0
        ? [
            {
              ...containers[0],
              ...(opts.image ? { image: opts.image } : {}),
              ...(opts.envVars ? { env: opts.envVars } : {}),
            },
            ...containers.slice(1),
          ]
        : [
            {
              name: opts.name,
              ...(opts.image ? { image: opts.image } : {}),
              ...(opts.envVars ? { env: opts.envVars } : {}),
            },
          ],
    },
  };

  const result = await client.containerApps.beginCreateOrUpdateAndWait(
    resourceGroup,
    opts.name,
    merged,
  );
  return { name: opts.name, liveUrl: fqdnToLiveUrl(opts.name, result.configuration?.ingress?.fqdn) };
}

async function realDelete(name: string): Promise<void> {
  const client = getClient();
  const resourceGroup = requireResourceGroup();
  await client.containerApps.beginDeleteAndWait(resourceGroup, name);
}

// --- Public API ------------------------------------------------------------

export function isStub(): boolean {
  return env.AZURE_STUB;
}

export async function createContainerApp(
  opts: CreateContainerAppOpts,
): Promise<ContainerAppRef> {
  assertValidName(opts.name);
  return isStub() ? stubCreate(opts) : realCreate(opts);
}

export async function updateContainerApp(
  opts: UpdateContainerAppOpts,
): Promise<ContainerAppRef> {
  assertValidName(opts.name);
  return isStub() ? stubUpdate(opts) : realUpdate(opts);
}

export async function deleteContainerApp(name: string): Promise<void> {
  assertValidName(name);
  return isStub() ? stubDelete(name) : realDelete(name);
}
