#!/usr/bin/env bash
# Security observability + Key Vault tamper-protection hardening (2026-06-12).
# Idempotent — safe to re-run. Run in Azure Cloud Shell or with a logged-in az:
#   bash provision-security-logging.sh
#
# Closes two DevSecOps gaps found in the 2026-06-12 review:
#   H1 — no forensic trail. Key Vault secret reads and Postgres connections were
#        not shipped anywhere, so a credential leak (the DB is reachable
#        cross-tenant; see the firewall constraint in CLAUDE.md) left no record
#        of WHO read WHICH secret WHEN or WHAT IP connected. We route Key Vault
#        AuditEvent + Postgres logs into the existing free `prodstack-logs`
#        Log Analytics workspace (no new cost — same 5 GB/mo free grant the
#        app's runtime logs already use).
#   M-KV — Key Vault purge protection was off, so a compromised identity with
#        RG Contributor (both the api and builder MIs hold it) could PERMANENTLY
#        delete `data-enc-key` during the 90-day soft-delete window, making every
#        encrypted DB row undecryptable. We turn purge protection ON (one-way).
#
# NOTE: the `az monitor` / `rdbms` CLI modules are broken in this student-sub
# environment (module load errors), so diagnostic settings are created via the
# ARM REST API (`az rest`) instead of `az monitor diagnostic-settings create`.
set -euo pipefail

RG=prodstack
KV_NAME=prodstack-kv
PG_NAME=prodstack-db
WS_NAME=prodstack-logs
SUB="${AZURE_SUBSCRIPTION_ID:-$(az account show --query id -o tsv)}"

WS_ID="/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.OperationalInsights/workspaces/$WS_NAME"
KV_ID="/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.KeyVault/vaults/$KV_NAME"
PG_ID="/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.DBforPostgreSQL/flexibleServers/$PG_NAME"
DIAG_API=2021-05-01-preview

# --- 0. Resource provider --------------------------------------------------
# Diagnostic settings live under Microsoft.Insights; the student sub is not
# registered for it by default → a PUT 400s with SubscriptionNotRegistered.
# Registration is async (~1-3 min) and idempotent.
echo "==> Ensuring microsoft.insights provider is registered"
STATE=$(az provider show --namespace microsoft.insights --query registrationState -o tsv 2>/dev/null || echo NotRegistered)
if [ "$STATE" != "Registered" ]; then
  az provider register --namespace microsoft.insights >/dev/null
  echo "    registering (was: $STATE) — polling until Registered..."
  for _ in $(seq 1 30); do
    STATE=$(az provider show --namespace microsoft.insights --query registrationState -o tsv)
    [ "$STATE" = "Registered" ] && break
    sleep 10
  done
fi
echo "    microsoft.insights: $STATE"

# --- 1. Key Vault purge protection (M-KV) ----------------------------------
# One-way switch — cannot be turned off once on. Protects the irreplaceable
# `data-enc-key` from a hard-delete during the soft-delete window.
echo "==> Enabling Key Vault purge protection (irreversible)"
az keyvault update -n "$KV_NAME" --enable-purge-protection true \
  --query "{purge:properties.enablePurgeProtection,softDeleteDays:properties.softDeleteRetentionInDays}" -o table

# --- 2. Key Vault audit logging (H1) ---------------------------------------
# AuditEvent = one row per secret get/set/list. AzurePolicyEvaluationDetails is
# cheap and useful for policy drift. Routed to the existing free workspace.
echo "==> Key Vault diagnostic setting -> $WS_NAME (AuditEvent)"
az rest --method PUT \
  --url "https://management.azure.com${KV_ID}/providers/Microsoft.Insights/diagnosticSettings/prodstack-kv-audit?api-version=${DIAG_API}" \
  --body "{\"properties\":{\"workspaceId\":\"${WS_ID}\",\"logs\":[{\"category\":\"AuditEvent\",\"enabled\":true},{\"category\":\"AzurePolicyEvaluationDetails\",\"enabled\":true}]}}" \
  --query "{name:name,logs:properties.logs[?enabled].category}" -o json

# --- 3. Postgres connection/error logging (H1) -----------------------------
# PostgreSQLLogs carries the server log incl. connection/disconnection lines.
# log_connections/log_disconnections are already `on` by default on Flexible
# Server, so once this setting routes the log to the workspace, every connect
# (with source IP) is captured — the forensic trail for the cross-tenant-open
# firewall. Add PostgreSQLFlexSessions if you want active-session snapshots too
# (higher volume; left off to stay inside the free workspace grant).
echo "==> Postgres diagnostic setting -> $WS_NAME (PostgreSQLLogs)"
az rest --method PUT \
  --url "https://management.azure.com${PG_ID}/providers/Microsoft.Insights/diagnosticSettings/prodstack-db-logs?api-version=${DIAG_API}" \
  --body "{\"properties\":{\"workspaceId\":\"${WS_ID}\",\"logs\":[{\"category\":\"PostgreSQLLogs\",\"enabled\":true}]}}" \
  --query "{name:name,logs:properties.logs[?enabled].category}" -o json

echo ""
echo "==> Done. Query the audit trail in Log Analytics after ~5-10 min:"
echo "    AzureDiagnostics | where ResourceProvider == 'MICROSOFT.KEYVAULT' | project TimeGenerated, OperationName, identity_claim_upn_s, CallerIPAddress"
echo "    AzureDiagnostics | where ResourceProvider == 'MICROSOFT.DBFORPOSTGRESQL' | project TimeGenerated, Message"
