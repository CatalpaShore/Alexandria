#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
VERSION_FILE="$PROJECT_DIR/nas/version.properties"

if [[ ! -f "$VERSION_FILE" ]]; then
  echo "Missing NAS version file: $VERSION_FILE" >&2
  exit 1
fi

# shellcheck disable=SC1090
source "$VERSION_FILE"

IMAGE_NAME="${IMAGE_NAME:-alexandria-webview:${VERSION_NAME}-amd64}"
COMPAT_IMAGE_NAME="${COMPAT_IMAGE_NAME:-alexandria-webview:amd64}"
OUTPUT="${OUTPUT:-$PROJECT_DIR/nas/releases/Alexandria-NAS-WebView-v${VERSION_NAME}-build${BUILD_CODE}-linux-amd64.tar}"
BUILDER_NAME="${BUILDER_NAME:-adult-media-wall-builder}"

mkdir -p "$(dirname "$OUTPUT")"
if [[ -e "$OUTPUT" ]]; then
  echo "Refusing to overwrite existing NAS image archive: $OUTPUT" >&2
  exit 1
fi

if ! docker buildx inspect "$BUILDER_NAME" >/dev/null 2>&1; then
  docker buildx create --name "$BUILDER_NAME" --use >/dev/null
else
  docker buildx use "$BUILDER_NAME" >/dev/null
fi

docker buildx build \
  --platform linux/amd64 \
  --target webview-runtime \
  --tag "$IMAGE_NAME" \
  --tag "$COMPAT_IMAGE_NAME" \
  --output "type=docker,dest=$OUTPUT" \
  "$PROJECT_DIR"

echo "Built Alexandria NAS WebView reverse proxy image: $OUTPUT"
echo "Version: $VERSION_NAME (build $BUILD_CODE)"
echo "Image tags: $IMAGE_NAME, $COMPAT_IMAGE_NAME"
echo "SHA-256: $(shasum -a 256 "$OUTPUT" | awk '{print $1}')"
echo "Import on the NAS with: docker load -i $OUTPUT"
