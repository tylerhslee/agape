# Agape Studio — agent server (somatic simulation)

This is the local TypeScript implementation of Agape Studio's agentic layer. It
gives the studio's operators (the builders you pair with and delegate to) real
behavior by calling provider APIs, and it implements the shared runtime contract
in `../../RUNTIME_SPEC.md` for Studio's own control-plane runtime.

It is explicitly the **studio runtime** described in `[../STUDIO.md](../STUDIO.md)`
§2: a TypeScript service behind a stable seam. The Rust runtime and Soma/cloud
runtime must implement the same runtime contract; the React frontend should not
need to care which conforming runtime it is attached to.

```
React UI ──/agent/*──▶ agent-server (provider APIs today) ◀── this seam
                              │                               becomes the
                              ▼                               Agape + MCP backend
                       Claude / OpenAI
```

## The contract

One operation today (the seam the Agape backend will implement):

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/agent/respond` | `{ item, thread, intent }` | `{ text }` — the agent's next message |
| GET | `/agent/health` | — | provider/key/model status |
| GET | `/agent/config` | — | active cognition provider and Credence calibration config |
| POST | `/agent/config` | provider config patch | updated provider config |
| GET | `/runtime/config` | — | active runtime deployment config |
| POST | `/runtime/config` | runtime config patch | updated runtime deployment config |

- `item` — the work item in focus: `{ title, destination, status, mode, assignee }`.
- `thread` — the prior conversation: `[{ who: "you" \| "ai" \| "sys", text }]`.
- `intent` — `"respond"` (reply to the human's latest note) or `"kickoff"` (the agent
  was just delegated this work; produce a plan and a first step).

The pure prompt-building lives in `agent.ts` and is unit-tested (`agent.test.ts`);
the live provider calls live in `server.ts`.

## Run it

```bash
cd studio/agent-server
npm install
npm run dev      # tsx server.ts → http://127.0.0.1:8799
```

The server finds `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` by walking up from the
working directory to the repo-root `.env` (or reads them from the environment if
already set). Studio Settings select Mock, Claude, or OpenAI for cognition. Credence
calibration follows the selected provider: Claude uses sampling fallback; OpenAI
uses token logprobs.

The Vite dev server proxies `/agent` → `:8799`, so the frontend always calls
same-origin `/agent/...`.

## Test

```bash
npm test         # vitest — covers prompt construction (no API key needed)
```
