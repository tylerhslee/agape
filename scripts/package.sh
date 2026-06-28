#!/usr/bin/env bash
# Package-and-ship: stage a self-contained Agape bundle (the `agape` binary —
# compiler + runtime — plus the studio and a runnable example), archive it with a
# SHA-256 sidecar, and verify by running the *shipped* binary with no repo present.
#
#   bash scripts/package.sh              # bundle for the host target
#   TARGET=x86_64-unknown-linux-gnu ...  # name the artifact for a cross target
#   SKIP_STUDIO=1 bash scripts/package.sh  # binary-only (skip the Node studio)
#
# Output: dist/agape-<version>-<target>.tar.gz (+ .sha256)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# `tr -d` strips any CR — rustc -vV emits CRLF on Windows, which would otherwise
# corrupt the bundle name and break the verify step.
VERSION="$(grep -m1 '^version' agape-rs/Cargo.toml | sed -E 's/.*"([^"]+)".*/\1/' | tr -d '\r\n')"
TARGET="$(printf '%s' "${TARGET:-$(rustc -vV | sed -n 's/host: //p')}" | tr -d '\r\n')"
NAME="agape-${VERSION}-${TARGET}"
STAGE="$ROOT/dist/$NAME"

echo "==> packaging $NAME"
rm -rf "$STAGE"
mkdir -p "$STAGE/bin" "$STAGE/examples"

# 1. the binary: compiler + runtime, one self-contained download
echo "==> building release binary"
cargo build --release --manifest-path agape-rs/Cargo.toml --bin agape
BINEXT=""; [ "${TARGET}" != "${TARGET%windows*}" ] && BINEXT=".exe"
cp "agape-rs/target/release/agape${BINEXT}" "$STAGE/bin/agape${BINEXT}"

# 2. a runnable example, a default manifest, and a bundle README
cp agape-rs/examples/*.ag "$STAGE/examples/" 2>/dev/null || true
cat > "$STAGE/examples/hello.ag" <<'AG'
// hello.ag — the smallest Agape program: an agent thinks, gates, and records.
agent Greeter {
  on awake {
    Credence<bool> ready = self <- "is this thing on?";
    endorse (ready by confidence 0.8) {
      true:  emit Event("hello from agape");
      false: ;
    }
  }
}
spawn Greeter g;
awake g;
AG
cat > "$STAGE/agape.toml" <<TOML
[project]
name = "agape-app"
entry = "examples/hello.ag"

[provider]
# mock (offline, deterministic) by default; \`agape configure provider claude\`
# switches to a live model via the studio.
backend = "mock"
model = "claude-haiku-4-5"

[runtime]
samples = 5
TOML
cat > "$STAGE/README.md" <<MD
# Agape ${VERSION}

The \`agape\` CLI: the language, compiler, runtime, and studio in one bundle.

\`\`\`
bin/agape run examples/hello.ag      # run a program → its event spine
bin/agape check examples/hello.ag    # static guarantees only
bin/agape init my-app                # scaffold a new project
bin/agape build                      # check every .ag, emit .agape/build.json
bin/agape configure provider claude  # switch the cognition seam to a live model
bin/agape studio                     # open Agape Studio (needs Node)
\`\`\`

The mock provider ships in-box, so \`run\` works offline with no API key. Real
cognition is one config step away (\`configure provider claude\` + an
\`ANTHROPIC_API_KEY\`). Put \`bin/\` on your PATH to call \`agape\` directly.
MD

# 3. the studio (best-effort — a studio build must never fail the release). The
#    agent-server serves the prebuilt web app (one process, no Vite at runtime). We
#    ship the agent-server SOURCE and let deps install on first `agape studio`, so
#    the archive carries no native modules / deep node_modules paths (portable +
#    Windows-safe).
if [ "${SKIP_STUDIO:-}" != "1" ] && command -v npm >/dev/null 2>&1; then
  if ( cd studio/web && npm install --no-audit --no-fund && npm run build ); then
    mkdir -p "$STAGE/studio"
    cp -r studio/web/dist "$STAGE/studio/web-dist"
    cp -r studio/agent-server "$STAGE/studio/agent-server"
    rm -rf "$STAGE/studio/agent-server/node_modules" "$STAGE/studio/agent-server/data"
    echo "==> studio staged (its deps install on first \`agape studio\`)"
  else
    echo "==> WARNING: studio web build failed — shipping a binary-only bundle"
    rm -rf "$STAGE/studio"
  fi
else
  echo "==> skipping studio (SKIP_STUDIO or npm unavailable) — binary-only bundle"
fi

# 4. archive + checksum
echo "==> archiving"
cd "$ROOT/dist"
tar -czf "$NAME.tar.gz" "$NAME"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$NAME.tar.gz" > "$NAME.tar.gz.sha256"
else
  shasum -a 256 "$NAME.tar.gz" > "$NAME.tar.gz.sha256"
fi

# 5. verify: extract to a clean dir and run the SHIPPED binary — no repo, no source.
echo "==> verifying the shipped binary"
VERIFY="$(mktemp -d)"
tar -xzf "$NAME.tar.gz" -C "$VERIFY"
( cd "$VERIFY/$NAME" && "./bin/agape${BINEXT}" run examples/hello.ag >/dev/null )
rm -rf "$VERIFY"

echo "==> done: dist/$NAME.tar.gz"
ls -la "$NAME.tar.gz" "$NAME.tar.gz.sha256"
