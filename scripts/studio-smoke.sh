#!/usr/bin/env bash
# Studio integration smoke test: scaffold a project, start the agent-server
# serving the built web app, and exercise Studio end to end (serve the app,
# detect the project, run a program through agape-ts). Used by CI.
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

AGAPE_TS_CLI="$ROOT/agape-ts/src/cli.ts"
TSX_CLI="$ROOT/agape-ts/node_modules/tsx/dist/cli.mjs"
[ -f "$AGAPE_TS_CLI" ] || { echo "studio-smoke: missing agape-ts CLI"; exit 1; }
[ -f "$TSX_CLI" ] || { echo "studio-smoke: missing agape-ts deps - run 'npm install' in agape-ts"; exit 1; }
[ -f "$ROOT/studio/web/dist/index.html" ] || { echo "studio-smoke: web app not built - run 'npm run build' in studio/web"; exit 1; }

PROJ="$(mktemp -d)/app"
mkdir -p "$PROJ"
cat > "$PROJ/agape.toml" <<TOML
[project]
name = "Smoke Fixture"
language = "1.0.0-alpha.2026.7.11.2"

[memory]
driver = "markdown"
path = ".agape/memory"
TOML
cat > "$PROJ/main.ag" <<'AG'
prompt text question;
enum Verdict { Accept, Reject }
action Reply(text answer);
agent Responder grants { perform Reply } {
  when (Prompt p about question) {
    text answer = f"smoke: {p.text}";
    Credence<Verdict> c = self <- f"safe to send: {answer}";
    Decision<Verdict> d = decide c by confidence 0.5;
    if (d.committed == Accept) {
      Endorsement<text> e = endorse answer by d;
      perform Reply(e);
    }
  }
}
spawn Responder responder;
awake responder;
AG

echo "studio-smoke: project at $PROJ, port $PORT"

(
  cd "$ROOT/studio/agent-server"
  AGENT_PORT="$PORT" \
  AGAPE_PROJECT="$PROJ" \
  AGAPE_WEB_DIST="$ROOT/studio/web/dist" \
  AGAPE_TS_CLI="$AGAPE_TS_CLI" \
  TSX_CLI="$TSX_CLI" \
  AGENT_COGNITION_PROVIDER="mock" \
  AGENT_EMBEDDING_PROVIDER="local" \
    node "$TSX_CLI" server.ts > /tmp/studio-smoke.log 2>&1
) &
SRV=$!
trap 'kill "$SRV" 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do curl -sf "http://127.0.0.1:$PORT/agent/health" >/dev/null 2>&1 && break; sleep 1; done

fail() { echo "studio-smoke: FAIL - $1"; echo "--- server log ---"; cat /tmp/studio-smoke.log; exit 1; }

curl -sf "http://127.0.0.1:$PORT/agent/health" | grep -q '"ok":true' || fail "health"
curl -sf "http://127.0.0.1:$PORT/" | grep -qi "<!DOCTYPE html>" || fail "web app not served"
curl -sf "http://127.0.0.1:$PORT/project/info" | grep -q '"hasProject":true' || fail "project not detected"
curl -sf -X POST "http://127.0.0.1:$PORT/project/run" -H 'content-type: application/json' \
  -d '{"rel":"main.ag","prompts":{"question":"hello"}}' | grep -q '"ok":true' || fail "project run"

echo "studio-smoke: PASS - served the app, detected the project, ran a program"