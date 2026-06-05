/**
 * Resolve which Dockerfile a build should use (the I/O half of zero-Dockerfile
 * auto-build). Runs after the repo is cloned, just before kaniko:
 *
 *   1. If the repo ships a `Dockerfile`, use it verbatim (user always wins).
 *   2. Otherwise gather repo signals from disk, run the pure `detectFramework`,
 *      and — on a match — write the generated Dockerfile into the build context.
 *   3. If nothing is recognized, throw a friendly error. `runBuild`'s catch turns
 *      that into a FAILED build whose `errorMessage` is shown in the logs (much
 *      better than today's cryptic `kaniko exited with code 1`).
 *
 * The generated file is written INSIDE `repoDir` (never the auth dir) so both
 * `BUILD_RUNNER_MODE=kaniko` and `=docker` resolve its path correctly.
 */
import { access, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { detectFramework, type PackageJsonLike, type RepoSignals } from './dockerfileGen.js';

/** Name of the synthesized Dockerfile written into the build context. */
export const GENERATED_DOCKERFILE_NAME = '.prodstack.Dockerfile';

export interface ResolvedDockerfile {
  /** Absolute path to the Dockerfile kaniko should build. */
  dockerfilePath: string;
  /** Listen port for ingress, or `null` to leave the app's ingress unchanged. */
  port: number | null;
  /** Detected framework label, or `null` when the user supplied a Dockerfile. */
  framework: string | null;
  /** True when we generated the Dockerfile (vs. used the repo's own). */
  generated: boolean;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function readJsonIfPresent(p: string): Promise<PackageJsonLike | undefined> {
  if (!(await fileExists(p))) return undefined;
  try {
    return JSON.parse(await readFile(p, 'utf8')) as PackageJsonLike;
  } catch {
    // A malformed package.json shouldn't crash detection — treat as absent.
    return undefined;
  }
}

async function readTextIfPresent(p: string): Promise<string | undefined> {
  if (!(await fileExists(p))) return undefined;
  try {
    return await readFile(p, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Parse the listen port from a repo-supplied Dockerfile's `EXPOSE` instruction
 * so ingress can be pointed at it — Docker and kaniko both treat EXPOSE as the
 * declared port, and we mirror that for the Container App's ingress targetPort.
 * Without this, a BYO-Dockerfile app that listens on anything other than 80
 * fails its ACA startup probe and the placeholder revision keeps serving (the
 * "Hello World" incident). Handles `EXPOSE 3000`, `EXPOSE 3000/tcp`, and
 * multiple ports/lines (first valid numeric wins). Returns null when there's no
 * EXPOSE or it only uses values we can't resolve statically (`$PORT`,
 * `${PORT}`) — the caller then leaves ingress at its default.
 */
export function parseExposedPort(dockerfile: string): number | null {
  for (const raw of dockerfile.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#')) continue;
    const m = /^EXPOSE\s+(.+)$/i.exec(line);
    if (m === null) continue;
    for (const token of m[1].split(/\s+/)) {
      const portMatch = /^(\d{1,5})(?:\/(?:tcp|udp))?$/i.exec(token);
      if (portMatch === null) continue; // skip $PORT / ${PORT} / junk
      const port = Number(portMatch[1]);
      if (port >= 1 && port <= 65535) return port;
    }
  }
  return null;
}

/**
 * Find a Django wsgi module by scanning one level deep for `<pkg>/wsgi.py`.
 * Returns e.g. `myproject.wsgi`, or undefined if none found.
 */
async function findDjangoWsgiModule(repoDir: string, rootEntries: string[]): Promise<string | undefined> {
  for (const entry of rootEntries) {
    // Skip obvious non-package dirs to keep the scan cheap.
    if (entry.startsWith('.') || entry === 'node_modules' || entry === 'venv') continue;
    if (await fileExists(path.join(repoDir, entry, 'wsgi.py'))) {
      return `${entry}.wsgi`;
    }
  }
  return undefined;
}

async function gatherSignals(repoDir: string): Promise<RepoSignals> {
  const dirents = await readdir(repoDir, { withFileTypes: true });
  const rootEntries = dirents.map((d) => d.name);

  const packageJson = await readJsonIfPresent(path.join(repoDir, 'package.json'));
  const requirementsTxt = await readTextIfPresent(path.join(repoDir, 'requirements.txt'));
  const hasManagePy = rootEntries.includes('manage.py');

  return {
    rootEntries,
    packageJson,
    hasPackageLock: rootEntries.includes('package-lock.json'),
    requirementsTxt,
    hasPyproject: rootEntries.includes('pyproject.toml'),
    hasPipfile: rootEntries.includes('Pipfile'),
    hasManagePy,
    djangoWsgiModule: hasManagePy ? await findDjangoWsgiModule(repoDir, rootEntries) : undefined,
  };
}

export interface ResolveLogger {
  write(level: 'STEP' | 'INFO' | 'WARN' | 'ERROR' | 'SUCCESS', message: string): Promise<void>;
}

export interface ResolveOptions {
  /**
   * Build-time-public env var keys (`NEXT_PUBLIC_*`, `VITE_*`, …) to declare as
   * `ARG`s in a generated Dockerfile so the framework's bundler inlines them.
   * Ignored when the repo ships its own Dockerfile (we never rewrite it).
   */
  buildArgKeys?: string[];
}

/**
 * Resolve the Dockerfile for a cloned repo at `repoDir`. Logs progress via the
 * build's log sink. Throws a user-facing Error when no Dockerfile exists and the
 * framework can't be detected.
 */
export async function resolveDockerfile(
  repoDir: string,
  logs: ResolveLogger,
  opts: ResolveOptions = {},
): Promise<ResolvedDockerfile> {
  const userDockerfile = path.join(repoDir, 'Dockerfile');
  if (await fileExists(userDockerfile)) {
    // User Dockerfile always wins — we never rewrite it. But we DO read its
    // EXPOSE so ingress can be pointed at the app's real port; otherwise an app
    // listening on anything but 80 fails the ACA startup probe and the
    // placeholder revision keeps serving. No parseable EXPOSE → ingress is left
    // at its default (the caller treats a null port as "don't touch ingress").
    const port = parseExposedPort((await readTextIfPresent(userDockerfile)) ?? '');
    if (port !== null) {
      await logs.write(
        'STEP',
        `using Dockerfile from repository (ingress → port ${port} from EXPOSE)`,
      );
    } else {
      await logs.write(
        'WARN',
        'using Dockerfile from repository; no EXPOSE port found — leaving ingress at its ' +
          'default (80). Add an `EXPOSE <port>` line if your app listens elsewhere.',
      );
    }
    return { dockerfilePath: userDockerfile, port, framework: null, generated: false };
  }

  await logs.write('STEP', 'no Dockerfile found — detecting framework');
  const signals = await gatherSignals(repoDir);
  const detection = detectFramework(signals, { buildArgKeys: opts.buildArgKeys });

  if (!detection) {
    throw new Error(
      'No Dockerfile found and the project framework could not be auto-detected. ' +
        'Add a Dockerfile to the repository root to deploy this app.',
    );
  }

  await logs.write(
    'STEP',
    `detected ${detection.framework} → generating a Dockerfile (listens on :${detection.port})`,
  );
  const generatedPath = path.join(repoDir, GENERATED_DOCKERFILE_NAME);
  await writeFile(generatedPath, detection.dockerfile, 'utf8');

  return {
    dockerfilePath: generatedPath,
    port: detection.port,
    framework: detection.framework,
    generated: true,
  };
}
