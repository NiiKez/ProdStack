import type { BuildStatus } from '@/lib/status';

export interface ProjectLatestBuild {
  id: string;
  status: BuildStatus;
  commitSha: string;
  commitMessage: string;
  createdAt: string;
}

export interface ProjectActiveDeployment {
  id: string;
  revisionName: string;
  createdAt: string;
}

/**
 * Whether a project's deployed Azure app is running (`ACTIVE`) or paused
 * (`STOPPED`). Stopping hard-stops the Container App (0 replicas, won't wake on
 * traffic — not scale-to-zero) so the live URL goes dark at $0 compute;
 * resuming brings it back and, when auto-deploy is on, builds the newest
 * commit. See `useStopProject`/`useResumeProject`.
 */
export type ProjectStatus = 'ACTIVE' | 'STOPPED';

export interface ProjectSummary {
  id: string;
  name: string;
  slug: string;
  githubRepoFullName: string;
  branch: string;
  liveUrl: string | null;
  containerAppName: string;
  /** When false, a `git push` no longer auto-builds — deploy manually instead. */
  autoDeploy: boolean;
  /** Running (`ACTIVE`) or paused (`STOPPED`). Present on list + detail. */
  status: ProjectStatus;
  /** ISO timestamp the project was last stopped, or null when active. */
  stoppedAt: string | null;
  createdAt: string;
  updatedAt: string;
  latestBuild: ProjectLatestBuild | null;
  activeDeployment: ProjectActiveDeployment | null;
}

export interface BuildSummary {
  id: string;
  status: BuildStatus;
  commitSha: string;
  commitMessage: string;
  commitAuthor: string;
  branch: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  createdAt: string;
}

export interface ProjectDetail extends ProjectSummary {
  builds: BuildSummary[];
  /**
   * Present on `GET /api/projects/:id` and on the PATCH response when env vars
   * were saved. Values are write-only — the server returns only the key and a
   * `hasValue` flag, never the decrypted secret, so a leaked session/HAR can't
   * exfiltrate it.
   */
  envVars?: ProjectEnvVar[];
}

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'STEP' | 'SUCCESS';

export interface LogLine {
  seq: number;
  level: LogLevel;
  message: string;
  ts: string;
}

export interface BuildDetail {
  id: string;
  status: BuildStatus | string;
  commitSha: string;
  commitMessage: string;
  commitAuthor: string;
  branch: string;
  imageTag: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  errorMessage: string | null;
  createdAt: string;
  project: {
    id: string;
    name: string;
    githubRepoFullName: string;
    liveUrl: string | null;
  };
}

/**
 * An env var as the API returns it: write-only, so the value is masked. The
 * server only ever sends the key and whether a value is stored; the cleartext
 * never crosses the wire. `hasValue` is effectively always `true` (a key can't
 * exist without a value) — it's explicit so the UI can render a "(set)"
 * placeholder and reason about the contract.
 */
export interface ProjectEnvVar {
  key: string;
  hasValue: boolean;
}

/**
 * One entry of a PATCH `envVars` save. The value is optional: send a (non-empty)
 * `value` only for a key the user added or edited; omit it to keep the stored
 * encrypted value. Keys absent from the submitted list are deleted; a brand-new
 * key with no value is rejected (400).
 */
export interface UpdateEnvVar {
  key: string;
  value?: string;
}

/** Cursor-paginated list envelope returned by the M5 list endpoints. */
export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
}

/** A row from `GET /api/projects/:id/builds` (richer than `BuildSummary`). */
export interface BuildListItem extends BuildSummary {
  imageTag: string | null;
  errorMessage: string | null;
}

/** The build info embedded in a deployment row. */
export interface DeploymentBuildInfo {
  id: string;
  status: BuildStatus | string;
  commitSha: string;
  commitMessage: string;
  commitAuthor: string;
  branch: string;
  imageTag?: string | null;
}

/** A row from `GET /api/projects/:id/deployments`. */
export interface DeploymentListItem {
  id: string;
  revisionName: string;
  active: boolean;
  rolledBack: boolean;
  createdAt: string;
  build: DeploymentBuildInfo;
}

/** A row from `GET /api/deployments` (cross-project, carries project info). */
export interface CrossProjectDeployment extends DeploymentListItem {
  project: { id: string; name: string; liveUrl: string | null };
}

export type ActivityType =
  | 'build.queued'
  | 'build.succeeded'
  | 'build.failed'
  | 'build.cancelled'
  | 'deployment.created'
  | 'deployment.rollback'
  | 'project.created'
  | 'project.deleted';

export interface ActivityEvent {
  id: string;
  type: ActivityType;
  ts: string;
  projectId: string;
  projectName: string;
  buildId?: string;
  commitSha?: string;
  commitMessage?: string;
  commitAuthor?: string;
}

export interface CreateProjectInput {
  repoUrl: string;
  branch: string;
  name: string;
}

/**
 * A repo from `GET /api/github/repos` — the user's GitHub repositories the
 * New Project picker lists, already sorted most-recently-pushed first by the
 * backend. The endpoint wraps these as `{ repos: GithubRepo[] }`.
 */
export interface GithubRepo {
  fullName: string;
  url: string;
  defaultBranch: string;
  private: boolean;
}

export interface UpdateProjectInput {
  branch?: string;
  name?: string;
  autoDeploy?: boolean;
  /** Partial save: see `UpdateEnvVar`. `null`/absent = leave env vars untouched. */
  envVars?: UpdateEnvVar[] | null;
}

/** A line of the running container's stdout/stderr (`GET …/runtime/logs`). */
export interface RuntimeLogLine {
  ts: string;
  message: string;
  stream: 'stdout' | 'stderr' | 'unknown';
  revision: string | null;
}

/**
 * `GET /api/projects/:id/runtime/logs`. `available:false` (with a `note`) when
 * the log workspace isn't configured or the query failed — the UI shows the
 * note instead of an error.
 */
export interface RuntimeLogsResult {
  lines: RuntimeLogLine[];
  available: boolean;
  note?: string;
}

/** `POST /api/github/detect` — framework preview for the New Project modal. */
export interface DetectFrameworkResult {
  /** The repo ships its own Dockerfile (we build it as-is). */
  hasDockerfile: boolean;
  /** Detected framework label, or null when unrecognized. */
  framework: string | null;
  /** Detected listen port, or null. */
  port: number | null;
}

/**
 * Why a config-only redeploy did or didn't happen after an env-var save
 * (M5 #6). `NO_ACTIVE_DEPLOYMENT` = project never had a successful deploy, so
 * the vars apply on its first build; `BUILD_IN_PROGRESS` = an in-flight build
 * will pick them up; `NO_IMAGE` = the active deployment's build has no pushed
 * image; `REDEPLOY_FAILED` = the vars saved but the Azure roll errored.
 */
export type RedeployReason =
  | 'NO_ACTIVE_DEPLOYMENT'
  | 'BUILD_IN_PROGRESS'
  | 'NO_IMAGE'
  | 'REDEPLOY_FAILED';

export interface RedeploySummary {
  redeployed: boolean;
  reason?: RedeployReason;
}

/**
 * `PATCH /api/projects/:id` response. Extends the project detail with an
 * optional `redeploy` summary, present only when the request included
 * `envVars` (saving env vars auto-redeploys with the last successful image).
 */
export interface UpdateProjectResult extends ProjectDetail {
  redeploy?: RedeploySummary;
}

/** `POST /api/projects/:id/rebuild` response. */
export interface RebuildResult {
  buildId: string;
}

/**
 * `POST /api/projects/:id/stop` response — the reshaped project (now STOPPED).
 * The route returns the summary shape (no `builds`/`envVars`); callers read the
 * status from the invalidated `['project', id]` query, not this payload.
 */
export type StopProjectResult = ProjectSummary;

/**
 * `POST /api/projects/:id/resume` response — the reshaped project (now ACTIVE)
 * plus `resumedBuild`: non-null when auto-deploy was on and a build of the
 * newest commit was queued, null otherwise (auto-deploy off, or no commit).
 * Like stop, this is the summary shape (no `builds`/`envVars`) — only
 * `resumedBuild` is consumed by the caller.
 */
export interface ResumeProjectResult extends ProjectSummary {
  resumedBuild: { id: string } | null;
}

/** `POST /api/builds/:id/cancel` response. */
export interface CancelBuildResult {
  id: string;
  status: BuildStatus | string;
  /** True when cancellation was *requested* of a running build (cooperative). */
  cancelRequested: boolean;
}

/** `GET /api/account`. */
export interface AccountInfo {
  id: string;
  githubLogin: string;
  email: string | null;
  avatarUrl: string | null;
  github: { connected: boolean; scopes: string[] };
  azure: {
    mode: 'managed-identity' | 'stub';
    region: string;
    subscriptionId: string | null;
    resourceGroup: string | null;
  };
  counts: { projects: number };
}

/** `POST /api/account/azure/test`. */
export interface AzureTestResult {
  ok: boolean;
  mode: 'managed-identity' | 'stub';
  detail?: string;
  latencyMs?: number;
}
