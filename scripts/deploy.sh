#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

[[ "$(git branch --show-current)" == main ]] || { echo 'Expected main branch' >&2; exit 1; }
git diff --quiet && git diff --cached --quiet || { echo 'Tracked local changes; commit or stash them before deploying' >&2; exit 1; }
git pull --ff-only origin main

npm ci
npm run check
systemctl --user restart mask.service
systemctl --user is-active --quiet mask.service || { echo 'mask.service failed to start' >&2; exit 1; }

healthy=false
for ((attempt = 1; attempt <= 20; attempt++)); do
  if curl --fail --silent --show-error --max-time 2 http://127.0.0.1:8787/healthz >/dev/null 2>&1; then
    healthy=true
    break
  fi
  sleep 1
done
[[ "$healthy" == true ]] || { echo 'Mask health check failed' >&2; exit 1; }

npm run smoke:openclaw-glm
printf 'Deployed mask %s\n' "$(git rev-parse --short HEAD)"
