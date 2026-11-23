#!/usr/bin/env bash
# Prints the pushed digest on stdout so it can be passed directly to Terraform.
set -euo pipefail
case "${1:-}" in
  api|worker) target=$1 ;;
  *) echo "Usage: $0 api|worker" >&2; exit 2 ;;
esac
root=$(cd "$(dirname "$0")/.." && pwd)
repo=europe-north1-docker.pkg.dev/kinhelse-shared/floorplan-ai
metadata=$(mktemp)
trap 'rm -f "$metadata"' EXIT
docker buildx build --platform linux/amd64 --target "$target" \
  --tag "$repo/$target:$(git -C "$root" rev-parse --short HEAD)-$(date -u +%Y%m%d%H%M%S)" \
  --metadata-file "$metadata" --push --file "$root/approaches/baseline/Dockerfile" "$root" >&2
jq -er '."containerimage.digest" | select(test("^sha256:[0-9a-f]{64}$"))' "$metadata"
