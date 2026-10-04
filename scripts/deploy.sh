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
printf 'Deployed mask %s\n' "$(git rev-parse --short HEAD)"
