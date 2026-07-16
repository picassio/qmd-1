#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
tmp=$(mktemp -d "${TMPDIR:-/tmp}/qmd-npm-ci.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

cp package.json package-lock.json "$tmp/"
[[ ! -e "$tmp/node_modules" ]]
(
  cd "$tmp"
  npm ci --ignore-scripts --no-audit --no-fund
)
