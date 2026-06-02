#!/usr/bin/env bash
# Build the prodstack-builder worker image on the laptop and push to ACR.
# Mirrors the manual API image push (build at the repo root, push with ACR creds).
# Run from anywhere; cd's to the repo root automatically.
#
#   bash infra/build-and-push-builder.sh           # tag = m3-manual
#   bash infra/build-and-push-builder.sh m3-rev2   # custom tag
#
# Requires `docker login prodstack.azurecr.io` to have been run once.
set -euo pipefail

cd "$(dirname "$0")/.."

TAG="${1:-m3-manual}"
IMG="prodstack.azurecr.io/prodstack-builder:$TAG"

echo "==> Building $IMG (context = repo root, dockerfile = worker/Dockerfile)"
docker build -t "$IMG" -f worker/Dockerfile .

echo "==> Pushing $IMG"
docker push "$IMG"

echo "==> Done. Now run in Cloud Shell:"
echo "    bash provision-prodstack-builder.sh $TAG"
