#!/usr/bin/env bash
# One-shot wiring of prodstack-api Container App: pulls 6 secrets from Key
# Vault via managed identity and sets the env vars the backend's Zod schema
# requires (incl. OWNER_GITHUB_ID for the single-user gate). Run in Azure
# Cloud Shell after uploading this file:
#   bash wire-prodstack-api.sh
set -euo pipefail

APP="--name prodstack-api --resource-group prodstack"
KV=https://prodstack-kv.vault.azure.net/secrets
IDR=identityref:system

echo "==> Setting 6 Key Vault secret references on the Container App..."
az containerapp secret set $APP --secrets \
  database-url=keyvaultref:$KV/database-url,$IDR \
  jwt-secret=keyvaultref:$KV/jwt-secret,$IDR \
  cookie-secret=keyvaultref:$KV/cookie-secret,$IDR \
  data-enc-key=keyvaultref:$KV/data-enc-key,$IDR \
  gh-client-id=keyvaultref:$KV/github-oauth-client-id,$IDR \
  gh-client-secret=keyvaultref:$KV/github-oauth-client-secret,$IDR

SUB=ef9839d4-9a6c-4837-9afc-00ab2cd978f5
SFX=agreeablegrass-e36d2a9a.francecentral.azurecontainerapps.io
API=https://prodstack-api.$SFX
WEB=https://prodstack-web.$SFX
ENV_PATH=Microsoft.App/managedEnvironments/prodstack-env
ENV_ID=/subscriptions/$SUB/resourceGroups/prodstack/providers/$ENV_PATH

# NOTE (2026-06-01, M5 frontend): the OAuth callback lives on the WEB origin,
# not the API. prodstack-web's nginx reverse-proxies /api to the backend, so the
# browser runs the whole OAuth round-trip on the prodstack-web origin. The
# callback MUST land there too — otherwise the signed `oauth_state` cookie (set
# on the web origin during /github/begin) is never sent back and the callback
# 400s with OAUTH_STATE_MISMATCH. PUBLIC_API_URL stays the API origin because
# GitHub *webhooks* post server-to-server straight to the backend, not via nginx.
# The same web-origin URL must also be registered in the GitHub OAuth App (a
# manual step — there is no API to edit OAuth App callback URLs).
echo "==> Setting environment variables on the Container App..."
az containerapp update $APP --set-env-vars \
  NODE_ENV=production \
  WEB_ORIGIN=$WEB \
  PUBLIC_API_URL=$API \
  GITHUB_OAUTH_CALLBACK_URL=$WEB/api/auth/github/callback \
  AZURE_STUB=false \
  AZURE_SUBSCRIPTION_ID=$SUB \
  AZURE_RESOURCE_GROUP=prodstack \
  AZURE_REGION=francecentral \
  ACR_NAME=prodstack \
  CONTAINER_APPS_ENV_ID=$ENV_ID \
  OWNER_GITHUB_ID=182921896 \
  DATABASE_URL=secretref:database-url \
  JWT_SECRET=secretref:jwt-secret \
  COOKIE_SECRET=secretref:cookie-secret \
  DATA_ENC_KEY=secretref:data-enc-key \
  GITHUB_OAUTH_CLIENT_ID=secretref:gh-client-id \
  GITHUB_OAUTH_CLIENT_SECRET=secretref:gh-client-secret

echo "==> Current revisions:"
az containerapp revision list $APP --output table

echo "==> Done. Wait ~60s, then curl:"
echo "    curl -i $API/healthz"
