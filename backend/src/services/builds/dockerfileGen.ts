/**
 * Framework detection + Dockerfile generation ("zero-Dockerfile" auto-build).
 *
 * When a user repo has no `Dockerfile`, we detect the stack from manifest files
 * and synthesize one — the same idea as Fly.io's `fly launch` scanners. This
 * module is the PURE core: it takes already-read repo signals and returns a
 * recipe (framework label + listen port + Dockerfile text). All filesystem I/O
 * lives in `resolveDockerfile.ts` so this stays trivially unit-testable.
 *
 * Hard constraint: the generated Dockerfile is consumed by **kaniko** (which is
 * archived and only speaks classic Dockerfile syntax). So every template here
 * MUST avoid BuildKit-only features — no `RUN --mount=...`, no heredocs
 * (`RUN <<EOF`), no `# syntax=` directive. Stick to multi-stage + `COPY --from`,
 * which kaniko supports. Templates are kept slim (multi-stage, prod deps only)
 * because the builder snapshots the filesystem in memory at 4 GiB.
 *
 * The chosen `port` is baked into the image as `ENV PORT=<port>` AND used to set
 * the Container App ingress `targetPort` at deploy time, so the two stay in
 * lockstep without us having to inject a `PORT` env var at the Azure layer.
 */

/** Minimal shape of a parsed `package.json` (only the fields we read). */
export interface PackageJsonLike {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

/** Everything the pure detector needs, gathered from disk by the caller. */
export interface RepoSignals {
  /** File/dir names at the repo root (one level, names only). */
  rootEntries: string[];
  /** Parsed `package.json` if present and valid JSON. */
  packageJson?: PackageJsonLike;
  /** Whether a `package-lock.json` exists at the root. */
  hasPackageLock: boolean;
  /** Raw `requirements.txt` contents if present (lowercased by caller is fine). */
  requirementsTxt?: string;
  /** Whether a `pyproject.toml` exists. */
  hasPyproject: boolean;
  /** Whether a `Pipfile` exists. */
  hasPipfile: boolean;
  /** Whether a Django `manage.py` exists at the root. */
  hasManagePy: boolean;
  /**
   * Django wsgi module discovered by the caller (e.g. `myproj.wsgi` from
   * `myproj/wsgi.py`), if any. Used to build a precise gunicorn command.
   */
  djangoWsgiModule?: string;
}

/** A detection result: how to build + run the app. */
export interface Detection {
  /** Human-readable label, also persisted to `Project.frameworkHint`. */
  framework: string;
  /** Port the app listens on (baked into the image + used for ingress). */
  port: number;
  /** Full Dockerfile text to write into the build context. */
  dockerfile: string;
}

const NODE_IMAGE = 'node:20-slim';
const NGINX_IMAGE = 'nginx:alpine';
const GO_IMAGE = 'golang:1.22-alpine';
const PYTHON_IMAGE = 'python:3.12-slim';

/** `npm ci` needs a lockfile; fall back to `npm install` so odd repos still build. */
function npmInstall(hasLock: boolean): string {
  return hasLock ? 'npm ci' : 'npm install';
}

/**
 * Declare build-time-public env vars (`NEXT_PUBLIC_*`, `VITE_*`, …) so the
 * framework's bundler can inline them. `ARG K` accepts the value kaniko passes
 * via `--build-arg`; `ENV K=$K` promotes it to an env var visible to the build
 * step (`npm run build`). These MUST sit in the build stage BEFORE the build
 * runs. Classic syntax only (kaniko-safe). Keys are pre-validated
 * UPPER_SNAKE_CASE by the API, so they're safe to interpolate verbatim.
 */
function buildArgEnvLines(keys: string[]): string[] {
  return keys.flatMap((k) => [`ARG ${k}`, `ENV ${k}=$${k}`]);
}

/**
 * nginx site config for a single-page app: serve the built assets and fall back
 * to `index.html` so client-side routes don't 404. Written via `printf` (one
 * classic `RUN`) — no heredoc, so kaniko is happy. `$uri` is kept literal by the
 * single quotes (printf does not expand it, and it never reaches the shell).
 */
function spaNginxConfRun(): string {
  return (
    "RUN printf 'server {\\n" +
    '  listen 80;\\n' +
    '  location / {\\n' +
    '    root /usr/share/nginx/html;\\n' +
    '    try_files $uri $uri/ /index.html;\\n' +
    '  }\\n' +
    "}\\n' > /etc/nginx/conf.d/default.conf"
  );
}

/** Two-stage "build with Node, serve the static output with nginx" template. */
function staticSpaDockerfile(outputDir: string, hasLock: boolean, buildArgKeys: string[]): string {
  return [
    `FROM ${NODE_IMAGE} AS build`,
    'WORKDIR /app',
    'COPY package*.json ./',
    `RUN ${npmInstall(hasLock)}`,
    ...buildArgEnvLines(buildArgKeys),
    'COPY . .',
    'RUN npm run build',
    '',
    `FROM ${NGINX_IMAGE}`,
    `COPY --from=build /app/${outputDir} /usr/share/nginx/html`,
    spaNginxConfRun(),
    'EXPOSE 80',
    'CMD ["nginx", "-g", "daemon off;"]',
    '',
  ].join('\n');
}

/** Long-running Node server (Next.js, Express, Nest, …). Honors `$PORT`. */
function nodeServerDockerfile(opts: {
  hasLock: boolean;
  startCmd: string;
  buildStep?: string;
  port: number;
  buildArgKeys: string[];
}): string {
  const lines = [
    `FROM ${NODE_IMAGE}`,
    'WORKDIR /app',
    'COPY package*.json ./',
    `RUN ${npmInstall(opts.hasLock)}`,
    ...buildArgEnvLines(opts.buildArgKeys),
    'COPY . .',
  ];
  if (opts.buildStep) lines.push(`RUN ${opts.buildStep}`);
  lines.push(
    'ENV NODE_ENV=production',
    `ENV PORT=${opts.port}`,
    `EXPOSE ${opts.port}`,
    `CMD ${opts.startCmd}`,
    '',
  );
  return lines.join('\n');
}

/** Static HTML site (no build step) served by nginx. */
function staticHtmlDockerfile(): string {
  return [
    `FROM ${NGINX_IMAGE}`,
    'COPY . /usr/share/nginx/html',
    spaNginxConfRun(),
    'EXPOSE 80',
    'CMD ["nginx", "-g", "daemon off;"]',
    '',
  ].join('\n');
}

/** Multi-stage Go build → tiny runtime. */
function goDockerfile(port: number): string {
  return [
    `FROM ${GO_IMAGE} AS build`,
    'WORKDIR /src',
    'COPY go.* ./',
    'RUN go mod download',
    'COPY . .',
    'RUN CGO_ENABLED=0 go build -o /app/server ./...',
    '',
    'FROM alpine:3.20',
    'RUN apk add --no-cache ca-certificates',
    'COPY --from=build /app/server /app/server',
    `ENV PORT=${port}`,
    `EXPOSE ${port}`,
    'CMD ["/app/server"]',
    '',
  ].join('\n');
}

/** Python web app (Django / FastAPI / Flask / generic). */
function pythonDockerfile(opts: { startCmd: string; port: number; hasPyproject: boolean }): string {
  const install = opts.hasPyproject
    ? 'RUN pip install --no-cache-dir .'
    : 'RUN if [ -f requirements.txt ]; then pip install --no-cache-dir -r requirements.txt; fi';
  return [
    `FROM ${PYTHON_IMAGE}`,
    'WORKDIR /app',
    'COPY . .',
    install,
    'ENV PYTHONUNBUFFERED=1',
    `ENV PORT=${opts.port}`,
    `EXPOSE ${opts.port}`,
    `CMD ${opts.startCmd}`,
    '',
  ].join('\n');
}

function allNodeDeps(pkg: PackageJsonLike): Record<string, string> {
  return { ...pkg.dependencies, ...pkg.devDependencies };
}

function detectNode(pkg: PackageJsonLike, signals: RepoSignals, buildArgKeys: string[]): Detection {
  const deps = allNodeDeps(pkg);
  const scripts = pkg.scripts ?? {};
  const has = (name: string): boolean => Object.prototype.hasOwnProperty.call(deps, name);

  // Next.js — server-rendered; `next start` honors $PORT.
  if (has('next')) {
    return {
      framework: 'Next.js',
      port: 3000,
      dockerfile: nodeServerDockerfile({
        hasLock: signals.hasPackageLock,
        buildStep: 'npm run build',
        startCmd: '["npm", "run", "start"]',
        port: 3000,
        buildArgKeys,
      }),
    };
  }

  // Vite single-page app (no server) → build, serve `dist/` with nginx.
  if (has('vite') || (scripts.build?.includes('vite') ?? false)) {
    return {
      framework: 'Vite (static SPA)',
      port: 80,
      dockerfile: staticSpaDockerfile('dist', signals.hasPackageLock, buildArgKeys),
    };
  }

  // Create React App → build, serve `build/` with nginx.
  if (has('react-scripts')) {
    return {
      framework: 'Create React App (static SPA)',
      port: 80,
      dockerfile: staticSpaDockerfile('build', signals.hasPackageLock, buildArgKeys),
    };
  }

  // Known long-running server frameworks.
  const serverFramework =
    (has('@nestjs/core') && 'NestJS') ||
    (has('express') && 'Express') ||
    (has('fastify') && 'Fastify') ||
    (has('koa') && 'Koa') ||
    (has('@hapi/hapi') && 'hapi') ||
    null;

  const buildStep = scripts.build ? 'npm run build' : undefined;
  // `npm start` if defined, else `node server.js`/`index.js` is too fragile to
  // guess — rely on the conventional `start` script, defaulting to `npm start`.
  const startCmd = '["npm", "start"]';
  return {
    framework: serverFramework ? `Node.js (${serverFramework})` : 'Node.js',
    port: 3000,
    dockerfile: nodeServerDockerfile({
      hasLock: signals.hasPackageLock,
      buildStep,
      startCmd,
      port: 3000,
      buildArgKeys,
    }),
  };
}

function detectPython(signals: RepoSignals): Detection {
  const reqs = (signals.requirementsTxt ?? '').toLowerCase();
  const reqHas = (name: string): boolean => reqs.includes(name);
  const PORT = 8000;

  // Django — prefer gunicorn against the discovered wsgi module; otherwise the
  // dev server (still serves traffic, just not production-grade).
  if (signals.hasManagePy || reqHas('django')) {
    const startCmd = signals.djangoWsgiModule
      ? `["sh", "-c", "gunicorn ${signals.djangoWsgiModule}:application --bind 0.0.0.0:$PORT"]`
      : '["sh", "-c", "python manage.py runserver 0.0.0.0:$PORT"]';
    return {
      framework: 'Django',
      port: PORT,
      dockerfile: pythonDockerfile({ startCmd, port: PORT, hasPyproject: signals.hasPyproject }),
    };
  }

  // FastAPI — ASGI via uvicorn (expects `main:app`).
  if (reqHas('fastapi') || reqHas('uvicorn')) {
    return {
      framework: 'FastAPI',
      port: PORT,
      dockerfile: pythonDockerfile({
        startCmd: '["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port $PORT"]',
        port: PORT,
        hasPyproject: signals.hasPyproject,
      }),
    };
  }

  // Flask — WSGI via gunicorn (expects `app:app`).
  if (reqHas('flask')) {
    return {
      framework: 'Flask',
      port: PORT,
      dockerfile: pythonDockerfile({
        startCmd: '["sh", "-c", "gunicorn app:app --bind 0.0.0.0:$PORT"]',
        port: PORT,
        hasPyproject: signals.hasPyproject,
      }),
    };
  }

  // Generic Python entrypoint.
  if (signals.rootEntries.includes('main.py')) {
    return {
      framework: 'Python',
      port: PORT,
      dockerfile: pythonDockerfile({
        startCmd: '["python", "main.py"]',
        port: PORT,
        hasPyproject: signals.hasPyproject,
      }),
    };
  }

  // Python project with no recognizable entrypoint — let the caller decide it's
  // unsupported by returning the generic template only when one exists.
  return {
    framework: 'Python',
    port: PORT,
    dockerfile: pythonDockerfile({
      startCmd: '["python", "app.py"]',
      port: PORT,
      hasPyproject: signals.hasPyproject,
    }),
  };
}

/**
 * Detect the framework from repo signals and return a build recipe, or `null`
 * if nothing is recognized (caller surfaces a friendly "add a Dockerfile"
 * error). Detection order mirrors the precedence used by Railway/Fly: a concrete
 * framework wins over a generic per-language fallback.
 *
 * `opts.buildArgKeys` lists the project's build-time-public env var keys
 * (`NEXT_PUBLIC_*`, `VITE_*`, …); for Node frameworks they're declared as `ARG`s
 * before the build step so the bundler can inline them. Only Node templates use
 * them — Go/Python/static recipes have no JS bundler and ignore the list.
 */
export function detectFramework(
  signals: RepoSignals,
  opts: { buildArgKeys?: string[] } = {},
): Detection | null {
  const buildArgKeys = opts.buildArgKeys ?? [];
  if (signals.packageJson) {
    return detectNode(signals.packageJson, signals, buildArgKeys);
  }

  if (signals.rootEntries.includes('go.mod')) {
    return { framework: 'Go', port: 8080, dockerfile: goDockerfile(8080) };
  }

  const isPython =
    signals.requirementsTxt !== undefined ||
    signals.hasPyproject ||
    signals.hasPipfile ||
    signals.hasManagePy;
  if (isPython) {
    return detectPython(signals);
  }

  // Pure static site: an index.html with no app manifest.
  if (signals.rootEntries.includes('index.html')) {
    return { framework: 'Static site', port: 80, dockerfile: staticHtmlDockerfile() };
  }

  return null;
}
