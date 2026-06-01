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
# only needs AcrPull (already granted in M2); no Key Vault / RG roles, and no
# app env vars or secrets are required (the API FQDN is hardcoded in nginx.conf).
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

# --- 3. Ensure ingress targets port 80 -------------------------------------
# nginx listens on 80. The placeholder was likely created with target-port 80
# already, but `containerapp update --image` never touches ingress, so we set
# it explicitly (idempotent) — this is the M2 "ingress port stays at whatever
# it was created with" gotcha. Keep ingress external (public demo).
echo "==> Ensuring ingress is external on target-port 80"
az containerapp ingress update \
  -n $APP -g $RG \
  --type external \
  --target-port 80 >/dev/null

# --- 4. Cap scaling per the single-user safety policy ----------------------
# Tighten from the ACA default max=10 down to max=1. min=0 lets it scale to
# zero when idle (accepts the ~1-2s cold start — fine for a portfolio demo).
echo "==> Setting scale bounds min=0 max=1"
az containerapp update \
  -n $APP -g $RG \
  --min-replicas 0 \
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
SFX=agreeablegrass-e36d2a9a.francecentral.azurecontainerapps.io
echo "    curl -sS -i https://$APP.$SFX/             # SPA shell"
echo "    curl -sS -i https://$APP.$SFX/api/health   # proxied to prodstack-api"
echo "    az containerapp logs show -n $APP -g $RG --tail 100 --follow"
