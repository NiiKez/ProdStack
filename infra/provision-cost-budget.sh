#!/usr/bin/env bash
# Provision the cost-safeguard budget: an Azure Cost Management budget
# `prodstack-monthly` at $20/mo with email alerts at 50/80/100% of actual spend
# ($20 is a comfortable ceiling under a small subscription credit). Idempotent:
# the REST PUT upserts the budget, so re-running just refreshes it.
#
# Scope is the whole subscription (the student subscription holds only this
# project, so a subscription-scoped budget == the project budget). The Consumption
# budgets API requires `startDate` to be the first day of a month; we compute the
# first of the current month so the budget starts this billing period.
#
#   bash infra/provision-cost-budget.sh
#
# Verify afterwards:
#   az consumption budget list -o table
set -euo pipefail

SUB=$(az account show --query id -o tsv)
NAME=prodstack-monthly
AMOUNT=20
EMAIL="${BUDGET_ALERT_EMAIL:?set to the budget-alert email address}"
START=$(date -u +%Y-%m-01)T00:00:00Z
END=$(date -u -d '+5 years' +%Y-%m-01)T00:00:00Z
API=2023-05-01
URL="https://management.azure.com/subscriptions/${SUB}/providers/Microsoft.Consumption/budgets/${NAME}?api-version=${API}"

BODY=$(cat <<JSON
{
  "properties": {
    "category": "Cost",
    "amount": ${AMOUNT},
    "timeGrain": "Monthly",
    "timePeriod": { "startDate": "${START}", "endDate": "${END}" },
    "notifications": {
      "actual_GreaterThan_50_Percent": {
        "enabled": true, "operator": "GreaterThanOrEqualTo", "threshold": 50,
        "contactEmails": ["${EMAIL}"], "thresholdType": "Actual"
      },
      "actual_GreaterThan_80_Percent": {
        "enabled": true, "operator": "GreaterThanOrEqualTo", "threshold": 80,
        "contactEmails": ["${EMAIL}"], "thresholdType": "Actual"
      },
      "actual_GreaterThan_100_Percent": {
        "enabled": true, "operator": "GreaterThanOrEqualTo", "threshold": 100,
        "contactEmails": ["${EMAIL}"], "thresholdType": "Actual"
      }
    }
  }
}
JSON
)

echo "==> Upserting budget '${NAME}' (\$${AMOUNT}/mo, alerts 50/80/100% → ${EMAIL})"
echo "    scope: subscription ${SUB}"
echo "    period: ${START} .. ${END}"
TMP=$(mktemp)
printf '%s' "$BODY" > "$TMP"
az rest --method put --url "$URL" --headers "Content-Type=application/json" --body "@$TMP"
rm -f "$TMP"

echo "==> Done. Current budgets:"
az consumption budget list --query "[].{name:name, amount:amount, timeGrain:timeGrain}" -o table
