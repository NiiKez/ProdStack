#!/usr/bin/env bash
# Provision (or re-wire) the prodstack-builder Container App. Idempotent —
# safe to re-run after rotating ACR creds, changing env vars, or bumping
# the image tag. Run in Azure Cloud Shell after uploading this file:
#
#   bash provision-prodstack-builder.sh           # tag = m3-manual
#   bash provision-prodstack-builder.sh m3-rev2   # custom tag
#
# Assumes the worker image was already pushed to ACR via
# infra/build-and-push-builder.sh on the laptop.
set -euo pipefail

RG=prodstack
APP=prodstack-builder
ENV_NAME=prodstack-env
# Subscription id: prefer $AZURE_SUBSCRIPTION_ID, else fall back to current az login.
SUB="${AZURE_SUBSCRIPTION_ID:-$(az account show --query id -o tsv)}"
ACR=prodstack
KV_NAME=prodstack-kv
KV=https://$KV_NAME.vault.azure.net/secrets
IDR=identityref:system
TAG="${1:-m3-manual}"
IMAGE="$ACR.azurecr.io/$APP:$TAG"

# --- 1. Create the Container App (or update its image if it already exists)
# Chicken-and-egg note: at *create* time the system-assigned identity doesn't
# exist yet, so we can't use it to pull the first image. We bootstrap with
# ACR admin creds, then switch the pull source to the managed identity in
# step 2 after `AcrPull` is granted.
#
# Resources: 2.0 CPU / 4 GiB. Kaniko snapshots a multi-stage build's full
# filesystem in memory before writing a layer — anything tighter than 4 GiB
# gets the executor SIGKILL'd mid-snapshot for medium-sized images (Go,
# Node) and the build fails with `kaniko exited with code -1`.
ACR_USER=$(az acr credential show -n $ACR --query username -o tsv)
ACR_PASS=$(az acr credential show -n $ACR --query 'passwords[0].value' -o tsv)

if az containerapp show -n $APP -g $RG >/dev/null 2>&1; then
  echo "==> $APP exists; updating image to $IMAGE"
  az containerapp update -n $APP -g $RG --image "$IMAGE" >/dev/null
else
  echo "==> Creating $APP from $IMAGE (no ingress, scale-to-zero 0..1)"
  az containerapp create \
    --name $APP --resource-group $RG \
    --environment $ENV_NAME \
    --image "$IMAGE" \
    --registry-server $ACR.azurecr.io \
    --registry-username "$ACR_USER" \
    --registry-password "$ACR_PASS" \
    --min-replicas 0 --max-replicas 1 \
    --cpu 2.0 --memory 4.0Gi \
    --system-assigned >/dev/null
fi

# --- 2. Grant the managed identity the roles it needs ----------------------
# AcrPull   — pull its own image
# AcrPush   — push images it builds for user projects
# ProdStack Container Apps Operator on RG — custom least-privilege role (replaced
#   broad Contributor 2026-06-12): create/roll/delete user Container Apps via
#   the containerApps.* SDK, and nothing else in the RG. Critical here because
#   this worker runs untrusted user Dockerfiles as root — a compromise must NOT
#   reach Postgres/Key Vault/ACR-config. Create it first with
#   provision-custom-roles.sh (asserted below).
# Key Vault Secrets User — read DB URL, data-enc-key, etc.
ACA_ROLE="ProdStack Container Apps Operator"
if ! az role definition list --name "$ACA_ROLE" --query "[0].roleName" -o tsv 2>/dev/null | grep -q .; then
  echo "ERROR: custom role '$ACA_ROLE' not found. Run infra/provision-custom-roles.sh first." >&2
  exit 1
fi
PRINCIPAL=$(az containerapp show -n $APP -g $RG --query identity.principalId -o tsv)
ACR_ID=$(az acr show -n $ACR --query id -o tsv)
KV_ID=$(az keyvault show -n $KV_NAME --query id -o tsv)
RG_ID=$(az group show -n $RG --query id -o tsv)

echo "==> Assigning RBAC roles to $PRINCIPAL"
for ROLE_SCOPE in \
  "AcrPull:$ACR_ID" \
  "AcrPush:$ACR_ID" \
  "$ACA_ROLE:$RG_ID" \
  "Key Vault Secrets User:$KV_ID"
do
  ROLE="${ROLE_SCOPE%%:*}"
  SCOPE="${ROLE_SCOPE#*:}"
  az role assignment create \
    --assignee "$PRINCIPAL" --role "$ROLE" --scope "$SCOPE" \
    >/dev/null 2>&1 || echo "   (already had $ROLE)"
done

# AcrPull is now in place — switch image pulls from admin creds (used at
# create time) to the managed identity, matching how prodstack-api pulls.
echo "==> Switching image pull source to managed identity"
az containerapp registry set \
  -n $APP -g $RG \
  --server $ACR.azurecr.io \
  --identity system >/dev/null

# --- 3. Key Vault secret refs (shared with prodstack-api) ------------------
echo "==> Setting Key Vault secret references"
az containerapp secret set -n $APP -g $RG --secrets \
  database-url=keyvaultref:$KV/database-url,$IDR \
  jwt-secret=keyvaultref:$KV/jwt-secret,$IDR \
  cookie-secret=keyvaultref:$KV/cookie-secret,$IDR \
  data-enc-key=keyvaultref:$KV/data-enc-key,$IDR \
  gh-client-id=keyvaultref:$KV/github-oauth-client-id,$IDR \
  gh-client-secret=keyvaultref:$KV/github-oauth-client-secret,$IDR \
  >/dev/null

# --- 4. ACR admin creds (kaniko needs docker-config-style auth to push) ----
# Kaniko cannot use the managed identity for `docker push`; it needs a
# username/password pair. Stored in Key Vault and referenced via keyvaultref
# like the shared secrets above (2026-06-12 hardening): a plain Container App
# secret is readable in cleartext by anyone holding listSecrets (incl. this
# app's own RG-Contributor MI, which runs untrusted user Dockerfiles) with no
# KV audit/RBAC gate. Rotation is unchanged: `az acr credential renew` then
# re-run this script — it re-writes the fresh value into the KV secret (this
# script runs as the operator, who holds KV write access).
echo "==> Syncing ACR admin credentials into Key Vault"
ACR_USER=$(az acr credential show -n $ACR --query username -o tsv)
ACR_PASS=$(az acr credential show -n $ACR --query 'passwords[0].value' -o tsv)
az keyvault secret set --vault-name $KV_NAME --name acr-username --value "$ACR_USER" >/dev/null
az keyvault secret set --vault-name $KV_NAME --name acr-password --value "$ACR_PASS" >/dev/null
az containerapp secret set -n $APP -g $RG --secrets \
  acr-username=keyvaultref:$KV/acr-username,$IDR \
  acr-password=keyvaultref:$KV/acr-password,$IDR \
  >/dev/null

# --- 5. Environment variables ---------------------------------------------
# Same 16 the API needs (env.ts is shared) plus 5 worker-specific knobs.
# API origin derived from Azure at runtime. WEB_ORIGIN is the public browser
# origin — the custom domain prodstack.live since 2026-06-08 (docs/CUSTOM_DOMAIN.md),
# overridable via WEB_PUBLIC_ORIGIN. (On the worker WEB_ORIGIN is functionally inert
# — it serves no browser OAuth — but kept consistent with the API wiring.)
API=https://$(az containerapp ingress show -n prodstack-api -g "$RG" --query fqdn -o tsv)
WEB="${WEB_PUBLIC_ORIGIN:-https://prodstack.live}"
ENV_ID=/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.App/managedEnvironments/$ENV_NAME

echo "==> Setting env vars"
az containerapp update -n $APP -g $RG --set-env-vars \
  NODE_ENV=production \
  LOG_LEVEL=info \
  WEB_ORIGIN=$WEB \
  PUBLIC_API_URL=$API \
  GITHUB_OAUTH_CALLBACK_URL=$API/api/auth/github/callback \
  AZURE_STUB=false \
  AZURE_SUBSCRIPTION_ID=$SUB \
  AZURE_RESOURCE_GROUP=$RG \
  AZURE_REGION=francecentral \
  ACR_NAME=$ACR \
  CONTAINER_APPS_ENV_ID=$ENV_ID \
  ENABLE_WORKER=true \
  BUILD_RUNNER_MODE=kaniko \
  BUILD_WORK_DIR=/var/builds \
  BUILD_TIMEOUT_MS=600000 \
  WORKER_POLL_INTERVAL_MS=2000 \
  BUILD_CACHE_ENABLED=false \
  BUILD_CACHE_TTL=168h \
  DATABASE_URL=secretref:database-url \
  JWT_SECRET=secretref:jwt-secret \
  COOKIE_SECRET=secretref:cookie-secret \
  DATA_ENC_KEY=secretref:data-enc-key \
  GITHUB_OAUTH_CLIENT_ID=secretref:gh-client-id \
  GITHUB_OAUTH_CLIENT_SECRET=secretref:gh-client-secret \
  ACR_USERNAME=secretref:acr-username \
  ACR_PASSWORD=secretref:acr-password \
  >/dev/null

# --- 5b. KEDA scale-to-zero rule (cost: builder runs only during builds) ---
# The builder is a 2 vCPU / 4 GiB box that is idle ~99% of the time, so we let
# it scale to 0 replicas and have KEDA wake it 0->1 the instant a build needs
# it. The trigger is a count over the Build table (the queue already lives in
# Postgres). It MUST count in-flight statuses too, not just QUEUED — the moment
# the worker claims a job the status flips QUEUED->CLONING, so a QUEUED-only
# query would hit 0 and scale the container down *mid-build*. READY/FAILED/
# CANCELLED are terminal -> excluded -> replica is free to drop to 0 after the
# 300s cooldown. isDemo=false mirrors claimNextBuild/recoverOwnClaims (demo
# builds never touch this worker). Auth maps KEDA's `connection` param to the
# existing KV-backed database-url secret — no new credential. Idempotent.
echo "==> Setting KEDA scale-to-zero rule (builds-pending)"
az containerapp update -n $APP -g $RG \
  --min-replicas 0 --max-replicas 1 \
  --scale-rule-name builds-pending \
  --scale-rule-type postgresql \
  --scale-rule-metadata \
      "query=SELECT count(*) FROM \"Build\" WHERE \"isDemo\" = false AND status IN ('QUEUED','CLONING','BUILDING','PUSHING','DEPLOYING')" \
      "targetQueryValue=1" \
      "activationTargetQueryValue=0" \
  --scale-rule-auth "connection=database-url" >/dev/null

# --- 6. Show current state -------------------------------------------------
echo "==> Active revision:"
az containerapp revision list -n $APP -g $RG \
  --query "[?properties.active].{name:name, healthState:properties.healthState, runningState:properties.runningState, replicas:properties.replicas}" \
  -o table

echo ""
echo "==> Done. Tail worker logs with:"
echo "    az containerapp logs show -n $APP -g $RG --tail 100 --follow"
