#!/usr/bin/env bash
# Package-and-ship: stage a self-contained TypeScript Agape bundle (the CLI
# wrapper, agape-ts runtime, examples, and Studio), archive it with a SHA-256
# sidecar, and verify by running the shipped wrapper with no repo path.
#
#   bash scripts/package.sh                 # bundle for the host platform
#   TARGET=node-linux-x64 bash scripts/package.sh
#   SKIP_STUDIO=1 bash scripts/package.sh   # local iteration only
#
# Output: dist/agape-<version>-<target>.tar.gz (+ .sha256)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

command -v node >/dev/null 2>&1 || { echo "package.sh: node is required"; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "package.sh: npm is required"; exit 1; }

VERSION="$(node -p "require('./agape-ts/package.json').version")"
TARGET="${TARGET:-node-$(node -p "process.platform + '-' + process.arch")}"
NAME="agape-${VERSION}-${TARGET}"
STAGE="$ROOT/dist/$NAME"

echo "==> packaging $NAME"
rm -rf "$STAGE"
mkdir -p "$STAGE/bin" "$STAGE/examples"

# 1. TypeScript runtime + CLI dependencies.
echo "==> staging agape-ts runtime"
tar --exclude="agape-ts/node_modules" --exclude="agape-ts/.agape" -C "$ROOT" -cf - agape-ts | tar -C "$STAGE" -xf -
( cd "$STAGE/agape-ts" && npm install --no-audit --no-fund )

cat > "$STAGE/bin/agape" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
# Resolve symlinks first so the wrapper can be linked onto PATH
# (e.g. ln -s <install>/bin/agape ~/.local/bin/agape). A plain-readlink loop
# keeps this portable to systems without `readlink -f`.
SELF="$0"
while [ -h "$SELF" ]; do
  LINK="$(readlink "$SELF")"
  case "$LINK" in
    /*) SELF="$LINK" ;;
    *)  SELF="$(dirname "$SELF")/$LINK" ;;
  esac
done
DIR="$(cd "$(dirname "$SELF")/.." && pwd)"
exec node "$DIR/agape-ts/node_modules/tsx/dist/cli.mjs" "$DIR/agape-ts/src/cli.ts" "$@"
SH
chmod +x "$STAGE/bin/agape"

# 2. Examples, default manifest, and bundle README.
cp SPEC.md "$STAGE/SPEC.md"
cp agape-ts/examples/*.ag "$STAGE/examples/" 2>/dev/null || true
cat > "$STAGE/agape.toml" <<TOML
[project]
name = "agape-app"
entry = "examples/hello.ag"
language = "$VERSION"

[provider]
backend = "mock"
model = "mock-deterministic"

[memory]
# Project-local, editable markdown memory. The built-in runtime adds classification,
# dedupe/consolidation, automatic memory judgment, and recall ranking.
driver = "markdown"
auto_memory = true
classify = true
dedupe = true
dedupe_threshold = 0.9
recall_pool = 40
path = ".agape/memory"
entrypoint = "MEMORY.md"
top_k = 10
index_lines = 200
index_bytes = 25600
archive_on_forget = true
TOML
cat > "$STAGE/README.md" <<MD
# Agape ${VERSION}

The \`agape\` command in this bundle is a thin wrapper around the TypeScript
Agape runtime in \`agape-ts/\`.

\`\`\`sh
bin/agape run examples/hello.ag
bin/agape check examples/hello.ag
bin/agape studio
\`\`\`

The mock provider works offline with no API key. To use live cognition, set a
provider in your project \`agape.toml\` and put provider keys in the project
\`.env\` or process environment. Default markdown memory writes to the project
root under \`.agape/memory\`.
MD

# 3. Studio is part of the release. The agent server source is staged without
# node_modules/data so installs stay platform-local.
if [ "${SKIP_STUDIO:-}" = "1" ]; then
  echo "==> SKIP_STUDIO=1 - local-only bundle without Studio"
else
  if [ ! -f studio/web/dist/index.html ] || [ "${FORCE_STUDIO_BUILD:-}" = "1" ]; then
    echo "==> building studio web app"
    if [ ! -d studio/web/node_modules ]; then
      ( cd studio/web && npm install --no-audit --no-fund )
    fi
    ( cd studio/web && node "$STAGE/agape-ts/node_modules/vite/bin/vite.js" build )
  else
    echo "==> using existing studio web build"
  fi
  mkdir -p "$STAGE/studio"
  cp -r studio/web/dist "$STAGE/studio/web-dist"
  tar --exclude="studio/agent-server/node_modules" --exclude="studio/agent-server/data" -C "$ROOT" -cf - studio/agent-server | tar -C "$STAGE/studio" --strip-components=1 -xf -
  for f in studio/web-dist/index.html studio/agent-server/server.ts studio/agent-server/package.json; do
    [ -f "$STAGE/$f" ] || { echo "package.sh: studio staging incomplete - missing $f"; exit 1; }
  done
  echo "==> studio staged"
fi

# 4. Archive + checksum.
echo "==> archiving"
cd "$ROOT/dist"
tar -czf "$NAME.tar.gz" "$NAME"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$NAME.tar.gz" > "$NAME.tar.gz.sha256"
else
  shasum -a 256 "$NAME.tar.gz" > "$NAME.tar.gz.sha256"
fi

# 5. Verify: extract to a clean dir and run the shipped wrapper — directly,
# and through a symlink from an unrelated cwd (the PATH-install shape).
echo "==> verifying the shipped TypeScript CLI"
VERIFY="$(mktemp -d)"
tar -xzf "$NAME.tar.gz" -C "$VERIFY"
( cd "$VERIFY/$NAME" && "./bin/agape" run examples/hello.ag >/dev/null )
mkdir -p "$VERIFY/linkbin"
ln -s "$VERIFY/$NAME/bin/agape" "$VERIFY/linkbin/agape"
( cd "$VERIFY" && "./linkbin/agape" run "$VERIFY/$NAME/examples/hello.ag" >/dev/null )
rm -rf "$VERIFY"
rm -rf "$ROOT/dist/$NAME"

echo "==> done: dist/$NAME.tar.gz"
ls -la "$NAME.tar.gz" "$NAME.tar.gz.sha256"