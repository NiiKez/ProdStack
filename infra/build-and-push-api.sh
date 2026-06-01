#!/usr/bin/env bash
# Build the prodstack-api backend image and push to ACR.
#
# Usage: ./infra/build-and-push-api.sh <tag>
#   e.g. ./infra/build-and-push-api.sh m4-rev1
#
# Mirrors the prodstack-builder push flow: docker build with the repo ROOT as
# context (the Dockerfile needs the monorepo lockfile + both workspace
# package.json files), tag for ACR, docker login with admin creds, push.
#
# Prereqs: docker running, az CLI logged in (for `az acr credential show`).

set -euo pipefail

ACR=prodstack
ACR_LOGIN_SERVER=prodstack.azurecr.io
IMAGE=prodstack-api

TAG="${1:-}"
if [[ -z "${TAG}" ]]; then
  echo "usage: $0 <tag>  (e.g. m4-rev1)" >&2
  exit 1
fi

echo "Building ${ACR_LOGIN_SERVER}/${IMAGE}:${TAG} ..."
docker build -t "${ACR_LOGIN_SERVER}/${IMAGE}:${TAG}" -f backend/Dockerfile .

echo "Logging in to ACR ${ACR} ..."
ACR_USER=$(az acr credential show --name "${ACR}" --query username -o tsv)
ACR_PASS=$(az acr credential show --name "${ACR}" --query "passwords[0].value" -o tsv)
echo "${ACR_PASS}" | docker login "${ACR_LOGIN_SERVER}" -u "${ACR_USER}" --password-stdin

echo "Pushing ${ACR_LOGIN_SERVER}/${IMAGE}:${TAG} ..."
docker push "${ACR_LOGIN_SERVER}/${IMAGE}:${TAG}"

echo "Done. Roll the revision with:"
echo "  az containerapp update -n prodstack-api -g prodstack --image ${ACR_LOGIN_SERVER}/${IMAGE}:${TAG}"
