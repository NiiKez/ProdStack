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
#   ProdStack Container Apps Operator on RG — custom least-privilege role: roll
#                             prodstack-api/prodstack-web (M6 self-deploy) AND
#                             create/roll/delete user Container Apps via the
#                             containerApps.* SDK. Replaced broad Contributor on
#                             2026-06-12 (see provision-custom-roles.sh).
#   AcrPull on ACR          — pull its own image
#   Key Vault Secrets User  — read database-url, data-enc-key, deploy-token, etc.
#   Monitoring Reader on RG — read Azure Monitor metrics for the Metrics tab
#   Log Analytics Reader RG — query ContainerAppConsoleLogs_CL for the Logs tab
# (Monitoring/Log Analytics Reader back the project-observability runtime-logs +
#  metrics tabs; granted by hand 2026-06-03, made durable here so an identity
#  reset re-applies them — the exact orphaning failure mode this script exists for.)
#
# Re-run any time the API app is recreated or its identity is reset. Safe to run
# repeatedly: a duplicate assignment is a no-op ("already had ...").
#
# Least privilege: as of 2026-06-12 this grants the custom
# `ProdStack Container Apps Operator` role (Microsoft.App/containerApps/* +
# managedEnvironments read/join), NOT broad `Contributor` — so a compromise of
# the api (or builder, tightened the same way) can't reach Postgres/Key Vault/
# ACR-config/networking. Create the role first with provision-custom-roles.sh
# (this script asserts it exists and aborts with guidance if not).
set -euo pipefail

RG=prodstack
APP=prodstack-api
ACR=prodstack
KV_NAME=prodstack-kv
ACA_ROLE="ProdStack Container Apps Operator"

# Fail loudly if the custom role hasn't been created yet (one-time bootstrap).
if ! az role definition list --name "$ACA_ROLE" --query "[0].roleName" -o tsv 2>/dev/null | grep -q .; then
  echo "ERROR: custom role '$ACA_ROLE' not found. Run infra/provision-custom-roles.sh first." >&2
  exit 1
fi

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
  "$ACA_ROLE:$RG_ID" \
  "AcrPull:$ACR_ID" \
  "Key Vault Secrets User:$KV_ID" \
  "Monitoring Reader:$RG_ID" \
  "Log Analytics Reader:$RG_ID"
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
