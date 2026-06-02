#!/bin/sh
# API container entrypoint.
#
# Runs `prisma migrate deploy` against the prod database BEFORE the server
# starts, then execs the passed command (CMD) as PID 1's child.
#
# Why migrate on boot instead of "a migrate step in the GitHub workflow" (as
# originally planned): the Postgres flexible server's firewall
# only admits the home IP + the Container Apps Environment's outbound IP, so a
# GitHub-hosted runner can't reach the DB to run migrations. The API container,
# by contrast, runs inside that environment and already holds DATABASE_URL. So
# the migrate step lives here, executed as part of the deploy the CI pipeline
# triggers (build+push -> POST /api/admin/deploy -> new revision boots -> this).
#
# Safe to run on every boot: `migrate deploy` is idempotent (no-op when there
# are no pending migrations) and takes a Prisma advisory lock, so even if two
# revisions briefly overlap during a roll they can't race. If a migration
# fails, this script exits non-zero, the new revision never becomes healthy,
# and ACA keeps the old revision serving — a safe failure mode.
#
# Set RUN_MIGRATIONS=false to skip (e.g. a revision you don't want migrating).
# `-u` (treat unset vars as an error) is cheap insurance; no pipes here so
# `pipefail` is irrelevant under /bin/sh.
set -eu

# Only the exact strings `true` / `false` are valid. A typo (`True`, `1`, `yes`)
# must NOT silently skip migrations and boot against a possibly-unmigrated DB —
# fail loud so the revision never goes healthy (ACA keeps the old one serving).
case "${RUN_MIGRATIONS:-true}" in
  true)
    echo "[entrypoint] running prisma migrate deploy..."
    node_modules/.bin/prisma migrate deploy --schema=backend/prisma/schema.prisma
    echo "[entrypoint] migrations up to date."
    ;;
  false)
    echo "[entrypoint] RUN_MIGRATIONS=false — skipping migrate deploy."
    ;;
  *)
    echo "[entrypoint] ERROR: RUN_MIGRATIONS must be 'true' or 'false', got '${RUN_MIGRATIONS}'." >&2
    exit 1
    ;;
esac

exec "$@"
