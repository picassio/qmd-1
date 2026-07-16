#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT=$PWD
EXPECTED_VERSION=2.6.0
# npm warns about pnpm's auto-install-peers project setting; keep gate output signal-only.
export npm_config_loglevel=error
TMP=$(mktemp -d "${TMPDIR:-/tmp}/qmd-package.XXXXXX")
SERVER_PID=""
cleanup() {
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

fail() {
  echo "package artifact failure: $*" >&2
  exit 1
}

dist_hash() {
  find dist -type f -print0 \
    | LC_ALL=C sort -z \
    | xargs -0 sha256sum \
    | sha256sum \
    | awk '{print $1}'
}

assert_dist_complete() {
  local source relative output
  while IFS= read -r source; do
    relative=${source#src/}
    relative=${relative%.ts}
    for extension in js d.ts; do
      output="dist/${relative}.${extension}"
      [[ -f "$output" ]] || fail "missing build output $output for $source"
    done
  done < <(
    find src -type f -name '*.ts' \
      ! -name '*.test.ts' \
      ! -name 'test-preload.ts' \
      ! -name 'bench-*.ts' \
      | LC_ALL=C sort
  )

  [[ "$(head -c 19 dist/cli/qmd.js)" == "#!/usr/bin/env node" ]] \
    || fail "dist/cli/qmd.js has no portable node shebang"
  [[ -x dist/cli/qmd.js ]] || fail "dist/cli/qmd.js is not executable"
}

echo "==> clean build 1"
rm -rf dist
npm run build --silent
assert_dist_complete
BUILD_ONE=$(dist_hash)

echo "==> clean build 2"
rm -rf dist
npm run build --silent
assert_dist_complete
BUILD_TWO=$(dist_hash)
[[ "$BUILD_ONE" == "$BUILD_TWO" ]] \
  || fail "clean build hashes differ: $BUILD_ONE != $BUILD_TWO"
echo "dist sha256: $BUILD_TWO"

mkdir -p "$TMP/pack-one" "$TMP/pack-two"
npm pack --ignore-scripts --json --pack-destination "$TMP/pack-one" > "$TMP/pack-one.json"
npm pack --ignore-scripts --json --pack-destination "$TMP/pack-two" > "$TMP/pack-two.json"

PACK_NAME=$(node -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))[0]; if(p.name!=="qmd-engine"||p.version!=="2.6.0") process.exit(1); process.stdout.write(p.filename)' "$TMP/pack-one.json")
PACK_ONE="$TMP/pack-one/$PACK_NAME"
PACK_TWO="$TMP/pack-two/$PACK_NAME"
[[ -f "$PACK_ONE" && -f "$PACK_TWO" ]] || fail "npm pack did not create both tarballs"

PACK_HASH_ONE=$(sha512sum "$PACK_ONE" | awk '{print $1}')
PACK_HASH_TWO=$(sha512sum "$PACK_TWO" | awk '{print $1}')
[[ "$PACK_HASH_ONE" == "$PACK_HASH_TWO" ]] \
  || fail "npm tarballs are not reproducible: $PACK_HASH_ONE != $PACK_HASH_TWO"

INTEGRITY_ONE=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))[0].integrity)' "$TMP/pack-one.json")
INTEGRITY_TWO=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))[0].integrity)' "$TMP/pack-two.json")
[[ "$INTEGRITY_ONE" == "$INTEGRITY_TWO" ]] || fail "npm-reported integrity differs"
echo "tarball sha512: $PACK_HASH_ONE"
echo "npm integrity: $INTEGRITY_ONE"

MANIFEST="$TMP/tar-manifest.txt"
tar -tzf "$PACK_ONE" | LC_ALL=C sort > "$MANIFEST"
if grep -Eq '(^|/)node_modules(/|$)' "$MANIFEST"; then
  fail "tarball contains node_modules"
fi
if grep -Ev '^package/(CHANGELOG\.md|LICENSE|README\.md|package\.json|bin/qmd|dist/.+)$' "$MANIFEST" | grep -q .; then
  echo "Unexpected tar entries:" >&2
  grep -Ev '^package/(CHANGELOG\.md|LICENSE|README\.md|package\.json|bin/qmd|dist/.+)$' "$MANIFEST" >&2
  fail "tarball escaped the package allowlist"
fi

while IFS= read -r output; do
  grep -Fxq "package/$output" "$MANIFEST" || fail "tarball missing $output"
done < <(find dist -type f | LC_ALL=C sort)
for required in package/package.json package/bin/qmd package/README.md package/CHANGELOG.md package/LICENSE; do
  grep -Fxq "$required" "$MANIFEST" || fail "tarball missing $required"
done

echo "pack entries: $(wc -l < "$MANIFEST" | tr -d ' ')"

mkdir -p "$TMP/stage"
tar -xzf "$PACK_ONE" -C "$TMP/stage"
PACKAGE_DIR="$TMP/stage/package"
STAGED_PACKAGE=$(node -p "require('$PACKAGE_DIR/package.json').name + '@' + require('$PACKAGE_DIR/package.json').version")
[[ "$STAGED_PACKAGE" == "qmd-engine@$EXPECTED_VERSION" ]] || fail "staged identity is $STAGED_PACKAGE"

mkdir -p "$PACKAGE_DIR/node_modules"
node --input-type=module - "$ROOT" "$PACKAGE_DIR" <<'NODE'
import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
const [root, packageDir] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
const names = [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.optionalDependencies ?? {})];
for (const name of names) {
  if (name === "node-llama-cpp") throw new Error("native peer entered production dependency groups");
  const source = join(root, "node_modules", ...name.split("/"));
  if (!existsSync(source)) continue;
  const target = join(packageDir, "node_modules", ...name.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  symlinkSync(source, target, "dir");
}
NODE
[[ ! -e "$PACKAGE_DIR/node_modules/node-llama-cpp" ]] || fail "staged package contains node-llama-cpp"

export NODE_OPTIONS="--no-warnings --experimental-loader=$ROOT/test/fixtures/deny-native-loader.mjs"
export HOME="$TMP/home"
export XDG_CONFIG_HOME="$TMP/config"
export XDG_CACHE_HOME="$TMP/cache"
mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME"
QMD="$PACKAGE_DIR/bin/qmd"

VERSION_OUTPUT=$($QMD --version)
[[ "$VERSION_OUTPUT" == "qmd $EXPECTED_VERSION" ]] || fail "unexpected version output: $VERSION_OUTPUT"
$QMD status > "$TMP/status.txt"
grep -Fq "QMD Status" "$TMP/status.txt" || fail "packed status smoke failed"

mkdir -p "$TMP/bm25-docs"
printf '# Artifact Contract\n\nquokka-release-marker is searchable.\n' > "$TMP/bm25-docs/note.md"
$QMD collection add "$TMP/bm25-docs" --name package-bm25 > /dev/null
$QMD search quokka-release-marker --json > "$TMP/bm25.json"
grep -Fq 'qmd://package-bm25/note.md' "$TMP/bm25.json" || fail "packed BM25 smoke failed"

export HOME="$TMP/remote-home"
export XDG_CONFIG_HOME="$TMP/remote-config"
export XDG_CACHE_HOME="$TMP/remote-cache"
mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$TMP/remote-docs"
printf '# Remote Artifact\n\nremote-vector-marker is searchable.\n' > "$TMP/remote-docs/note.md"
node "$ROOT/test/fixtures/remote-package-server.mjs" "$TMP/remote-port" "$TMP/remote-counts" &
SERVER_PID=$!
for _ in $(seq 1 200); do
  [[ -s "$TMP/remote-port" ]] && break
  sleep 0.025
done
[[ -s "$TMP/remote-port" ]] || fail "remote smoke server did not start"
PORT=$(<"$TMP/remote-port")
export QMD_COMPAT_MODE=agent-board
export QMD_EMBED_URL="http://127.0.0.1:$PORT"
export QMD_CHAT_URL="$QMD_EMBED_URL"
export QMD_EMBED_MODEL=package-smoke
export QMD_EMBED_DIMS=3
$QMD collection add "$TMP/remote-docs" --name package-remote > /dev/null
$QMD embed > /dev/null
cp "$TMP/remote-counts" "$TMP/remote-counts-before-vsearch"
$QMD vsearch remote-vector-marker --no-expand --json > "$TMP/remote.json"
grep -Fq 'qmd://package-remote/note.md' "$TMP/remote.json" || fail "packed remote vsearch smoke failed"
node -e '
  const fs = require("node:fs");
  const before = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const after = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  if (after.embeddings - before.embeddings !== 1 || after.chat - before.chat !== 0 || after.chat !== 0) {
    console.error({ before, after });
    process.exit(1);
  }
' "$TMP/remote-counts-before-vsearch" "$TMP/remote-counts" \
  || fail "packed remote vsearch did not make exactly one embed and zero chat calls"

kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=""

echo "packed CLI: version/status/BM25/remote vsearch passed without node-llama-cpp"
echo "package artifact contract: PASS"
