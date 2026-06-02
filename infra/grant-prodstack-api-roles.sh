#!/usr/bin/env bash
# Idempotently (re)assert the RBAC roles the prodstack-api managed identity needs.
#
# Why this exists: the API's roles were originally granted by hand during M2
# setup, and there was no script to re-apply them. When a Container App's
# system-assigned identity is toggled off/on (or the app is recreated) it gets a
# BRAND NEW principalId, and any role assignments on the old principal are
# orphaned — the app silently loses its access. That is exactly what happened
# here: an audit on 2026-06-01 found the live API identity holding only
# `AcrPull` + `Key Vault Secrets User` and NO `Contributor`, even though the
# docs assumed it had it. That gap breaks M6 self-deploy: POST /api/admin/deploy
# calls containerApps.beginCreateOrUpdate() as the API's identity, which needs
# Microsoft.App/containerApps/write (Contributor) or it 403s.
#
# Roles granted (matches infra/provision-prodstack-builder.sh's pattern):
#   Contributor on RG       — roll prodstack-api/prodstack-web (M6 self-deploy)
#                             AND roll user Container Apps via updateContainerApp()
#   AcrPull on ACR          — pull its own image
#   Key Vault Secrets User  — read database-url, data-enc-key, deploy-token, etc.
#
# Re-run any time the API app is recreated or its identity is reset. Safe to run
# repeatedly: a duplicate assignment is a no-op ("already had ...").
#
# NOTE on least privilege: v1 deliberately uses broad `Contributor` on the RG
# (custom-role tightening is a stretch goal). A future hardening
# is a custom role limited to Microsoft.App/containerApps read|write +
# .../listSecrets/action, scoped to just the platform apps. The builder MI has
# the same broad Contributor today, so tighten both together if/when you do it.
set -euo pipefail

RG=prodstack
APP=prodstack-api
ACR=prodstack
KV_NAME=prodstack-kv

# Use --assignee-object-id (NOT --assignee): the deployment Entra tenant blocks
# directory/Graph reads, so the Graph
# lookup that plain --assignee performs can 401. Passing the objectId +
# principal type skips that lookup.
PRINCIPAL=$(az containerapp show -n "$APP" -g "$RG" --query identity.principalId -o tsv)
ACR_ID=$(az acr show -n "$ACR" --query id -o tsv)
KV_ID=$(az keyvault show -n "$KV_NAME" --query id -o tsv)
RG_ID=$(az group show -n "$RG" --query id -o tsv)

echo "==> prodstack-api identity principalId: $PRINCIPAL"
echo "==> Asserting RBAC roles"
for ROLE_SCOPE in \
  "Contributor:$RG_ID" \
  "AcrPull:$ACR_ID" \
  "Key Vault Secrets User:$KV_ID"
do
  ROLE="${ROLE_SCOPE%%:*}"
  SCOPE="${ROLE_SCOPE#*:}"
  # Capture stderr so a genuine failure (RBAC propagation, transient 5xx, wrong
  # scope) isn't silently reported as "already had" — only an actual
  # already-exists conflict is. A real error aborts (set -e + explicit exit) so
  # the script can't claim success while a role is missing.
  if OUT=$(az role assignment create \
      --assignee-object-id "$PRINCIPAL" \
      --assignee-principal-type ServicePrincipal \
      --role "$ROLE" --scope "$SCOPE" 2>&1); then
    echo "   ensured $ROLE"
  elif printf '%s' "$OUT" | grep -qiE 'already exist|RoleAssignmentExists'; then
    echo "   (already had $ROLE)"
  else
    echo "   ERROR granting $ROLE:" >&2
    printf '%s\n' "$OUT" >&2
    exit 1
  fi
done

echo "==> Current assignments for $PRINCIPAL:"
# --assignee-object-id (not --assignee) here too: the locked-down uni tenant can
# 401 the Graph lookup plain --assignee performs (same reason as the create above).
az role assignment list --assignee-object-id "$PRINCIPAL" --all \
  --query "[].{role:roleDefinitionName, scope:scope}" -o table
