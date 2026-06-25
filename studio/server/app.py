"""app.py — the Agape Studio backend (Phase 1: Python wrapping the live interpreter).

A dependency-free HTTP/JSON API over a single live Agape Session. The React
frontend calls these endpoints; each one either reads the spine or drives the
live interpreter by running a snippet of Agape source against it.

    python studio/server/app.py                       # mock provider, loads console_demo.ag
    python studio/server/app.py --provider anthropic  # real cognition (needs ANTHROPIC_API_KEY)
    python studio/server/app.py --program path/to.ag --port 8765

Endpoints (all JSON):
    GET  /api/state               full snapshot (events + agents + templates)
    GET  /api/spine?since=N       events with tick >= N (the live-tail poll)
    POST /api/load    {source|path}
    POST /api/eval    {source}    run arbitrary Agape against the live world (the REPL)
    POST /api/spawn   {type,name,args}
    POST /api/awake   {name}
    POST /api/sleep   {name}
    POST /api/send    {dest,message,schema?}
    POST /api/prompt  {source,value}   inject one external input arrival (§5b)

The typed lifecycle endpoints are thin sugar: each one builds the equivalent
Agape source and runs it through /api/eval's path, so there is exactly one way a
command reaches the interpreter — as Agape source. That is what makes this a
faithful preview of Phase 2, where the whole router is itself an Agape program.
"""
from __future__ import annotations

import argparse
import errno
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

sys.path.insert(0, os.path.dirname(__file__))
from session import Session, SessionError  # noqa: E402

SESSION: Session  # set in main()
PROGRAMS_DIR = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "programs"))
# In production the backend serves the Vite build output (studio/web/dist). In
# development you instead run `npm run dev` (Vite on :5173) which proxies /api here.
WEB_DIR = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "web", "dist"))


# ── rendering console commands as Agape source ─────────────────────────────────

def _lit(v) -> str:
    """Render a JSON value as an Agape literal."""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return str(v)
    if v is None:
        return "null"
    # text — escape quotes and backslashes
    s = str(v).replace("\\", "\\\\").replace('"', '\\"')
    return f'"{s}"'


_send_seq = 0


def _send_source(dest: str, message: str, schema: str) -> str:
    global _send_seq
    _send_seq += 1
    var = f"_send{_send_seq}"
    return f"event<{schema}> {var} = {dest} <- {_lit(message)};"


# ── HTTP handler ────────────────────────────────────────────────────────────────

class Handler(BaseHTTPRequestHandler):
    server_version = "AgapeStudio/0.1"

    # quieten the default per-request logging
    def log_message(self, fmt, *args):  # noqa: N802
        pass

    # -- CORS so the Vite dev server (5173) can call us --
    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _send_json(self, obj, status: int = 200) -> None:
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        if not length:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8")) if raw else {}
        except json.JSONDecodeError:
            return {}

    def do_OPTIONS(self):  # noqa: N802
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/api/state":
            return self._send_json(SESSION.snapshot())
        if path == "/api/spine":
            qs = parse_qs(parsed.query)
            since = int(qs.get("since", ["0"])[0])
            return self._send_json({"events": SESSION.events_since(since)})
        if path == "/api":
            return self._send_json({
                "service": "Agape Studio backend",
                "phase": "1 (Python wrapping the reference interpreter)",
                "endpoints": ["/api/state", "/api/spine?since=N", "/api/eval",
                              "/api/load", "/api/spawn", "/api/awake", "/api/sleep",
                              "/api/send", "/api/prompt"],
            })
        # Everything else is the static frontend (the React single-page app).
        return self._serve_static("index.html" if path == "/" else path.lstrip("/"))

    def _serve_static(self, rel: str) -> None:
        full = os.path.normpath(os.path.join(WEB_DIR, rel))
        if not full.startswith(WEB_DIR) or not os.path.isfile(full):
            if rel in ("index.html", ""):
                return self._send_json({
                    "error": "frontend not built",
                    "hint": "cd studio/web && npm install && npm run build  "
                            "(or `npm run dev` for the Vite dev server on :5173)",
                }, status=503)
            return self._send_json({"error": f"not found: {rel}"}, status=404)
        ctype = {".html": "text/html", ".js": "text/javascript",
                 ".css": "text/css"}.get(os.path.splitext(full)[1], "application/octet-stream")
        with open(full, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype + "; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):  # noqa: N802
        path = urlparse(self.path).path
        body = self._read_body()
        try:
            result = self._dispatch_post(path, body)
        except SessionError as exc:
            return self._send_json({"error": str(exc), "kind": exc.kind}, status=400)
        except Exception as exc:  # noqa: BLE001
            return self._send_json({"error": f"{type(exc).__name__}: {exc}",
                                    "kind": "server"}, status=500)
        if result is None:
            return self._send_json({"error": f"no such route: {path}"}, status=404)
        return self._send_json(result)

    def _dispatch_post(self, path: str, body: dict):
        if path == "/api/load":
            src = body.get("source")
            program_path = body.get("path")
            if src is None and program_path:
                with open(program_path) as f:
                    src = f.read()
            if src is None:
                raise SessionError("load requires 'source' or 'path'", kind="compile")
            return SESSION.load(src, path=program_path)

        if path == "/api/eval":
            src = body.get("source", "")
            if not src.strip():
                raise SessionError("eval requires non-empty 'source'", kind="compile")
            return SESSION.eval(src)

        if path == "/api/spawn":
            t, name = body["type"], body["name"]
            args = ", ".join(_lit(a) for a in body.get("args", []))
            return SESSION.eval(f"spawn {t} {name}({args});")

        if path == "/api/awake":
            return SESSION.eval(f"awake {body['name']};")

        if path == "/api/sleep":
            return SESSION.eval(f"sleep {body['name']};")

        if path == "/api/send":
            schema = body.get("schema", "text")
            return SESSION.eval(_send_source(body["dest"], body["message"], schema))

        if path == "/api/prompt":
            return SESSION.inject_prompt(body["source"], body["value"])

        return None


# ── entry point ─────────────────────────────────────────────────────────────────

def main() -> None:
    ap = argparse.ArgumentParser(description="Agape Studio backend")
    ap.add_argument("--provider", choices=["mock", "anthropic"], default="mock")
    ap.add_argument("--model", default="claude-haiku-4-5-20251001")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--program", default=os.path.join(PROGRAMS_DIR, "console_demo.ag"),
                    help="path to an .ag program to load on startup")
    args = ap.parse_args()

    global SESSION
    SESSION = Session(provider=args.provider, model=args.model)
    if args.program and os.path.exists(args.program):
        SESSION.load(open(args.program).read(), path=args.program)
        print(f"[studio] loaded {args.program} "
              f"({len(SESSION.spine.log)} events, "
              f"{len(SESSION.interp.instances)} agents)")

    # Bind the requested port, but if it is busy, walk forward to the next free
    # one rather than crashing with "address already in use". The actual URL is
    # printed loudly so you always know where it landed.
    httpd, port = _bind(args.port, Handler)
    print(f"\n[studio] ✓ backend listening on  http://127.0.0.1:{port}", flush=True)
    print(f"[studio]   provider={args.provider}  model={args.model}", flush=True)
    if port != args.port:
        print(f"[studio]   NOTE: requested port {args.port} was busy — using {port}.",
              flush=True)
        print(f"[studio]   For `npm run dev`, set web/vite.config.js proxy to :{port}.",
              flush=True)
    else:
        print(f"[studio]   open that URL directly, or use `npm run dev` (proxies here).",
              flush=True)
    print("[studio] Ctrl-C to stop.", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[studio] stopped.")


def _bind(preferred: int, handler, span: int = 20):
    """Return (server, port): the first bindable port at or after `preferred`."""
    last_err = None
    for port in range(preferred, preferred + span):
        try:
            return ThreadingHTTPServer(("127.0.0.1", port), handler), port
        except OSError as exc:
            if exc.errno in (errno.EADDRINUSE, errno.EACCES):
                last_err = exc
                continue
            raise
    raise SystemExit(
        f"[studio] could not bind any port in {preferred}..{preferred + span - 1} "
        f"({last_err}). Free one up or pass a different --port.")


if __name__ == "__main__":
    main()
