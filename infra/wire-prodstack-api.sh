#!/usr/bin/env bash
# One-shot wiring of prodstack-api Container App: pulls 8 secrets from Key
# Vault via managed identity and sets the env vars the backend's Zod schema
# requires (incl. OWNER_GITHUB_ID for the single-user gate, DEPLOY_TOKEN for
# the M6 CI/CD self-deploy endpoint, and the M6 cost-safeguard vars below).
# Run in Azure Cloud Shell after uploading this file:
#   bash wire-prodstack-api.sh
#
# M6 cost safeguards (§2.14): ENABLE_CLEANUP_JOBS=true starts the in-process
# node-cron scheduler that runs the ACR image GC + Postgres build/log pruning
# daily; RETENTION_DAYS_* are the windows; ADMIN_TOKEN (KV secret `admin-token`)
# gates the manual POST /api/admin/cleanup/* triggers; ACR_USERNAME/ACR_PASSWORD
# (ACR admin creds) authenticate the image GC to the registry data-plane API.
# Cleanup is gated by ENABLE_CLEANUP_JOBS — NOT ENABLE_WORKER — so it runs on the
# API (ENABLE_WORKER stays false here) and not the dedicated builder.
#
# TRUST_PROXY_HOPS=3: requests reach the API through 3 proxy hops on the
# prodstack.live path (web-Envoy → prodstack-web nginx → api-Envoy), so Express's
# `trust proxy` must skip 3 X-Forwarded-For entries for `req.ip` to be the real
# visitor. Too low and every client collapses into one shared upstream IP and the
# per-IP rate limiters throttle everyone at once (the demo-login 429 incident).
# See backend/src/env.ts. If a hop count ever changes, retune this var (no rebuild).
#
# Demo mode (M8, docs/DEMO_MODE.md): ENABLE_DEMO=true exposes the public
# "Launch demo" sandbox (GET /api/auth/demo-login). SAFE under AZURE_STUB=false —
# demo safety is structural (routing + pre-claimed builds), not the stub. Override
# any DEMO_* by exporting it before running (e.g. `ENABLE_DEMO=false bash …` to
# back the feature out without a redeploy). The demo reaper rides on the same
# ENABLE_CLEANUP_JOBS scheduler above.
set -euo pipefail

APP="--name prodstack-api --resource-group prodstack"
KV=https://prodstack-kv.vault.azure.net/secrets
IDR=identityref:system

echo "==> Setting 8 Key Vault secret references on the Container App..."
# admin-token is the M6 cost-safeguard cleanup credential (POST
# /api/admin/cleanup/*), wired the same way as deploy-token. Create the
# `admin-token` Key Vault secret first (one-time):
#   az keyvault secret set --vault-name prodstack-kv --name admin-token \
#     --value "$(openssl rand -hex 32)"
az containerapp secret set $APP --secrets \
  database-url=keyvaultref:$KV/database-url,$IDR \
  jwt-secret=keyvaultref:$KV/jwt-secret,$IDR \
  cookie-secret=keyvaultref:$KV/cookie-secret,$IDR \
  data-enc-key=keyvaultref:$KV/data-enc-key,$IDR \
  gh-client-id=keyvaultref:$KV/github-oauth-client-id,$IDR \
  gh-client-secret=keyvaultref:$KV/github-oauth-client-secret,$IDR \
  deploy-token=keyvaultref:$KV/deploy-token,$IDR \
  admin-token=keyvaultref:$KV/admin-token,$IDR

# ACR admin creds for M6 image GC. The cleanup job talks to the ACR data-plane
# REST API (delete manifests) with HTTP Basic auth — the managed identity can't
# speak the OCI registry protocol, so we use admin creds, same as the builder.
# Stored in Key Vault and referenced via keyvaultref like the other 8 secrets
# (2026-06-12 hardening): a plain Container App secret is readable in cleartext
# by anyone holding `Microsoft.App/.../listSecrets` (incl. the RG-Contributor MI)
# with no KV audit/RBAC gate. Routing through KV gives the same audit + RBAC as
# every other secret. Rotation is unchanged: `az acr credential renew` then
# re-run this script — it re-writes the fresh value into the KV secret below
# (this script runs as the operator, who holds KV write access).
echo "==> Syncing ACR admin credentials into Key Vault for image cleanup..."
ACR_USER=$(az acr credential show -n prodstack --query username -o tsv)
ACR_PASS=$(az acr credential show -n prodstack --query 'passwords[0].value' -o tsv)
az keyvault secret set --vault-name prodstack-kv --name acr-username --value "$ACR_USER" >/dev/null
az keyvault secret set --vault-name prodstack-kv --name acr-password --value "$ACR_PASS" >/dev/null
az containerapp secret set $APP --secrets \
  acr-username=keyvaultref:$KV/acr-username,$IDR \
  acr-password=keyvaultref:$KV/acr-password,$IDR

# --- Optional: rate-limit-integrity edge secret (C1) -----------------------
# EDGE_PROXY_SECRET proves a request traversed prodstack-web's nginx (which
# injects it as the X-ProdStack-Edge header). The API then trusts the
# X-Forwarded-For chain its per-IP rate limiters key on ONLY for edge-marked
# requests; a DIRECT hit on the API's *.azurecontainerapps.io FQDN (1 hop, where
# XFF is forgeable) is keyed on the un-spoofable Envoy peer instead. UNSET => the
# API trusts req.ip as before (inert / no behavior change). ACTIVATION ORDER
# matters — create the KV secret, run provision-prodstack-web.sh FIRST (so nginx
# injects the header), THEN this script. Conditional so re-running before the KV
# secret exists is a safe no-op. See backend/src/middleware/rateLimit.ts.
#   az keyvault secret set --vault-name prodstack-kv --name edge-proxy-secret \
#     --value "$(openssl rand -hex 32)"
if az keyvault secret show --vault-name prodstack-kv --name edge-proxy-secret >/dev/null 2>&1; then
  echo "==> Wiring EDGE_PROXY_SECRET (rate-limit integrity) onto the API..."
  az containerapp secret set $APP --secrets edge-proxy-secret=keyvaultref:$KV/edge-proxy-secret,$IDR
  az containerapp update $APP --set-env-vars EDGE_PROXY_SECRET=secretref:edge-proxy-secret >/dev/null
else
  echo "==> EDGE_PROXY_SECRET not in Key Vault yet — skipping (rate-limit edge marker inactive)."
fi

# Subscription id: prefer $AZURE_SUBSCRIPTION_ID, else fall back to the current
# `az login`. The API origin is derived from Azure at runtime (the env-domain hash
# differs per deployment).
SUB="${AZURE_SUBSCRIPTION_ID:-$(az account show --query id -o tsv)}"
API=https://$(az containerapp ingress show -n prodstack-api -g prodstack --query fqdn -o tsv)
# WEB_ORIGIN is the PUBLIC browser origin. Since 2026-06-08 that is the custom
# domain prodstack.live (free Azure managed cert; see docs/CUSTOM_DOMAIN.md), NOT
# the autogenerated *.azurecontainerapps.io FQDN. It is hardcoded (overridable via
# WEB_PUBLIC_ORIGIN) so re-running this script can't silently revert the custom
# domain — that would break OAuth, since the GitHub OAuth App now expects the
# prodstack.live callback. The autogenerated FQDN still works as an alias:
#   WEB_PUBLIC_ORIGIN=https://$(az containerapp ingress show -n prodstack-web -g prodstack --query fqdn -o tsv)
WEB="${WEB_PUBLIC_ORIGIN:-https://prodstack.live}"
ENV_PATH=Microsoft.App/managedEnvironments/prodstack-env
ENV_ID=/subscriptions/$SUB/resourceGroups/prodstack/providers/$ENV_PATH

# Log Analytics workspace GUID (customerId) for the project-observability
# runtime-logs + metrics tabs. Derived from az so no GUID is hardcoded. Optional:
# the logs/metrics services degrade gracefully (available:false) when it's unset,
# but the prod API needs it to surface real data. Also requires the API identity
# to hold Monitoring Reader + Log Analytics Reader (infra/grant-prodstack-api-roles.sh).
LOG_WS_ID=$(az resource show -g prodstack -n prodstack-logs \
  --resource-type Microsoft.OperationalInsights/workspaces \
  --query properties.customerId -o tsv)

# NOTE (2026-06-01, M5 frontend): the OAuth callback lives on the WEB origin,
# not the API. prodstack-web's nginx reverse-proxies /api to the backend, so the
# browser runs the whole OAuth round-trip on the prodstack-web origin. The
# callback MUST land there too — otherwise the signed `oauth_state` cookie (set
# on the web origin during /github/begin) is never sent back and the callback
# 400s with OAUTH_STATE_MISMATCH. PUBLIC_API_URL stays the API origin because
# GitHub *webhooks* post server-to-server straight to the backend, not via nginx.
# The same web-origin URL must also be registered in the GitHub OAuth App (a
# manual step — there is no API to edit OAuth App callback URLs).
# KILL_SWITCH is intentionally NOT set here. It defaults to false in env.ts, and
# this script uses `--set-env-vars` (additive/merge — it only touches the keys it
# names). The switch is armed/disarmed out-of-band:
#   az containerapp update $APP --set-env-vars KILL_SWITCH=true   # arm, then it rolls
#   az containerapp update $APP --set-env-vars KILL_SWITCH=false  # disarm
# Because this script is additive, re-running it to "reset config" does NOT
# disarm a manually-armed switch — flip it explicitly with the command above.
echo "==> Setting environment variables on the Container App..."
az containerapp update $APP --set-env-vars \
  NODE_ENV=production \
  WEB_ORIGIN=$WEB \
  PUBLIC_API_URL=$API \
  TRUST_PROXY_HOPS=3 \
  GITHUB_OAUTH_CALLBACK_URL=$WEB/api/auth/github/callback \
  AZURE_STUB=false \
  AZURE_SUBSCRIPTION_ID=$SUB \
  AZURE_RESOURCE_GROUP=prodstack \
  AZURE_REGION=francecentral \
  LOG_ANALYTICS_WORKSPACE_ID=$LOG_WS_ID \
  ACR_NAME=prodstack \
  CONTAINER_APPS_ENV_ID=$ENV_ID \
  OWNER_GITHUB_ID="${OWNER_GITHUB_ID:?set to your GitHub numeric user id (curl -s https://api.github.com/users/<login> | jq .id)}" \
  ENABLE_CLEANUP_JOBS=true \
  RETENTION_DAYS_IMAGES=30 \
  RETENTION_DAYS_CACHE=7 \
  RETENTION_DAYS_LOGS=30 \
  RETENTION_DAYS_BUILDS=90 \
  ENABLE_DEMO="${ENABLE_DEMO:-true}" \
  DEMO_TTL_MINUTES="${DEMO_TTL_MINUTES:-120}" \
  DEMO_MAX_ACTIVE="${DEMO_MAX_ACTIVE:-50}" \
  DEMO_REPLAY_SPEED="${DEMO_REPLAY_SPEED:-6}" \
  DATABASE_URL=secretref:database-url \
  JWT_SECRET=secretref:jwt-secret \
  COOKIE_SECRET=secretref:cookie-secret \
  DATA_ENC_KEY=secretref:data-enc-key \
  GITHUB_OAUTH_CLIENT_ID=secretref:gh-client-id \
  GITHUB_OAUTH_CLIENT_SECRET=secretref:gh-client-secret \
  DEPLOY_TOKEN=secretref:deploy-token \
  ADMIN_TOKEN=secretref:admin-token \
  ACR_USERNAME=secretref:acr-username \
  ACR_PASSWORD=secretref:acr-password

echo "==> Current revisions:"
az containerapp revision list $APP --output table

echo "==> Done. Wait ~60s, then curl:"
echo "    curl -i $API/healthz"
