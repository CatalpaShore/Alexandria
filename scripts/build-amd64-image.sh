#!/usr/bin/env bash
set -euo pipefail

IMAGE_NAME="${IMAGE_NAME:-adult-media-wall:amd64}"
OUTPUT="${OUTPUT:-adult-media-wall-linux-amd64.tar}"
BUILDER_NAME="${BUILDER_NAME:-adult-media-wall-builder}"

if ! docker buildx inspect "$BUILDER_NAME" >/dev/null 2>&1; then
  docker buildx create --name "$BUILDER_NAME" --use >/dev/null
else
  docker buildx use "$BUILDER_NAME" >/dev/null
fi

docker buildx build \
  --platform linux/amd64 \
  --tag "$IMAGE_NAME" \
  --output "type=docker,dest=$OUTPUT" \
  .

echo "Built Intel-compatible image archive: $OUTPUT"
echo "Import on the NAS with: docker load -i $OUTPUT"
