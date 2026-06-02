#!/usr/bin/env bash
# Copy-me template of the env vars a self-hoster must export before running the
# provisioning scripts in infra/. Fill in your own values and source it:
#
#   cp infra/env.example.sh infra/env.local.sh   # keep secrets out of git
#   $EDITOR infra/env.local.sh
#   source infra/env.local.sh
#   bash infra/wire-prodstack-api.sh
#
# All real deployment identifiers (subscription id, owner GitHub id, alert
# email, live FQDNs) are injected from these vars or queried from `az` at
# runtime — the committed scripts contain no real values.

# Azure subscription id. OPTIONAL: if unset, the scripts fall back to the
# subscription of your current `az login` (az account show --query id).
export AZURE_SUBSCRIPTION_ID="your-sub-id"

# Azure resource group holding every ProdStack resource. The scripts default to
# `prodstack` internally; export RG/AZURE_RESOURCE_GROUP if yours differs.
export AZURE_RESOURCE_GROUP="prodstack"
export RG="prodstack"

# Your GitHub NUMERIC user id (NOT the login). Gates the single-user demo in
# wire-prodstack-api.sh. Find it: curl -s https://api.github.com/users/<login> | jq .id
export OWNER_GITHUB_ID="123456"

# Email address that receives the Azure cost-budget alerts (50/80/100%).
# Required by provision-cost-budget.sh.
export BUDGET_ALERT_EMAIL="you@example.com"

# Backend API FQDN — the nginx reverse-proxy upstream on prodstack-web.
# OPTIONAL to export: provision-prodstack-web.sh derives it from Azure at
# runtime (az containerapp ingress show -n prodstack-api). Set it only if you
# want to override the auto-derived value.
export BACKEND_FQDN="prodstack-api.<hash>.<region>.azurecontainerapps.io"

# Container Apps environment domain suffix — the per-deployment env hash, used
# only where a script needs to compose an FQDN without querying ingress.
# OPTIONAL: the scripts here derive FQDNs from `az containerapp ingress show`
# instead, so you normally do not need this.
export ACA_ENV_SUFFIX="<hash>.<region>.azurecontainerapps.io"
