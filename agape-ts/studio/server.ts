// Agape Studio — the execution-inspection server.
//
// A minimal quality-control lens over Agape program runs: it lists the `.ag` programs in the
// directory it was launched from, runs a selected program through the agape-ts interpreter
// (parse → check → run), and returns the full execution record — ledger events, gate outcomes,
// say output, chain-head, or the rejection (error class + message + phase). It is NOT an editor
// and it never writes to the served directory.
//
// Zero dependencies: plain node:http + the agape-ts compiler/runtime it already ships with.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../src/parser.js";
import { run } from "../src/interp.js";
import { createProvider, loadManifest } from "../src/config.js";
import type * as A from "../src/ast.js";

export interface StudioOptions {
  dir: string;        // the served directory (the cwd `agape studio` was launched in)
  port: number;
  allowLive: boolean; // permit non-mock providers (off by default: the tunnel may be public)
  token?: string;     // when set, every request must carry ?token=… or Authorization: Bearer …
}

const UI_PATH = join(dirname(fileURLToPath(import.meta.url)), "index.html");
const SAFE_NAME = /^[\w][\w.-]*\.ag$/; // basename-only, .ag-only — no traversal, no dotfiles

// ---- program map: declared names, so the UI can classify ledger rows ----------------------------

interface ProgramMap {
  agents: string[];
  actions: string[];   // consequential sinks
  events: string[];    // plain records
  enums: Record<string, string[]>;
  tools: { name: string; effect: string }[];
  principals: string[];
}

function mapProgram(p: A.Program): ProgramMap {
  const m: ProgramMap = { agents: [], actions: [], events: [], enums: {}, tools: [], principals: [] };
  for (const d of p.decls) {
    switch (d.kind) {
      case "agent": m.agents.push(d.name); break;
      case "action": m.actions.push(d.name); break;
      case "event": m.events.push(d.name); break;
      case "enum": m.enums[d.name] = d.variants; break;
      case "tool": m.tools.push({ name: d.name, effect: d.effect }); break;
      case "principal": m.principals.push(d.name); break;
      default: break;
    }
  }
  return m;
}

// ---- request handling ----------------------------------------------------------------------------

function json(res: ServerResponse, code: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(s);
}

function listPrograms(dir: string) {
  return readdirSync(dir)
    .filter((f) => SAFE_NAME.test(f))
    .map((f) => {
      const st = statSync(join(dir, f));
      return { name: f, bytes: st.size, modified: st.mtime.toISOString() };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function safeProgramPath(dir: string, name: string): string | undefined {
  if (!SAFE_NAME.test(name)) return undefined;
  const p = resolve(dir, basename(name));
  if (!p.startsWith(resolve(dir))) return undefined;
  return existsSync(p) ? p : undefined;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function runProgram(opts: StudioOptions, name: string, providerName: string) {
  const path = safeProgramPath(opts.dir, name);
  if (!path) return { status: 404 as const, body: { error: "unknown program" } };

  const allowed = opts.allowLive ? ["mock", "anthropic", "openai", "gemini"] : ["mock"];
  if (!allowed.includes(providerName)) {
    return { status: 403 as const, body: { error: `provider '${providerName}' is not enabled (start with --live to allow live providers)` } };
  }

  const source = readFileSync(path, "utf8");
  const startedAt = Date.now();

  // phase 1+2: parse (assertCore included) — a front-end rejection is part of the QC story.
  let program: A.Program;
  try {
    program = parse(source);
  } catch (e) {
    return {
      status: 200 as const,
      body: {
        ok: false, phase: "parse", source,
        error: { cls: (e as { cls?: string }).cls ?? "ParseError", message: (e as Error).message },
        ms: Date.now() - startedAt,
      },
    };
  }
  const map = mapProgram(program);

  // phase 3: check + run (the interpreter runs the static checker first).
  const manifest = loadManifest(undefined, providerName);
  const provider = createProvider(manifest);
  try {
    const { ledger, stdout } = await run(program, { provider });
    return {
      status: 200 as const,
      body: {
        ok: true, phase: "run", source, map,
        provider: { backend: manifest.provider.backend, model: manifest.provider.model },
        events: ledger.events, stdout, chainHead: ledger.head(),
        ms: Date.now() - startedAt,
      },
    };
  } catch (e) {
    const cls = (e as { cls?: string }).cls ?? ((e as Error).constructor?.name === "ParseError" ? "ParseError" : "RuntimeError");
    return {
      status: 200 as const,
      body: {
        ok: false, phase: "run", source, map,
        error: { cls, message: (e as Error).message },
        ms: Date.now() - startedAt,
      },
    };
  }
}

export function startStudio(opts: StudioOptions): Promise<{ close: () => void }> {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      // access guard — a shared-secret token for short-lived public exposure (a quick tunnel). The UI
      // carries the token from its own URL into every API call, so one tokened link is all you share.
      if (opts.token) {
        const supplied = url.searchParams.get("token") ?? (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
        if (supplied !== opts.token) {
          if (url.pathname === "/") {
            res.writeHead(401, { "content-type": "text/html; charset=utf-8" });
            res.end("<body style='background:#0b0e14;color:#dbe2f0;font-family:system-ui;display:grid;place-items:center;height:100vh'><div>agape studio — this link requires its access token (<code>?token=…</code>)</div></body>");
            return;
          }
          return json(res, 401, { error: "missing or invalid access token" });
        }
      }
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(readFileSync(UI_PATH, "utf8"));
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/meta") {
        return json(res, 200, {
          dir: opts.dir,
          version: "1.0.0-alpha.2026.7.1.0",
          providers: opts.allowLive ? ["mock", "anthropic", "openai", "gemini"] : ["mock"],
        });
      }
      if (req.method === "GET" && url.pathname === "/api/programs") {
        return json(res, 200, { programs: listPrograms(opts.dir) });
      }
      if (req.method === "GET" && url.pathname === "/api/source") {
        const path = safeProgramPath(opts.dir, url.searchParams.get("name") ?? "");
        if (!path) return json(res, 404, { error: "unknown program" });
        return json(res, 200, { source: readFileSync(path, "utf8") });
      }
      if (req.method === "POST" && url.pathname === "/api/run") {
        const body = JSON.parse((await readBody(req)) || "{}") as { program?: string; provider?: string };
        const r = await runProgram(opts, body.program ?? "", body.provider ?? "mock");
        return json(res, r.status, r.body);
      }
      json(res, 404, { error: "not found" });
    } catch (e) {
      json(res, 500, { error: (e as Error).message });
    }
  });

  return new Promise((resolvePromise) => {
    server.listen(opts.port, () => {
      console.log(`agape studio — inspecting ${opts.dir}`);
      console.log(`  local:  http://localhost:${opts.port}${opts.token ? `/?token=${opts.token}` : ""}`);
      console.log(`  providers: ${opts.allowLive ? "mock + live (anthropic/openai/gemini)" : "mock only (start with --live to enable live providers)"}`);
      if (opts.token) console.log(`  access: token-gated (share the tokened URL only)`);
      resolvePromise({ close: () => server.close() });
    });
  });
}
