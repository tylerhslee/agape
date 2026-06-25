# Agape Studio

The IDLE/phpMyAdmin of Agape — a web console for **event-driven management**.
PHP ships with phpMyAdmin; Python ships with IDLE; Agape ships with Studio: a
browser IDE for driving a running Agape program and watching its **event spine**
(SPEC §7) in real time.

The frontend is React. The backend is an **Agape program** — eventually. We get
there in two phases (per the build plan):

- **Phase 1 (here now): traditional tools.** The backend is Python wrapping the
  existing reference interpreter (`../poc/`). This gives a working console today.
- **Phase 2: translate the backend into Agape.** Rewrite the API server in Agape
  on top of a new `listen` HTTP sensor — the socket sensor SPEC §5b already
  promises ("`prompt` is the first of a general family of sensors (a socket, …)").
  When that lands, "the backend is Agape" is literally true. **The React frontend
  does not change.** Studio then doubles as the flagship example program for the
  agentic layer, the way `compiler/lexer.ag` is for the somatic layer.

## The honesty boundary

This is the same somatic/agentic split the project already commits to (thesis
#3, #8), mapped onto the phpMyAdmin analogy:

| | runtime/plumbing | application |
|---|---|---|
| PHP | C | phpMyAdmin (PHP) |
| Agape | the HTTP socket = a **somatic device** | the API server (**Agape**) |

The socket lives behind a seam, exactly like cognition lives behind
`agape_provider.py`. Routing, agent lifecycle, spine queries, response shaping —
all application logic, all Agape.

The frontend is a **VS Code skin**: a Vite + React app wearing VS Code's shell
(activity bar / explorer / editor groups / panel / status bar) with **Monaco**
as the editor — themed Dark+, with Agape registered as a real Monaco language.
But it is **event-cockpit first**: the Explorer is the live agent population, the
bottom panel is the live spine, and the integrated terminal is an `agape>` query
console. Cursor bolted AI onto a text editor; this is an IDE whose native object
is the event stream.

## Run it

Two modes:

```bash
# ── dev (hot reload): two processes ──
python3 studio/server/app.py                 # backend + API on :8765  (terminal 1)
cd studio/web && npm install && npm run dev   # Vite on :5173, proxies /api → :8765 (terminal 2)
# open http://127.0.0.1:5173

# ── one-process (serves the built app) ──
cd studio/web && npm install && npm run build
python3 studio/server/app.py                 # serves studio/web/dist + API on :8765
# open http://127.0.0.1:8765
```

The backend defaults to port 8765 and the mock provider. If you change `--port`,
update the dev proxy target in `web/vite.config.js` to match (the one-process
build mode needs no change). Provider / program / model flags:

```bash
python3 studio/server/app.py --provider anthropic   # real cognition (needs ANTHROPIC_API_KEY)
python3 studio/server/app.py --program path/to.ag --port 8765
python3 studio/server/app.py --provider anthropic --model claude-opus-4-8   # override the default (haiku)
```

You get a live event-spine panel (the hero, auto-tailing), an agents explorer
with awake/sleep/ask actions, a Monaco editor for the `.ag` program (Run loads +
re-checks it), and the `agape>` query console. Everything a control does runs
*as Agape source* against the live interpreter — the typed endpoints just build
that source. That is what makes Phase 1 a faithful preview of Phase 2.

## Layout

```
studio/
  server/        backend (Python now → Agape in Phase 2)
    session.py   wraps a live Interpreter+Spine; load / eval / project
    app.py       dependency-free HTTP/JSON API + serves the built frontend
    test_studio.py
  web/           Vite + React + Monaco (the VS Code skin)
    index.html   Vite entry
    vite.config.js   dev proxy /api → :8765; build → dist/
    src/
      App.jsx            orchestrator (state, live tail, command handlers)
      api.js             the one place the frontend calls the Agape backend
      agapeLanguage.js   Agape registered as a Monaco language + Dark+ theme
      theme.css          the VS Code "Dark+" shell
      components/        ActivityBar, AgentsExplorer, EditorArea, SpinePanel,
                         QueryConsole, StatusBar
  programs/
    console_demo.ag   a small always-live program for the console to drive
```

## API

| Method | Path | Body | Does |
|---|---|---|---|
| GET | `/api/state` | — | full snapshot (events + agents + templates) |
| GET | `/api/spine?since=N` | — | events with tick ≥ N (the live-tail poll) |
| POST | `/api/load` | `{source\|path}` | reset + load a program |
| POST | `/api/eval` | `{source}` | run Agape against the live world (the REPL) |
| POST | `/api/spawn` | `{type,name,args}` | spawn an agent |
| POST | `/api/awake` / `/api/sleep` | `{name}` | lifecycle |
| POST | `/api/send` | `{dest,message,schema?}` | send a message (`<-`) |
| POST | `/api/prompt` | `{source,value}` | inject one external input arrival (§5b) |

## Test

```bash
python3 studio/server/test_studio.py   # 11 checks, mock provider, no API key
```

## Known gaps / candidate next bites

1. **`find` is silent on the spine.** The interpreter only emits a `FindResult`
   event for `find n, origin(n) …` (provenance form); a plain `find` binds its
   variable but appends nothing, so the console shows "0 new events". `select`
   and `match` already emit results. Decision to make: should a plain `find`
   always emit a `FindResult`? (Spine-faithful, small interpreter change — a
   semantics decision, not done unilaterally.)
2. **~~Vite project~~ — done.** `web/` is now Vite + React + Monaco, VS Code
   skinned. Next polish: a dedicated query-results view, provenance (`origin`)
   hover, multi-tab editing, opening other `.ag` files.
3. **Phase 2.** The `listen` HTTP sensor in `poc/` (lexer → parser → AST →
   checker → interp), then rewrite this backend in Agape.
4. **Playground panel** (the second product surface): paste-and-run Agape,
   alongside the live console.
