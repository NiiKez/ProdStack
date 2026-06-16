#!/usr/bin/env bash
# Provision (or re-wire) the prodstack-web Container App. Idempotent — safe to
# re-run after bumping the image tag. Run in Azure Cloud Shell after uploading
# this file (or locally with az logged in):
#
#   bash provision-prodstack-web.sh            # tag = m5-rev1
#   bash provision-prodstack-web.sh m5-rev2    # custom tag
#
# Assumes the web image was already pushed to ACR via
# infra/build-and-push-web.sh on the laptop.
#
# IMPORTANT: prodstack-web ALREADY EXISTS (the hello-world placeholder created
# in M2), so this script UPDATES it — it does not create from scratch. The app
# serves static files + reverse-proxies the API, so its system-assigned identity
# only needs AcrPull (already granted in M2); no Key Vault / RG roles. The one
# required env var is BACKEND_FQDN: nginx.conf is an envsubst template whose
# upstream is the backend API's FQDN, so this script sets BACKEND_FQDN on the
# web app (derived from Azure at runtime — see step 2b).
set -euo pipefail

RG=prodstack
APP=prodstack-web
ACR=prodstack
ACR_LOGIN_SERVER=$ACR.azurecr.io
TAG="${1:-m5-rev1}"
IMAGE="$ACR_LOGIN_SERVER/$APP:$TAG"

# --- 0. Sanity: the app must already exist ---------------------------------
if ! az containerapp show -n $APP -g $RG >/dev/null 2>&1; then
  echo "ERROR: $APP does not exist in $RG. This script updates the existing" >&2
  echo "       hello-world placeholder; it does not create the app." >&2
  exit 1
fi

# --- 1. Wire image pulls to the managed identity (one-time, idempotent) -----
# The Portal/CLI-created placeholder may still pull via admin creds or an
# anonymous source. Point it at the system-assigned identity, which must
# already have the AcrPull role on the registry. Safe to re-run.
echo "==> Setting registry pull source to managed identity"
az containerapp registry set \
  -n $APP -g $RG \
  --server $ACR_LOGIN_SERVER \
  --identity system >/dev/null

# --- 2. Roll the image ------------------------------------------------------
echo "==> Updating image to $IMAGE"
az containerapp update -n $APP -g $RG --image "$IMAGE" >/dev/null

# --- 2b. Wire BACKEND_FQDN for the nginx reverse proxy ----------------------
# nginx.conf is an envsubst template: its API upstream is ${BACKEND_FQDN} and
# the container's entrypoint renders it at boot. nginx therefore REQUIRES
# BACKEND_FQDN to be set on the app. Derive the API's FQDN from Azure (no
# hardcoded live host) and set it as an env var. Without this the proxy has no
# upstream and /api + /builds 502.
echo "==> Setting BACKEND_FQDN (nginx API upstream) from prodstack-api ingress"
BACKEND_FQDN=$(az containerapp ingress show -n prodstack-api -g $RG --query fqdn -o tsv)
az containerapp update -n $APP -g $RG \
  --set-env-vars BACKEND_FQDN=$BACKEND_FQDN >/dev/null

# --- 2c. Optional: rate-limit-integrity edge marker (C1) -------------------
# EDGE_PROXY_SECRET makes nginx inject the X-ProdStack-Edge header (see
# frontend/nginx.conf.template) so the API can distinguish traffic that traversed
# THIS proxy (the canonical prodstack.live 3-hop path) from a direct hit on the
# API's own *.azurecontainerapps.io FQDN — the latter has a forgeable
# X-Forwarded-For that would otherwise let a caller mint unlimited per-IP
# rate-limit buckets. The web MI has no Key Vault access (AcrPull only), so we
# read the shared secret from KV as the OPERATOR (who does) and store it as a
# Container App SECRET, then reference it from the env var (secretref) so the
# entrypoint's envsubst still renders it into the nginx config at boot. We do NOT
# use a plain --set-env-vars value: that would leave the shared edge secret in
# cleartext in the revision template (readable with mere Microsoft.App/read) —
# the same cleartext-exposure this hardening pass removed for the ACR creds.
# UNSET => envsubst leaves the literal token and the API ignores it (inert).
# ACTIVATE by creating the KV secret ONCE, then re-running this script (web)
# FOLLOWED by infra/wire-prodstack-api.sh — web FIRST, so the API never enforces
# the marker before nginx is injecting it (else prodstack.live traffic briefly
# collapses onto one rate-limit bucket). Conditional, so re-running before the
# secret exists is a safe no-op.
#   az keyvault secret set --vault-name prodstack-kv --name edge-proxy-secret \
#     --value "$(openssl rand -hex 32)"
if az keyvault secret show --vault-name prodstack-kv --name edge-proxy-secret >/dev/null 2>&1; then
  echo "==> Setting EDGE_PROXY_SECRET (nginx X-ProdStack-Edge marker) from Key Vault"
  EDGE_SECRET=$(az keyvault secret show --vault-name prodstack-kv --name edge-proxy-secret --query value -o tsv)
  az containerapp secret set -n $APP -g $RG \
    --secrets edge-proxy-secret="$EDGE_SECRET" >/dev/null
  az containerapp update -n $APP -g $RG \
    --set-env-vars EDGE_PROXY_SECRET=secretref:edge-proxy-secret >/dev/null
else
  echo "==> EDGE_PROXY_SECRET not in Key Vault yet — skipping (nginx edge marker inactive)."
fi

# --- 3. Ensure ingress targets port 8080 -----------------------------------
# nginx listens on 8080 (the runtime is nginxinc/nginx-unprivileged, uid 101 —
# it cannot bind the privileged :80; see frontend/Dockerfile + nginx.conf.template).
# `containerapp update --image` never touches ingress, so we set it explicitly
# (idempotent) — this is the M2 "ingress port stays at whatever it was created
# with" gotcha. Keep ingress external (public demo).
echo "==> Ensuring ingress is external on target-port 8080"
az containerapp ingress update \
  -n $APP -g $RG \
  --type external \
  --target-port 8080 >/dev/null

# --- 4. Cap scaling per the single-user safety policy ----------------------
# Tighten from the ACA default max=10 down to max=1. min=1 keeps the frontend
# always-on (no cold start on prodstack.live) — owner-requested 2026-06-16 so
# the live site responds instantly. (Was min=0/scale-to-zero; the ~1-2s cold
# start was acceptable for a demo but the owner wants it running constantly.)
echo "==> Setting scale bounds min=1 max=1"
az containerapp update \
  -n $APP -g $RG \
  --min-replicas 1 \
  --max-replicas 1 >/dev/null

# --- 5. Show current state -------------------------------------------------
echo "==> Active revision:"
az containerapp revision list -n $APP -g $RG \
  --query "[?properties.active].{name:name, healthState:properties.healthState, runningState:properties.runningState, replicas:properties.replicas, image:properties.template.containers[0].image}" \
  -o table

echo "==> Ingress:"
az containerapp ingress show -n $APP -g $RG \
  --query "{targetPort:targetPort, external:external, fqdn:fqdn}" -o table

echo ""
echo "==> Done. Verify the SPA + API proxy with:"
WEB_FQDN=$(az containerapp ingress show -n $APP -g $RG --query fqdn -o tsv)
echo "    curl -sS -i https://$WEB_FQDN/             # SPA shell"
echo "    curl -sS -i https://$WEB_FQDN/api/health   # proxied to prodstack-api"
echo "    az containerapp logs show -n $APP -g $RG --tail 100 --follow"
