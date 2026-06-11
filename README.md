# ProdStack

> A self-hostable, Vercel-style PaaS that connects a GitHub repo, builds a Docker image from your code on every push, and deploys it to Azure Container Apps — with live build logs, deployment history, and one-click rollback.

ProdStack turns a Git push into a running app. Sign in with GitHub, connect a repository — bring your own `Dockerfile` or let ProdStack auto-detect the framework and generate one — and every push to the configured branch automatically builds a Docker image, pushes it to a private registry, and rolls a new revision of your app behind a public URL. A real-time dashboard streams build logs as they happen, keeps a full deployment history, and lets you roll back to any previous version in one click. The platform even deploys **itself** through its own CI/CD pipeline.

It is designed to run on Azure Container Apps and is **self-hostable on your own Azure subscription** — and it runs end-to-end on your laptop with **zero cloud account** thanks to a built-in stub mode.

---

## Table of contents

- [What is ProdStack](#what-is-prodstack)
- [Features](#features)
- [How it works](#how-it-works)
- [Tech stack](#tech-stack)
- [Repository layout](#repository-layout)
- [Data model](#data-model)
- [Local development](#local-development)
- [Deployment](#deployment)
- [Security](#security)
- [Status](#status)
- [Roadmap](#roadmap)
- [Contributing & license](#contributing--license)

---

## What is ProdStack

Most "deploy from Git" platforms are closed SaaS. ProdStack is a small, readable, open-source take on that experience that you can run yourself:

1. **Connect** — Sign in with GitHub and connect a repo as a *project*. ProdStack registers a push webhook on the repo and provisions a Container App placeholder for it.
2. **Push** — Push to the configured branch. A webhook fires, a build is queued, and an in-cluster builder produces a Docker image from your `Dockerfile` — or from one ProdStack generates for you by detecting your framework.
3. **Ship** — The image is pushed to a private registry and a new revision of your app rolls out behind a public URL.
4. **Observe & manage** — Watch build logs stream live, inspect runtime logs and metrics, browse the deployment history, edit environment variables, trigger manual rebuilds, or roll back — all from the dashboard.

The whole pipeline is queue-driven and crash-tolerant: the database *is* the build queue, so there is no separate broker to operate.

---

## Features

### Deploy

- **Sign in with GitHub** (OAuth) — session is a JWT in an `HttpOnly` / `Secure` / `SameSite=Lax` cookie.
- **Connect a repo as a project** — auto-registers a GitHub push webhook and creates a Container App placeholder; both are torn down on delete.
- **Push-to-deploy** — an HMAC-verified GitHub webhook enqueues a build. Idempotent on the GitHub delivery id, so redelivered webhooks never double-build.
- **In-cluster Docker builds with [Kaniko](https://github.com/GoogleContainerTools/kaniko)** — daemonless image builds with **no Docker-in-Docker and no privileged mode**, run in a dedicated worker.
- **Zero-Dockerfile builds** — no `Dockerfile`? ProdStack detects your framework (Node, Python, …), synthesizes a Kaniko-safe one, and sets the app's ingress port automatically (it also honours a BYO `Dockerfile`'s `EXPOSE`).
- **Self-deploying CI/CD** — a token-gated `POST /api/admin/deploy` endpoint plus GitHub Actions roll the platform's own apps; database migrations run automatically on container boot.

### Observe

- **Live build-log streaming over SSE** — logs stream to the browser as they are produced, with replay-from-cursor (`?afterSeq` / `Last-Event-ID`), periodic heartbeats, and a terminal `done` event.
- **Build & deployment history** — per-project build history and deployment history, a cross-project deployments page, and an activity feed.
- **Runtime logs & metrics** — stream your running app's stdout/stderr from Azure Log Analytics, and view CPU / memory / replica-count charts (including scale-to-zero behaviour) in the dashboard.

### Manage

- **One-click rollback** — re-deploy the image from any previous successful build.
- **Per-project environment variables** — stored **AES-256-GCM encrypted at rest** and **write-only** (the API returns only key names, never decrypted values), surfaced to the running app as Container App secrets, with automatic redeploy on change. Keys prefixed `NEXT_PUBLIC_*` / `VITE_*` are additionally threaded into the build as `--build-arg`s, so client frameworks can inline them at build time.
- **Manual rebuild & auto-deploy toggle** — trigger a build without pushing to Git, or turn automatic push-to-deploy off per project to build only on demand.
- **Build cancellation** — fast-cancel a queued build, or cooperatively abort an in-flight build via `AbortController`.

### Operate

- **Cost safeguards** built in:
  - Scheduled registry **image garbage collection** and Postgres **log/build pruning** (via `node-cron`).
  - A **kill switch** for degrade mode — webhooks return `503`, the worker idles (without exiting), and a banner is shown in the UI.
  - **Scale-to-zero** on user apps.
  - A monthly **budget alert**.

### Try it without an account

- **Public demo mode** *(optional — toggled by `ENABLE_DEMO`)* — a **Launch demo** button mints a sandboxed, throwaway session pre-seeded with example "already-deployed" projects. A visitor can browse, create projects, and watch a build stream through the **exact same UI** — except the logs are a replay of a captured real build and **nothing touches Azure, the registry, or Git**. Sessions are ephemeral and reaped automatically, so the platform can be shown off publicly without exposing real deploy infrastructure.

---

## How it works

### Architecture

ProdStack is three first-party components, each its own Azure Container App in a single environment:

```
                         ┌──────────────────────────────────────────────┐
                         │              Azure Container Apps              │
   Browser               │                  (one env)                    │
     │                   │                                               │
     │  HTTPS (same      │   ┌───────────────┐      ┌──────────────────┐ │
     │  origin)          │   │  Frontend     │      │   Backend API    │ │
     ├───────────────────┼──▶│  nginx + SPA  │──────▶│   (Express)      │ │
     │                   │   │  reverse-proxy│ /api │  auth · projects │ │
     │  /api  /builds    │   │  /api /builds │/builds│  webhooks · SSE  │ │
     │  (SSE)            │   └───────────────┘      │  deploy/rollback │ │
     │                   │                          │  admin           │ │
     │                   │                          └────────┬─────────┘ │
     │                   │                                   │           │
     │                   │   ┌──────────────────┐            │ writes    │
     │                   │   │   Build worker   │            │ QUEUED    │
     │                   │   │  (no ingress)    │            ▼ build     │
     │                   │   │  node worker.js  │     ┌───────────────┐  │
     │                   │   │  /kaniko/executor│◀────│   PostgreSQL  │  │
     │                   │   │  2 CPU / 4 GiB   │poll │  (queue + bus)│  │
     │                   │   └────────┬─────────┘claim└───────────────┘  │
     │                   │            │ build+push                       │
     │                   │            ▼                                  │
     │                   │   ┌──────────────────┐   ┌────────────────┐   │
     │                   │   │ Container Registry│   │   Key Vault    │   │
     │                   │   └──────────────────┘   └────────────────┘   │
     └───────────────────┘                                               │
                         └──────────────────────────────────────────────┘
```

- **Frontend (React + Vite, served by nginx).** nginx serves the built SPA and **reverse-proxies `/api` and `/builds` to the API**, so the browser always talks to a single origin. That keeps the session cookie first-party and lets SSE work without CORS.
- **Backend API (Express).** Handles auth, project CRUD, the webhook receiver, the SSE log endpoint, deploy/rollback orchestration, and admin endpoints.
- **Build worker.** A separate Container App with **no ingress** that runs `node backend/dist/worker.js` and shells out to `/kaniko/executor` (2 CPU / 4 GiB). It is single-use: after each build it self-exits, Azure Container Apps respawns it, and it re-leases any in-flight claim on boot.

### End-to-end deploy flow

1. A developer **pushes** to the configured branch.
2. GitHub fires a **push webhook** → the API verifies the **HMAC signature** and enforces **delivery-id idempotency**.
3. The API writes a **`QUEUED` Build row** in Postgres. *The row is the queue entry — there is no separate broker.*
4. The worker **polls every ~2s** and atomically claims a row:
   ```sql
   UPDATE "Build" SET ... WHERE id = (
     SELECT id FROM "Build" WHERE status = 'QUEUED' AND "claimedAt" IS NULL
     ORDER BY "createdAt" ASC FOR UPDATE SKIP LOCKED LIMIT 1
   )
   ```
5. The worker runs `git clone --depth 1` (the user's GitHub token is decrypted and passed to git as an `http.<url>.extraheader` config through the child process's `GIT_CONFIG_*` environment — kept off the command line / `/proc/<pid>/cmdline` and never written to disk in plaintext).
6. The worker runs **`/kaniko/executor`**, building the image and pushing the tags to the registry.
7. The worker calls `updateContainerApp({ name, image })` (Azure SDK) to roll the **user's app** to a new revision.
8. In one transaction it writes a `Deployment` row, flips the previous deployment inactive, and updates the project's live URL.
9. Status transitions (`QUEUED → CLONING → BUILDING → PUSHING → DEPLOYING → READY`) and log lines are written to Postgres. The SSE endpoint **tails those Postgres rows** and pushes them to the browser — Postgres is the message bus precisely because the worker is a separate process.

---

## Tech stack

| Area | Technologies |
|---|---|
| **Backend** | Node 20 · TypeScript 5.7 · Express 4.21 · Prisma 6.19 + PostgreSQL 16 · Zod · `jsonwebtoken` · helmet · cors · cookie-parser · `express-rate-limit` · pino + pino-http · node-cron · `@octokit/rest` · Azure SDKs (`@azure/identity` `DefaultAzureCredential`, `@azure/arm-appcontainers`, `@azure/arm-containerregistry`, `@azure/keyvault-secrets`, `@azure/storage-blob`) · SSE over plain HTTP |
| **Frontend** | React 19 · Vite 6 · TypeScript 5.7 · Tailwind CSS 4 · `react-router-dom` 7 · `@tanstack/react-query` 5 · Radix UI primitives · `lucide-react` · `react-hook-form` + Zod |
| **Build & runtime** | Kaniko · Docker · nginx · Azure Container Apps · Azure Container Registry · Azure Database for PostgreSQL Flexible Server · Azure Key Vault |
| **Tooling** | npm workspaces · ESLint 9 · Prettier 3 · Vitest 4 + Supertest · Playwright (E2E) · GitHub Actions (CI + self-deploy) |

---

## Repository layout

```
.
├── backend/            # Express API + Prisma schema + the Kaniko build worker
│                       #   + services + tests. Dockerfile runs `prisma migrate
│                       #   deploy` on boot.
├── frontend/           # React 19 + Vite SPA (Tailwind). Served by nginx in
│                       #   prod (nginx.conf.template serves the SPA + reverse-proxies
│                       #   /api + /builds).
├── worker/             # Build-worker image: Node 20 + git + /kaniko/executor
│                       #   + the compiled backend/dist.
├── infra/              # Idempotent bash provisioning / deploy scripts.
├── .github/workflows/  # api.yml + web.yml (path-filtered self-deploy on push
│                       #   to main) and ci.yml (PR gate).
├── docker-compose.yml  # Local Postgres 16.
└── package.json        # npm-workspaces root (frontend, backend).
```

> The worker reuses `backend/` (the same compiled output runs the API and the worker); there is no separate `shared/` workspace.

---

## Data model

Prisma models (PostgreSQL), in brief:

- **`User`** — `githubUserId` unique; the GitHub OAuth token is stored as an **AES-256-GCM encrypted triple** (ciphertext / IV / auth tag), never plaintext. Ephemeral demo-mode visitors are also `User` rows (`isDemo` / `demoExpiresAt`), reaped on expiry.
- **`Project`** *(1 User → N Projects)* — `name`, `slug` (unique per user via a **partial unique index** scoped to non-deleted rows, so a deleted project's slug can be reused), `githubRepoFullName`, `branch` (default `main`), `webhookId`, `containerAppName`, `liveUrl`, an `autoDeploy` toggle, and a `deletedAt` soft-delete column. The webhook secret is stored encrypted.
- **`Build`** *(1 Project → N Builds)* — `commitSha` / `commitMessage` / `commitAuthor`, a `status` enum, `imageTag`, the Postgres-queue fields (`claimedAt` / `claimedBy` / `attempts`), `cancelRequested`, and timing fields.
- **`LogLine`** *(1 Build → N LogLines)* — `BigInt` id, `seq` unique per build, a `level` enum.
- **`Deployment`** *(1 Project → N Deployments)* — `revisionName`, `active` (a **partial unique index** enforces exactly one active deployment per project), `rolledBack`.
- **`EnvVar`** *(1 Project → N EnvVars)* — encrypted value.
- **`WebhookEvent`** *(1 Project → N events)* — `id` is the GitHub delivery id, giving webhook idempotency for free.

```
BuildStatus  = QUEUED · CLONING · BUILDING · PUSHING · DEPLOYING · READY · FAILED · CANCELLED
LogLevel     = INFO · WARN · ERROR · STEP · SUCCESS
```

---

## Local development

### Zero-cloud mode (start here)

You can run the **entire app on your laptop with no Azure account at all**. Set:

```env
AZURE_STUB=true
BUILD_RUNNER_MODE=stub
```

In stub mode the Azure SDK calls are faked and the build engine skips `git` + Kaniko, "deploying" a placeholder image instead. You can sign in, connect a repo, watch a (simulated) build stream live, and "deploy" — exercising the full UI and data flow without spending a cent.

### Prerequisites

- Node 20 (see `.nvmrc`)
- Docker (for local Postgres)
- A [GitHub OAuth App](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app) — callback URL `http://localhost:3000/api/auth/github/callback`, scopes `repo` + `admin:repo_hook`

### Steps

```bash
# 1. Start Postgres 16 (db / user / password all "prodstack")
npm run dev:db          # docker compose up -d postgres

# 2. Install workspace deps (root)
npm install

# 3. Configure the backend
cp backend/.env.example backend/.env
#    → fill GITHUB_OAUTH_CLIENT_ID / GITHUB_OAUTH_CLIENT_SECRET
#    → generate the three secrets (see below)

# 4. Apply the database schema
npm --workspace=@prodstack/api run prisma:migrate

# 5. Run the API and the frontend (two terminals)
npm run dev:api         # Express on :3000
npm run dev:web         # Vite on :5173
```

Open http://localhost:5173.

Generate the required secrets:

```bash
openssl rand -hex 32      # JWT_SECRET
openssl rand -hex 32      # COOKIE_SECRET
openssl rand -base64 32   # DATA_ENC_KEY (decodes to 32 bytes)
```

### Required environment variables

The API validates its environment with Zod at startup and **exits immediately if any required variable is missing or invalid**:

| Variable | Notes |
|---|---|
| `WEB_ORIGIN` | URL of the frontend (e.g. `http://localhost:5173`). |
| `DATABASE_URL` | Postgres connection string. |
| `JWT_SECRET` | Session signing secret, **≥ 32 chars**. |
| `COOKIE_SECRET` | Signed-cookie secret, **≥ 32 chars**. |
| `DATA_ENC_KEY` | AES-256-GCM key, base64 that decodes to **32 bytes**. |
| `GITHUB_OAUTH_CLIENT_ID` | From your GitHub OAuth App. |
| `GITHUB_OAUTH_CLIENT_SECRET` | From your GitHub OAuth App. |
| `GITHUB_OAUTH_CALLBACK_URL` | Must match the OAuth App's callback URL. |

Useful optional variables (full reference in `backend/.env.example`):

| Variable | Default | Purpose |
|---|---|---|
| `AZURE_STUB` | `true` | Stub all Azure SDK calls — leave `true` for local dev. |
| `BUILD_RUNNER_MODE` | `stub` | `stub` / `docker` / `kaniko` build engine. |
| `ENABLE_WORKER` | `false` | Run the in-process build poll loop. |
| `OWNER_GITHUB_ID` | *(empty)* | Optional single-user allow-list gate — when empty, **any** GitHub user may sign in. |
| `ENABLE_DEMO` | `false` | Enable public **demo mode** (the "Launch demo" button + sandboxed throwaway sessions). |

> **Note on `OWNER_GITHUB_ID`:** the hosted instance of this project restricts sign-in to a single GitHub user to protect a limited cloud budget — everyone else can still explore the product through demo mode instead. This is a no-op when the variable is unset, so a self-hosted fork allows anyone by default.

---

## Deployment

ProdStack is designed to run on **Azure Container Apps** and is self-hostable on your own Azure subscription. A deployment consists of three Container Apps (the API, the nginx web app, and the Kaniko build worker) in one Container Apps environment, backed by:

- **Azure Container Registry** — private image registry for built images.
- **Azure Database for PostgreSQL Flexible Server** — the application database and build queue.
- **Azure Key Vault** — runtime secrets.

Key deployment properties:

- **Managed Identity everywhere.** The backend uses `DefaultAzureCredential` and a **system-assigned managed identity** for all Azure access — no service principals, no long-lived client secrets in the app.
- **Self-deploying CI/CD.** GitHub Actions calls a token-gated deploy endpoint on the running API, which rolls the platform's own Container Apps using its managed identity. The runner never needs Azure RBAC.
- **Migrate-on-boot.** The API image runs `prisma migrate deploy` on container start.
- **Scale-to-zero.** User apps scale to zero replicas when idle.

Idempotent provisioning and deploy scripts live in `infra/`. They are the source of truth for the exact resources and wiring — start there to stand up your own environment.

---

## Security

- **GitHub OAuth** sign-in; the session is a JWT in an `HttpOnly` / `Secure` / `SameSite=Lax` cookie.
- **HMAC-verified webhooks** — incoming GitHub deliveries are signature-checked before any work is queued, and de-duplicated by delivery id.
- **Input validation as a trust boundary** — webhook commit SHAs (`^[0-9a-f]{7,64}$`) and git branch names are validated before they reach `git`, and every user-controlled git positional is passed after `--end-of-options`, closing argument-injection (e.g. `--upload-pack=…` RCE) paths. The builder's GitHub token is passed off the command line via `GIT_CONFIG_*`, so it can't be read from `/proc/<pid>/cmdline`.
- **Encryption at rest** — GitHub tokens, per-project environment variables, and webhook secrets are **AES-256-GCM encrypted** in the database (with a key-version column for rotation). Environment-variable values are **write-only**: the API returns only key names, never decrypted values.
- **Secrets at runtime** live in Azure Key Vault and are surfaced to apps as Container App secrets, never baked into images.
- **Least-privilege managed identity** for all Azure operations.
- **Per-IP rate limiting** on the API — a global limiter plus tighter limiters on auth, the webhook receiver, expensive Azure-fan-out reads, build triggers, and SSE streams — to blunt abuse and Azure-cost amplification.
- **CSRF protection** — cookie-authed state-changing routes require an `X-Requested-With` header (webhooks use HMAC and admin endpoints use a bearer token, so both are correctly exempt).
- **Hardened delivery** — `helmet` on the API and a strict CSP + HSTS / `X-Frame-Options` / … on the nginx-served SPA; container images run **non-root** (`USER node`) where the runtime allows and **pin every base image by digest**; GitHub Actions are pinned to commit SHAs and only immutable `:<git-sha>` image tags are pushed.

---

## Status

Core functionality is implemented and working: push-to-deploy with Kaniko builds (including **zero-Dockerfile framework auto-detection**), live SSE build logs, runtime logs and metrics, build/deployment history, one-click rollback, encrypted per-project environment variables, manual rebuild and cancellation, an optional public demo mode, self-deploying CI/CD, and the operational cost safeguards (image GC, log/build pruning, kill switch, scale-to-zero, budget alert). The codebase has an extensive automated test suite — Vitest + Supertest across the API and worker, plus Vitest and Playwright end-to-end tests on the frontend.

---

## Roadmap

Ideas and stretch goals, not commitments:

- Infrastructure-as-Code (Bicep) to replace the bash provisioning scripts.
- A dedicated message queue (e.g. Azure Service Bus) as an alternative to the Postgres-backed queue.
- Preview deployments per pull request.
- Custom domains for user apps.
- Kaniko build-cache reuse to speed up rebuilds.

---

## Contributing & license

This is an open-source **portfolio project**. Issues, ideas, and forks are welcome. The single-user sign-in gate that protects the hosted instance is a no-op when self-hosted, so a fork is fully multi-user out of the box.

See the repository's license file for licensing terms.
