#!/usr/bin/env bash

set -euo pipefail

ACTION="${1:-}"
SOURCE_WORKER_IMAGE="${2:-}"
BASE_IMAGE="spark-x-test-platform-playwright-base:node22.18.0-pw1.55.1"
RESOURCE_DIR="/data/repo/resources/spark-x-test-platform/images"
ARCHIVE_NAME="spark-x-test-platform-playwright-base-node22.18.0-pw1.55.1.tar"
ARCHIVE="$RESOURCE_DIR/$ARCHIVE_NAME"

usage() {
  echo "usage: manage-playwright-base.sh <build|promote-worker|verify|export> [worker-image]" >&2
  exit 64
}

verify_image() {
  local node_version
  local playwright_version
  node_version="$(docker image inspect --format '{{ index .Config.Labels "com.spark-x.test-platform.node-version" }}' "$BASE_IMAGE")"
  playwright_version="$(docker image inspect --format '{{ index .Config.Labels "com.spark-x.test-platform.playwright-version" }}' "$BASE_IMAGE")"
  test "$node_version" = "22.18.0"
  test "$playwright_version" = "1.55.1"
  docker run --rm --entrypoint sh "$BASE_IMAGE" -c \
    'test "$(node --version)" = "v22.18.0" && test -n "$(find /ms-playwright -type f -name headless_shell -perm /111 -print -quit)"'
}

export_resource() {
  mkdir -p "$RESOURCE_DIR"
  local temporary_archive
  temporary_archive="$(mktemp "$RESOURCE_DIR/.playwright-base.XXXXXX.tar")"
  trap 'rm -f "$temporary_archive"' RETURN
  docker save --output "$temporary_archive" "$BASE_IMAGE"
  mv "$temporary_archive" "$ARCHIVE"
  chmod 0644 "$ARCHIVE"
  (
    cd "$RESOURCE_DIR"
    sha256sum "$ARCHIVE_NAME" > "$ARCHIVE_NAME.sha256.tmp"
    mv "$ARCHIVE_NAME.sha256.tmp" "$ARCHIVE_NAME.sha256"
    chmod 0644 "$ARCHIVE_NAME.sha256"
  )
  trap - RETURN
  echo "Playwright base resource exported: $ARCHIVE"
}

build_image() {
  docker build \
    --file infra/compose/Dockerfile.playwright-base \
    --tag "$BASE_IMAGE" \
    .
  verify_image
}

promote_worker_image() {
  if [[ ! "$SOURCE_WORKER_IMAGE" =~ ^spark-x-test-platform-worker:[0-9a-f]{40}$ ]]; then
    echo "source Worker image must be an immutable Spark X Test Platform commit image" >&2
    exit 65
  fi
  docker image inspect "$SOURCE_WORKER_IMAGE" >/dev/null
  docker run --rm --entrypoint sh "$SOURCE_WORKER_IMAGE" -c \
    'test "$(node --version)" = "v22.18.0" && test -n "$(find /ms-playwright -type f -name headless_shell -perm /111 -print -quit)"'

  local container
  container="spark-x-playwright-base-promote-$$"
  trap 'docker rm -f "$container" >/dev/null 2>&1 || true' RETURN
  docker create \
    --name "$container" \
    --user 0:0 \
    --entrypoint sh \
    "$SOURCE_WORKER_IMAGE" \
    -c 'find /app -mindepth 1 -depth -delete' >/dev/null
  docker start --attach "$container" >/dev/null
  docker export "$container" | docker import \
    --change 'ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright' \
    --change 'WORKDIR /app' \
    --change 'LABEL com.spark-x.test-platform.node-version=22.18.0' \
    --change 'LABEL com.spark-x.test-platform.playwright-version=1.55.1' \
    --change "LABEL com.spark-x.test-platform.promoted-from=$SOURCE_WORKER_IMAGE" \
    - "$BASE_IMAGE" >/dev/null
  docker rm "$container" >/dev/null
  trap - RETURN
  verify_image
}

case "$ACTION" in
  build)
    build_image
    export_resource
    ;;
  promote-worker)
    promote_worker_image
    export_resource
    ;;
  verify)
    verify_image
    ;;
  export)
    verify_image
    export_resource
    ;;
  *) usage ;;
esac
