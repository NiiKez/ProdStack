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

export interface CreateProjectInput {
  repoUrl: string;
  branch: string;
  name: string;
}

export interface UpdateProjectInput {
  branch?: string;
  name?: string;
}
