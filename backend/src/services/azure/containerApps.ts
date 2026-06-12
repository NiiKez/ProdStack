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
 *    deployment tenant.
 *
 * The two branches share the public shape so callers (e.g. the Project
 * service) never need to know which is active beyond `isStub()`.
 */
import { createHash } from 'node:crypto';

import {
  ContainerAppsAPIClient,
  type ContainerApp,
  type EnvironmentVar,
  type RegistryCredentials,
  type Secret,
} from '@azure/arm-appcontainers';
import { DefaultAzureCredential } from '@azure/identity';
import pino from 'pino';

import { env } from '../../env.js';
import { logger } from '../../lib/logger.js';

// --- Public contract -------------------------------------------------------

export interface ContainerAppRef {
  name: string;
  liveUrl: string;
  /** Latest revision name after the create/update, when the SDK reports one. */
  revisionName?: string;
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
  /**
   * When set, re-point the ingress at this port. Used by zero-Dockerfile builds
   * to align the ingress with the framework's listen port (e.g. 3000 for a
   * Node server). Omitted on plain rolls so the existing port is preserved.
   */
  targetPort?: number;
  /**
   * Force ACA to roll a fresh revision even when the template is otherwise
   * unchanged. The env-redeploy path (`redeployWithCurrentEnv`) needs this: env
   * vars are referenced by a key-stable `secretRef`, so rotating a *value*
   * leaves the revision template byte-identical and ACA refuses to create a new
   * revision — the running replica keeps the stale value in memory until it
   * restarts (a silent "save didn't take effect"). Stamping a content-addressed
   * `revisionSuffix` makes any value change roll a new revision. Left unset on
   * image rolls, where the changed image tag already forces a new revision.
   */
  forceNewRevision?: boolean;
}

// --- Constants -------------------------------------------------------------

const DEFAULT_IMAGE = 'mcr.microsoft.com/k8se/quickstart:latest';
const DEFAULT_TARGET_PORT = 80;
const DEFAULT_MIN_REPLICAS = 0; // scale-to-zero
const DEFAULT_MAX_REPLICAS = 2;

// User Container Apps pull their built image from our PRIVATE ACR. Without a
// `registries` credential, ACA attempts an anonymous pull and the revision
// fails to provision with `UNAUTHORIZED: authentication required`. We reuse the
// ACR admin creds the rest of the platform already uses (push + image GC),
// stored on each user app as a Container App secret referenced by `registries`.
const ACR_PULL_SECRET_NAME = 'acr-pull-password';

interface AcrPullAuth {
  /** ACR login server, e.g. `prodstack.azurecr.io`. */
  server: string;
  registry: RegistryCredentials;
  secret: Secret;
}

/**
 * Build the ACR pull credential (registry entry + its password secret) from the
 * ACR admin creds in the environment. Returns `undefined` when any of
 * `ACR_NAME`/`ACR_USERNAME`/`ACR_PASSWORD` is unset — i.e. local/stub setups or
 * a misconfigured deploy — so callers simply skip wiring registry auth rather
 * than emitting a half-formed `registries` block that ARM would reject.
 */
function acrPullAuth(): AcrPullAuth | undefined {
  if (!env.ACR_NAME || !env.ACR_USERNAME || !env.ACR_PASSWORD) return undefined;
  const server = `${env.ACR_NAME}.azurecr.io`;
  return {
    server,
    registry: { server, username: env.ACR_USERNAME, passwordSecretRef: ACR_PULL_SECRET_NAME },
    secret: { name: ACR_PULL_SECRET_NAME, value: env.ACR_PASSWORD },
  };
}

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

/**
 * Derive a Container App secret name from a user env-var key.
 *
 * Container Apps secret names are RFC-1123-ish: lowercase alphanumeric +
 * hyphens, must start with a letter, no consecutive/trailing hyphens, ≤253
 * chars. User env keys match `^[A-Z_][A-Z0-9_]*$`, so a naive lowercase
 * would still trip on leading underscores. We sanitize to a safe base and
 * append a short hash of the original key so distinct keys never collide
 * after sanitization.
 *
 * Layout is `env-<base>-<hash>` with the **bounded `base` first and the
 * 8-hex `hash` last**. This matters because env keys can be up to 128 chars
 * (`patchBodySchema`): the old `\`env-${base}-${hash}\`.slice(0, 60)` truncated
 * the hash off the end for long keys, so two keys sharing a long prefix
 * collided to the same secret name (Azure rejects duplicate secret names →
 * the whole deploy 400s, and both `secretRef`s point at one value). Bounding
 * `base` to 40 chars before appending the never-sliced hex hash makes
 * collisions impossible and guarantees an alphanumeric final char (no
 * trailing-hyphen names, which Azure also rejects).
 */
function secretNameFor(key: string): string {
  const hash = createHash('sha1').update(key).digest('hex').slice(0, 8);
  const base = key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return `env-${base || 'v'}-${hash}`;
}

/**
 * Turn the project's env vars into a Container App `secrets` list plus the
 * matching `env` entries that reference them via `secretRef`. Every user env
 * value lands in Azure as a secret (encrypted at rest by the platform) rather
 * than a plaintext `env.value`, mirroring how we store it encrypted in the DB.
 * Returns `undefined` for both when no env vars are supplied so callers can
 * leave the existing template untouched (vs. wiping it with empties).
 */
function envToSecrets(envVars: EnvVarInput[] | undefined): {
  env: EnvironmentVar[] | undefined;
  secrets: Secret[] | undefined;
} {
  if (envVars === undefined) return { env: undefined, secrets: undefined };
  const secrets: Secret[] = envVars.map((e) => ({ name: secretNameFor(e.name), value: e.value }));
  const containerEnv: EnvironmentVar[] = envVars.map((e) => ({
    name: e.name,
    secretRef: secretNameFor(e.name),
  }));
  return { env: containerEnv, secrets };
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
  return { name: opts.name, liveUrl: STUB_LIVE_URL(opts.name), revisionName: `${opts.name}--stub` };
}

async function stubUpdate(opts: UpdateContainerAppOpts): Promise<ContainerAppRef> {
  stubLog.info(
    {
      op: 'updateContainerApp',
      name: opts.name,
      image: opts.image,
      envVarKeys: envVarKeys(opts.envVars),
      targetPort: opts.targetPort,
    },
    'stub: update Container App',
  );
  await stubDelay();
  return { name: opts.name, liveUrl: STUB_LIVE_URL(opts.name), revisionName: `${opts.name}--stub` };
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
  const { env: containerEnv, secrets } = envToSecrets(opts.envVars);
  const acr = acrPullAuth();
  return {
    location: env.AZURE_REGION,
    environmentId,
    configuration: {
      ingress: {
        external: true,
        targetPort: opts.targetPort ?? DEFAULT_TARGET_PORT,
        transport: 'auto',
      },
      // Surface the ACR pull secret alongside any env-var secrets so the new
      // app can authenticate to the private registry from its first roll.
      secrets: [...(secrets ?? []), ...(acr ? [acr.secret] : [])],
      ...(acr ? { registries: [acr.registry] } : {}),
    },
    template: {
      containers: [
        {
          name: opts.name,
          image: opts.image ?? DEFAULT_IMAGE,
          env: containerEnv,
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

  return {
    name: opts.name,
    liveUrl: fqdnToLiveUrl(opts.name, result.configuration?.ingress?.fqdn),
    ...(result.latestRevisionName ? { revisionName: result.latestRevisionName } : {}),
  };
}

async function realUpdate(opts: UpdateContainerAppOpts): Promise<ContainerAppRef> {
  // Fetch the existing Container App, merge `template` (image + env) and, when
  // env vars are supplied, the matching `configuration.secrets`, then re-PUT
  // via `beginCreateOrUpdateAndWait`. The dedicated `beginUpdateAndWait` is
  // intentionally avoided — its PATCH semantics don't carry over the immutable
  // `environmentId` / `location` and quietly drop fields we don't echo back.
  //
  // Env vars are applied as secrets + `secretRef` (see `envToSecrets`), never
  // plaintext `env.value`. When `opts.envVars` is undefined we leave the
  // existing env + secrets untouched (a plain image roll), so a build deploy
  // that doesn't pass env vars never wipes them.
  const client = getClient();
  const resourceGroup = requireResourceGroup();

  const existing = await client.containerApps.get(resourceGroup, opts.name);
  const containers = existing.template?.containers ?? [];
  const { env: containerEnv, secrets } = envToSecrets(opts.envVars);

  // Force a fresh revision when asked (the env-redeploy path). A value-only env
  // change leaves the template identical (env vars are `secretRef`s, not inline
  // values), so without this ACA would no-op the re-PUT and the running replica
  // would keep serving the old value. A content-addressed suffix makes any value
  // change roll a new revision; salting with the current latest revision name
  // keeps the suffix unique even when reverting to a prior exact config (ACA
  // rejects reusing a historical revision name).
  const revisionSuffix = opts.forceNewRevision
    ? `cfg${createHash('sha1')
        .update(
          JSON.stringify({
            salt: existing.latestRevisionName ?? '',
            env: (opts.envVars ?? [])
              .map((e) => [e.name, e.value] as const)
              .sort((a, b) => a[0].localeCompare(b[0])),
          }),
        )
        .digest('hex')
        .slice(0, 12)}`
    : undefined;

  // Reconcile only the `env-`-prefixed secrets we manage; preserve everything
  // else (e.g. a registry-password secret referenced by `registries[]`). A re-
  // PUT replaces the whole `secrets` array, and `get()` returns secret *names*
  // without their values, so we must pull the real values from `listSecrets`
  // first — otherwise preserved secrets round-trip as `value: undefined` and
  // get blanked. Without this, saving an env var wipes any non-env secret.
  // Ensure the private-ACR pull credential is present. Apps created before
  // pull-auth wiring have no `registries` entry, so a roll to an ACR image
  // would 401 on the pull; we repair them here (idempotent for apps that
  // already have it).
  const acr = acrPullAuth();
  const existingRegistries = existing.configuration?.registries ?? [];
  const registriesNeedRepair =
    acr !== undefined && !existingRegistries.some((r) => r.server === acr.server);

  let mergedSecrets: Secret[] | undefined;
  let mergedRegistries: RegistryCredentials[] | undefined;
  // Rewrite the secrets array when applying env vars OR when repairing the ACR
  // registry (the pull secret must exist for `passwordSecretRef` to resolve) OR
  // when changing the ingress port (any re-PUT of `configuration` re-sends
  // `secrets`). Either way we must read live secret *values* via `listSecrets`
  // first — `get()` returns names with `value: undefined`, so any preserved
  // plain-value secret would otherwise round-trip blanked and ARM would reject
  // the PUT. Changing the port therefore goes through the same round-trip.
  if (secrets !== undefined || registriesNeedRepair || opts.targetPort !== undefined) {
    const live = await client.containerApps.listSecrets(resourceGroup, opts.name);
    const liveSecrets = (live.value ?? []).filter(
      (s): s is Secret => typeof s.name === 'string',
    );
    // When (re)applying env vars, drop the `env-` set we manage so it's replaced
    // by `secrets`; otherwise keep every live secret as-is.
    const base =
      secrets !== undefined ? liveSecrets.filter((s) => !s.name!.startsWith('env-')) : liveSecrets;
    mergedSecrets = secrets !== undefined ? [...base, ...secrets] : [...base];
    if (acr && !mergedSecrets.some((s) => s.name === acr.secret.name)) {
      mergedSecrets = [...mergedSecrets, acr.secret];
    }
    if (registriesNeedRepair) {
      mergedRegistries = [...existingRegistries, acr!.registry];
    }
  }

  const merged: ContainerApp = {
    ...existing,
    ...(mergedSecrets !== undefined || mergedRegistries !== undefined || opts.targetPort !== undefined
      ? {
          configuration: {
            ...existing.configuration,
            ...(mergedSecrets !== undefined ? { secrets: mergedSecrets } : {}),
            ...(mergedRegistries !== undefined ? { registries: mergedRegistries } : {}),
            // Re-point ingress at the requested port, preserving everything else
            // about the existing ingress (external flag, transport, fqdn).
            ...(opts.targetPort !== undefined
              ? { ingress: { ...existing.configuration?.ingress, targetPort: opts.targetPort } }
              : {}),
          },
        }
      : {}),
    template: {
      ...existing.template,
      ...(revisionSuffix ? { revisionSuffix } : {}),
      containers: containers.length > 0
        ? [
            {
              ...containers[0],
              ...(opts.image ? { image: opts.image } : {}),
              ...(containerEnv ? { env: containerEnv } : {}),
            },
            ...containers.slice(1),
          ]
        : [
            {
              name: opts.name,
              ...(opts.image ? { image: opts.image } : {}),
              ...(containerEnv ? { env: containerEnv } : {}),
            },
          ],
    },
  };

  const result = await client.containerApps.beginCreateOrUpdateAndWait(
    resourceGroup,
    opts.name,
    merged,
  );
  return {
    name: opts.name,
    liveUrl: fqdnToLiveUrl(opts.name, result.configuration?.ingress?.fqdn),
    ...(result.latestRevisionName ? { revisionName: result.latestRevisionName } : {}),
  };
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

// --- Platform self-deploy (M6 "Option B") ----------------------------------

/**
 * The only Container Apps the CI/CD self-deploy endpoint is allowed to roll.
 * A hard allow-list so a leaked/misused `DEPLOY_TOKEN` can never aim
 * `rollPlatformApp` at a user's Container App (or anything else in the RG) —
 * the worst it can do is point one of these two at a different image in our
 * own ACR (the route also pins the registry).
 */
export const PLATFORM_APPS = {
  api: 'prodstack-api',
  web: 'prodstack-web',
} as const;
export type PlatformAppKey = keyof typeof PLATFORM_APPS;

export interface RollPlatformAppOpts {
  /** Resolved Container App name — must be one of `PLATFORM_APPS`' values. */
  name: string;
  /** Fully-qualified image ref in our ACR (validated by the caller). */
  image: string;
}

async function stubRollPlatformApp(opts: RollPlatformAppOpts): Promise<ContainerAppRef> {
  stubLog.info(
    { op: 'rollPlatformApp', name: opts.name, image: opts.image },
    'stub: roll platform Container App',
  );
  await stubDelay();
  return { name: opts.name, liveUrl: STUB_LIVE_URL(opts.name), revisionName: `${opts.name}--stub` };
}

async function realRollPlatformApp(opts: RollPlatformAppOpts): Promise<ContainerAppRef> {
  const client = getClient();
  const resourceGroup = requireResourceGroup();

  // Get-modify-PUT, swapping ONLY the container image. A re-PUT replaces the
  // whole `configuration.secrets` array, and `get()` returns each secret's
  // *name* (plus `keyVaultUrl`/`identity` for Key Vault refs) but BLANKS the
  // value of literal secrets. So echoing `existing`'s secrets back verbatim is
  // rejected by ARM — `ContainerAppSecretInvalid: value or keyVaultUrl and
  // identity should be provided` — for any plain-value secret, e.g. the ACR
  // admin creds `acr-username`/`acr-password` that `wire-prodstack-api.sh` sets
  // for the M6 image-GC. Pull the live secret set from `listSecrets` (which
  // returns Key Vault refs with their `keyVaultUrl`+`identity` AND literal
  // secrets with their value) and re-supply it, the same way `realUpdate` does.
  // This keeps the roll correct regardless of how each secret is stored — it
  // never blanks a literal secret and never converts a Key Vault ref into one.
  const existing = await client.containerApps.get(resourceGroup, opts.name);
  const live = await client.containerApps.listSecrets(resourceGroup, opts.name);
  const secrets = (live.value ?? []).filter(
    (s): s is Secret => typeof s.name === 'string',
  );
  const containers = existing.template?.containers ?? [];
  const merged: ContainerApp = {
    ...existing,
    ...(secrets.length > 0
      ? { configuration: { ...existing.configuration, secrets } }
      : {}),
    template: {
      ...existing.template,
      containers:
        containers.length > 0
          ? [{ ...containers[0], image: opts.image }, ...containers.slice(1)]
          : [{ name: opts.name, image: opts.image }],
    },
  };

  // Kick off the rollout but DON'T `pollUntilDone()`. When the API rolls
  // *itself* (app=api), ACA shifts traffic to the new revision and tears down
  // the old one (this process) once it's healthy — awaiting completion would
  // risk dropping the very request that triggered the deploy. `beginCreate-
  // OrUpdate` resolves once ARM has accepted the initial PUT, after which Azure
  // owns the rollout; we return 202 and let it finish asynchronously. ACA keeps
  // the old revision serving until the new one passes health probes, so the
  // 202 reaches the GitHub runner before any traffic shift.
  await client.containerApps.beginCreateOrUpdate(resourceGroup, opts.name, merged);

  return {
    name: opts.name,
    liveUrl: fqdnToLiveUrl(opts.name, existing.configuration?.ingress?.fqdn),
  };
}

/**
 * Roll one of the two platform Container Apps (`prodstack-api` /
 * `prodstack-web`) to a new image. Used by the CI/CD self-deploy endpoint so
 * the GitHub runner never needs Azure RBAC (it builds + pushes the image; the
 * API — which holds `Contributor` on the RG via its managed identity — does the
 * roll). Refuses any name outside `PLATFORM_APPS` as defence-in-depth on top of
 * the route's own validation.
 */
export async function rollPlatformApp(opts: RollPlatformAppOpts): Promise<ContainerAppRef> {
  assertValidName(opts.name);
  const isPlatform = (Object.values(PLATFORM_APPS) as string[]).includes(opts.name);
  if (!isPlatform) {
    throw new Error(
      `rollPlatformApp refused: ${JSON.stringify(opts.name)} is not a platform Container App`,
    );
  }
  return isStub() ? stubRollPlatformApp(opts) : realRollPlatformApp(opts);
}

/**
 * Read the current container image of a Container App by name (M6 image GC).
 *
 * The image cleanup job calls this for the three platform apps
 * (`prodstack-api` / `prodstack-web` / `prodstack-builder`) to add their LIVE
 * image tags to the keep-set — authoritative protection so GC never deletes an
 * image that's actually deployed, even if it's older than the retention window.
 *
 * Returns `null` in stub mode (local dev / tests never hit a real registry, so
 * there's nothing live to protect) and `null` when the app has no container.
 */
export async function getContainerAppImage(name: string): Promise<string | null> {
  if (isStub()) return null;
  const client = getClient();
  const resourceGroup = requireResourceGroup();
  const app = await client.containerApps.get(resourceGroup, name);
  return app.template?.containers?.[0]?.image ?? null;
}

/**
 * Map an Azure/credential error to a coarse, non-sensitive category for the
 * Settings UI. Deliberately does NOT echo `err.message` (which can leak
 * subscription/tenant/identity IDs and endpoints). Branches on the HTTP status
 * / SDK error code commonly attached by `@azure/core-rest-pipeline` RestError
 * and `@azure/identity`.
 */
function pingErrorDetail(err: unknown): string {
  const e = err as { statusCode?: number; code?: string; name?: string };
  const status = typeof e?.statusCode === 'number' ? e.statusCode : undefined;
  const code = e?.code ?? e?.name ?? '';

  if (status === 401 || /CredentialUnavailable|AuthenticationError|AADSTS/i.test(code)) {
    return 'Authentication failed — the managed identity could not obtain a token.';
  }
  if (status === 403 || /Authorization|Forbidden/i.test(code)) {
    return 'Authorization failed — the identity lacks the required RBAC role on the resource group.';
  }
  if (status === 404) {
    return 'Resource group not found at the configured subscription.';
  }
  if (status === 429 || /Throttle|TooManyRequests/i.test(code)) {
    return 'Request throttled by Azure — try again shortly.';
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|network/i.test(code)) {
    return 'Network error reaching Azure.';
  }
  return 'Azure connectivity check failed.';
}

/**
 * Connectivity probe for the Settings page. Proves the managed identity +
 * subscription actually authenticate against Azure without mutating anything.
 *
 * Never throws: a failed ping is a normal, displayable result (the frontend
 * renders it inline), not an HTTP error. In stub mode it short-circuits to a
 * deterministic `ok` after a tiny delay so local dev / tests exercise the
 * same code path the UI hits.
 */
export async function pingAzure(): Promise<{
  ok: boolean;
  mode: 'managed-identity' | 'stub';
  detail?: string;
  latencyMs?: number;
}> {
  if (isStub()) {
    await stubDelay();
    return { ok: true, mode: 'stub', detail: 'Azure stub mode (local dev).' };
  }

  const startedAt = Date.now();
  try {
    const client = getClient();
    // Pull just the first item to force an authenticated round-trip without
    // paging the whole list. An empty resource group still completes the
    // iterator (the loop body simply never runs), which is a successful ping.
    for await (const _ of client.containerApps.listByResourceGroup(requireResourceGroup())) {
      break;
    }
    return { ok: true, mode: 'managed-identity', latencyMs: Date.now() - startedAt };
  } catch (err) {
    // Log the full error server-side (the `err` serializer in logger.ts strips
    // request/response bodies), but return only a coarse, non-sensitive
    // category to the browser. Raw Azure / DefaultAzureCredential messages
    // routinely embed the subscription, tenant, and managed-identity client/
    // object IDs and the token endpoint — none of which belongs in the DOM.
    logger.warn({ err }, 'pingAzure connectivity check failed');
    return { ok: false, mode: 'managed-identity', detail: pingErrorDetail(err) };
  }
}
