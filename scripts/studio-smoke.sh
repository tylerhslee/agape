#!/usr/bin/env bash
# Studio integration smoke test: scaffold a project, start the agent-server
# serving the built web app, and exercise the studio end to end (serve the app,
# detect the project, run a program through the bundled binary). Used by CI.
#
#   SMOKE_PORT=8796 bash scripts/studio-smoke.sh   # override the port locally
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -n "${SMOKE_PORT:-}" ]; then
  PORT="$SMOKE_PORT"
else
  PORT="$(python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
)"
fi

BIN="$ROOT/agape-rs/target/debug/agape"
[ -x "$BIN" ] || BIN="$ROOT/agape-rs/target/release/agape"
[ -x "$BIN" ] || { echo "studio-smoke: no agape binary — build it first (cargo build --bin agape)"; exit 1; }
[ -f "$ROOT/studio/web/dist/index.html" ] || { echo "studio-smoke: web app not built — run 'npm run build' in studio/web"; exit 1; }

PROJ="$(mktemp -d)/app"
"$BIN" init "$PROJ" >/dev/null
echo "studio-smoke: project at $PROJ, port $PORT"

(
  cd "$ROOT/studio/agent-server"
  AGENT_PORT="$PORT" AGAPE_PROJECT="$PROJ" AGAPE_WEB_DIST="$ROOT/studio/web/dist" AGAPE_BIN="$BIN" \
    npx tsx server.ts > /tmp/studio-smoke.log 2>&1
) &
SRV=$!
trap 'kill "$SRV" 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do curl -sf "http://127.0.0.1:$PORT/agent/health" >/dev/null 2>&1 && break; sleep 1; done

fail() { echo "studio-smoke: FAIL — $1"; echo "--- server log ---"; cat /tmp/studio-smoke.log; exit 1; }

curl -sf "http://127.0.0.1:$PORT/agent/health" | grep -q '"ok":true' || fail "health"
curl -sf "http://127.0.0.1:$PORT/" | grep -qi "<!DOCTYPE html>" || fail "web app not served"
curl -sf "http://127.0.0.1:$PORT/project/info" | grep -q '"hasProject":true' || fail "project not detected"
curl -sf -X POST "http://127.0.0.1:$PORT/project/run" -H 'content-type: application/json' \
  -d '{"rel":"main.ag","prompts":{"question":"hello"}}' | grep -q '"ok":true' || fail "project run"

echo "studio-smoke: PASS — served the app, detected the project, ran a program"
