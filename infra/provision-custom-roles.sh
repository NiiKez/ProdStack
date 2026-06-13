#!/usr/bin/env bash
# Create (idempotently) the custom RBAC role that replaces broad `Contributor`
# on the prodstack-api + prodstack-builder managed identities (2026-06-12
# DevSecOps hardening — the "RG-Contributor scope-down"). Run this ONCE before
# grant-prodstack-api-roles.sh / provision-prodstack-builder.sh assign it; safe
# to re-run (creates or updates the definition).
#
# Why: both app identities held Contributor on the whole RG — far more than the
# Microsoft.App/containerApps operations they actually use (roll revisions,
# create/delete user apps, listSecrets for the M6 self-deploy). A container
# compromise (the builder executes untrusted user Dockerfiles as root) therefore
# escalated to full-RG control: delete Postgres, read Key Vault, rewrite the DB
# firewall. This role confines both identities to the Container Apps provider —
# nothing else in the RG is reachable. The action list was derived from
# backend/src/services/azure/containerApps.ts (beginCreateOrUpdate/get/
# listByResourceGroup/listSecrets/beginDelete + the managedEnvironment reference
# at create) and validated against `az provider operation show -n Microsoft.App`.
#
# NOTE: custom role definitions are an ARM resource (Microsoft.Authorization),
# NOT an Entra app registration — so they are NOT blocked by the student-tenant
# SP/OIDC ban. They require the operator to hold Owner / User Access
# Administrator (the subscription owner does).
set -euo pipefail

ROLE_NAME="ProdStack Container Apps Operator"
SUB="${AZURE_SUBSCRIPTION_ID:-$(az account show --query id -o tsv)}"
SCOPE="/subscriptions/$SUB/resourceGroups/prodstack"

ROLE_JSON=$(cat <<JSON
{
  "Name": "$ROLE_NAME",
  "Description": "Least-privilege replacement for Contributor on the prodstack app identities: full Container Apps management (create/update/delete/listSecrets) + read/join the managed environment, and nothing else.",
  "IsCustom": true,
  "Actions": [
    "Microsoft.App/containerApps/*",
    "Microsoft.App/managedEnvironments/read",
    "Microsoft.App/managedEnvironments/join/action",
    "Microsoft.App/locations/*/read"
  ],
  "NotActions": [],
  "DataActions": [],
  "NotDataActions": [],
  "AssignableScopes": ["$SCOPE"]
}
JSON
)

if az role definition list --name "$ROLE_NAME" --query "[0].roleName" -o tsv 2>/dev/null | grep -q .; then
  echo "==> Custom role '$ROLE_NAME' exists — updating definition"
  az role definition update --role-definition "$ROLE_JSON" \
    --query "{name:roleName,actions:permissions[0].actions}" -o json
else
  echo "==> Creating custom role '$ROLE_NAME'"
  az role definition create --role-definition "$ROLE_JSON" \
    --query "{name:roleName,actions:permissions[0].actions}" -o json
fi

echo "==> Done. Now (re-)run grant-prodstack-api-roles.sh + provision-prodstack-builder.sh to assign it."
