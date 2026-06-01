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

export interface ProjectSummary {
  id: string;
  name: string;
  slug: string;
  githubRepoFullName: string;
  branch: string;
  liveUrl: string | null;
  containerAppName: string;
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

export interface CreateProjectInput {
  repoUrl: string;
  branch: string;
  name: string;
}

export interface UpdateProjectInput {
  branch?: string;
  name?: string;
}
