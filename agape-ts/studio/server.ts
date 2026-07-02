// Agape Studio — the execution-inspection server.
//
// A minimal quality-control lens over Agape program runs: it lists the `.ag` programs in the
// directory it was launched from, runs a selected program through the agape-ts interpreter
// (parse → check → run), and returns the full execution record — ledger events, gate outcomes,
// say output, chain-head, or the rejection (error class + message + phase). It also offers a small
// guarded source editor for the served directory.
//
// Zero dependencies: plain node:http + the agape-ts compiler/runtime it already ships with.

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../src/parser.js";
import { createSession, run, type PrincipalAttestation, type PromptInput, type RuntimeSession } from "../src/interp.js";
import { createProvider, loadManifest } from "../src/config.js";
import type * as A from "../src/ast.js";

export interface StudioOptions {
  dir: string;        // the served directory (the cwd `agape studio` was launched in)
  port: number;
  allowLive: boolean; // permit non-mock providers (off by default: the tunnel may be public)
  token?: string;     // when set, every request must carry ?token=… or Authorization: Bearer …
}

const UI_PATH = join(dirname(fileURLToPath(import.meta.url)), "index.html");
const EXAMPLES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../examples");
const SAFE_NAME = /^[\w][\w.-]*\.ag$/; // basename-only, .ag-only — no traversal, no dotfiles
const MAX_SOURCE_BYTES = 256 * 1024;

const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};
const HTML_HEADERS = {
  ...SECURITY_HEADERS,
  "content-type": "text/html; charset=utf-8",
  "content-security-policy":
    "default-src 'self'; connect-src 'self'; img-src 'self' data:; " +
    "style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; " +
    "base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
};

type ProviderName = "mock" | "anthropic" | "openai" | "gemini";
interface StudioProvider {
  name: ProviderName;
  label: string;
  live: boolean;
  enabled: boolean;
  configured: boolean;
  model: string;
  credence: string;
  detail: string;
  keyEnv?: string;
}

const PROVIDER_CATALOG: Array<Omit<StudioProvider, "enabled" | "configured" | "detail">> = [
  { name: "mock", label: "Mock", live: false, model: "deterministic", credence: "scripted scores" },
  { name: "anthropic", label: "Anthropic", live: true, model: "claude-haiku-4-5", credence: "sampling fallback", keyEnv: "ANTHROPIC_API_KEY" },
  { name: "openai", label: "OpenAI", live: true, model: "gpt-4o-mini", credence: "token logprobs", keyEnv: "OPENAI_API_KEY" },
  { name: "gemini", label: "Gemini", live: true, model: "gemini-1.5-flash", credence: "sampling fallback", keyEnv: "GEMINI_API_KEY or GOOGLE_API_KEY" },
];

const BUNDLED_EXAMPLE = {
  name: "hello_rag.ag",
  description: "Built-in RAG hello world",
  sourcePath: join(EXAMPLES_DIR, "rag_recall.ag"),
};

// ---- program map: declared names, so the UI can classify ledger rows ----------------------------

interface ProgramMap {
  agents: string[];
  actions: string[];   // consequential sinks
  events: string[];    // plain records
  enums: Record<string, string[]>;
  tools: { name: string; effect: string }[];
  principals: string[];
  prompts: { name: string; type: string }[];
}

function typeLabel(t: A.TypeRef): string {
  switch (t.kind) {
    case "scalar": return t.name;
    case "event": return `event<${typeLabel(t.inner)}>`;
    case "array": return `${typeLabel(t.inner)}[]`;
    case "credence": return `Credence<${t.enumName}>`;
    case "decision": return `Decision<${t.enumName}>`;
    case "endorsement": return `Endorsement<${typeLabel(t.inner)}>`;
    case "named": return t.typeArgs?.length ? `${t.name}<${t.typeArgs.map(typeLabel).join(", ")}>` : t.name;
    case "mem": return "mem";
  }
}

function mapProgram(p: A.Program): ProgramMap {
  const m: ProgramMap = { agents: [], actions: [], events: [], enums: {}, tools: [], principals: [], prompts: [] };
  for (const d of p.decls) {
    switch (d.kind) {
      case "agent": m.agents.push(d.name); break;
      case "action": m.actions.push(d.name); break;
      case "event": m.events.push(d.name); break;
      case "enum": m.enums[d.name] = d.variants; break;
      case "tool": m.tools.push({ name: d.name, effect: d.effect }); break;
      case "principal": m.principals.push(d.name); break;
      case "prompt": m.prompts.push({ name: d.name, type: typeLabel(d.type) }); break;
      default: break;
    }
  }
  return m;
}

// ---- request handling ----------------------------------------------------------------------------

function json(res: ServerResponse, code: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(code, { ...SECURITY_HEADERS, "content-type": "application/json; charset=utf-8" });
  res.end(s);
}

function providerKeyConfigured(name: ProviderName): boolean {
  switch (name) {
    case "mock": return true;
    case "anthropic": return Boolean(process.env.ANTHROPIC_API_KEY);
    case "openai": return Boolean(process.env.OPENAI_API_KEY);
    case "gemini": return Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
  }
}

function providerStatuses(allowLive: boolean): StudioProvider[] {
  return PROVIDER_CATALOG.map((p) => {
    const configured = providerKeyConfigured(p.name);
    const enabled = !p.live || (allowLive && configured);
    let detail = `${p.label} · ${p.model} · ${p.credence}`;
    if (p.live && !allowLive) detail = `${p.label} is locked until Studio starts with --share or --live.`;
    else if (p.live && !configured) detail = `${p.label} needs ${p.keyEnv} in the environment or .env.`;
    return { ...p, enabled, configured, detail };
  });
}

function providerStatus(name: string, allowLive: boolean): StudioProvider | undefined {
  return providerStatuses(allowLive).find((p) => p.name === name);
}

function listProjectPrograms(dir: string) {
  return readdirSync(dir)
    .filter((f) => SAFE_NAME.test(f))
    .map((f) => {
      const st = statSync(join(dir, f));
      return { name: f, bytes: st.size, modified: st.mtime.toISOString(), origin: "project" as const };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function bundledPrograms() {
  if (!existsSync(BUNDLED_EXAMPLE.sourcePath)) return [];
  const source = readFileSync(BUNDLED_EXAMPLE.sourcePath, "utf8")
    .replace(/^\/\/ rag_recall\.ag/m, `// ${BUNDLED_EXAMPLE.name}`);
  const st = statSync(BUNDLED_EXAMPLE.sourcePath);
  return [{
    name: BUNDLED_EXAMPLE.name,
    bytes: Buffer.byteLength(source, "utf8"),
    modified: st.mtime.toISOString(),
    origin: "example" as const,
    description: BUNDLED_EXAMPLE.description,
  }];
}

function listPrograms(dir: string) {
  const project = listProjectPrograms(dir);
  return project.length ? project : bundledPrograms();
}

function safeProgramPath(dir: string, name: string): string | undefined {
  if (!SAFE_NAME.test(name)) return undefined;
  const p = resolve(dir, basename(name));
  if (!p.startsWith(resolve(dir))) return undefined;
  return existsSync(p) ? p : undefined;
}

function safeWritableProgramPath(dir: string, name: string): string | undefined {
  if (!SAFE_NAME.test(name)) return undefined;
  const p = resolve(dir, basename(name));
  return p.startsWith(resolve(dir)) ? p : undefined;
}

function readProgramSource(dir: string, name: string): { source: string; origin: "project" | "example" } | undefined {
  const path = safeProgramPath(dir, name);
  if (path) return { source: readFileSync(path, "utf8"), origin: "project" };
  if (listProjectPrograms(dir).length === 0 && name === BUNDLED_EXAMPLE.name && existsSync(BUNDLED_EXAMPLE.sourcePath)) {
    const source = readFileSync(BUNDLED_EXAMPLE.sourcePath, "utf8")
      .replace(/^\/\/ rag_recall\.ag/m, `// ${BUNDLED_EXAMPLE.name}`);
    return { source, origin: "example" };
  }
  return undefined;
}

function saveProgramSource(dir: string, name: string, source: string) {
  const path = safeWritableProgramPath(dir, name);
  if (!path) return { status: 400 as const, body: { error: "program name must be a basename ending in .ag" } };
  const bytes = Buffer.byteLength(source, "utf8");
  if (bytes > MAX_SOURCE_BYTES) return { status: 413 as const, body: { error: "source is too large" } };
  writeFileSync(path, source, "utf8");
  const st = statSync(path);
  return {
    status: 200 as const,
    body: {
      ok: true,
      program: { name: basename(path), bytes: st.size, modified: st.mtime.toISOString(), origin: "project" as const },
    },
  };
}

async function readBody(req: IncomingMessage, limit = MAX_SOURCE_BYTES + 4096): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const c of req) {
    const chunk = c as Buffer;
    bytes += chunk.byteLength;
    if (bytes > limit) throw new Error("request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function runProgram(
  opts: StudioOptions,
  name: string,
  providerName: string,
  promptInputs: PromptInput[] = [],
  principalAttestations: PrincipalAttestation[] = [],
) {
  const sourceInfo = readProgramSource(opts.dir, name);
  if (!sourceInfo) return { status: 404 as const, body: { error: "unknown program" } };

  const providerInfo = providerStatus(providerName, opts.allowLive);
  if (!providerInfo) {
    return { status: 400 as const, body: { error: `unknown provider '${providerName}'` } };
  }
  if (!providerInfo.enabled) {
    return { status: providerInfo.live && !opts.allowLive ? 403 as const : 409 as const, body: { error: providerInfo.detail } };
  }

  const source = sourceInfo.source;
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
        sourceOrigin: sourceInfo.origin,
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
    const { ledger, stdout } = await run(program, { provider, promptInputs, principalAttestations });
    return {
      status: 200 as const,
      body: {
        ok: true, phase: "run", source, map,
        provider: { backend: manifest.provider.backend, model: manifest.provider.model },
        sourceOrigin: sourceInfo.origin,
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
        sourceOrigin: sourceInfo.origin,
        error: { cls, message: (e as Error).message },
        ms: Date.now() - startedAt,
      },
    };
  }
}

interface StudioRunSession {
  id: string;
  name: string;
  source: string;
  sourceOrigin: "project" | "example";
  map: ProgramMap;
  provider: { backend: string; model?: string };
  runtime: RuntimeSession;
  startedAt: number;
}

function runBody(session: StudioRunSession, ms = Date.now() - session.startedAt) {
  const { ledger, stdout } = session.runtime.snapshot();
  return {
    ok: true,
    phase: "run",
    listening: true,
    sessionId: session.id,
    source: session.source,
    map: session.map,
    provider: session.provider,
    sourceOrigin: session.sourceOrigin,
    events: ledger.events,
    stdout,
    chainHead: ledger.head(),
    ms,
  };
}

async function startRunSession(
  opts: StudioOptions,
  sessions: Map<string, StudioRunSession>,
  name: string,
  providerName: string,
  principalAttestations: PrincipalAttestation[] = [],
) {
  const sourceInfo = readProgramSource(opts.dir, name);
  if (!sourceInfo) return { status: 404 as const, body: { error: "unknown program" } };

  const providerInfo = providerStatus(providerName, opts.allowLive);
  if (!providerInfo) return { status: 400 as const, body: { error: `unknown provider '${providerName}'` } };
  if (!providerInfo.enabled) {
    return { status: providerInfo.live && !opts.allowLive ? 403 as const : 409 as const, body: { error: providerInfo.detail } };
  }

  const source = sourceInfo.source;
  const startedAt = Date.now();
  let program: A.Program;
  try {
    program = parse(source);
  } catch (e) {
    return {
      status: 200 as const,
      body: {
        ok: false, phase: "parse", source,
        sourceOrigin: sourceInfo.origin,
        error: { cls: (e as { cls?: string }).cls ?? "ParseError", message: (e as Error).message },
        ms: Date.now() - startedAt,
      },
    };
  }

  const map = mapProgram(program);
  const manifest = loadManifest(undefined, providerName);
  const provider = createProvider(manifest);
  try {
    const runtime = createSession(program, { provider, principalAttestations });
    await runtime.start();
    const session: StudioRunSession = {
      id: randomBytes(12).toString("base64url"),
      name,
      source,
      sourceOrigin: sourceInfo.origin,
      map,
      provider: { backend: manifest.provider.backend, model: manifest.provider.model },
      runtime,
      startedAt,
    };
    sessions.set(session.id, session);
    return { status: 200 as const, body: runBody(session) };
  } catch (e) {
    const cls = (e as { cls?: string }).cls ?? ((e as Error).constructor?.name === "ParseError" ? "ParseError" : "RuntimeError");
    return {
      status: 200 as const,
      body: {
        ok: false, phase: "run", source, map,
        sourceOrigin: sourceInfo.origin,
        error: { cls, message: (e as Error).message },
        ms: Date.now() - startedAt,
      },
    };
  }
}

export function startStudio(opts: StudioOptions): Promise<{ close: () => void }> {
  const accessToken = opts.token ?? (opts.allowLive ? randomBytes(18).toString("base64url") : undefined);
  let activeLiveRuns = 0;
  const sessions = new Map<string, StudioRunSession>();

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      // access guard — a shared-secret token for short-lived public exposure (a quick tunnel). The UI
      // carries the token from its own URL into every API call, so one tokened link is all you share.
      if (accessToken) {
        const supplied = url.searchParams.get("token") ?? (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
        if (supplied !== accessToken) {
          if (url.pathname === "/") {
            res.writeHead(401, HTML_HEADERS);
            res.end("<body style='background:#0b0e14;color:#dbe2f0;font-family:system-ui;display:grid;place-items:center;height:100vh'><div>agape studio — this link requires its access token (<code>?token=…</code>)</div></body>");
            return;
          }
          return json(res, 401, { error: "missing or invalid access token" });
        }
      }
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, HTML_HEADERS);
        res.end(readFileSync(UI_PATH, "utf8"));
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/meta") {
        return json(res, 200, {
          dir: opts.dir,
          version: "1.0.0-alpha.2026.7.2.0",
          providers: providerStatuses(opts.allowLive),
          access: { liveEnabled: opts.allowLive, tokenRequired: Boolean(accessToken) },
        });
      }
      if (req.method === "GET" && url.pathname === "/api/programs") {
        const programs = listPrograms(opts.dir);
        return json(res, 200, {
          programs,
          fallback: programs.some((p) => p.origin === "example"),
        });
      }
      if (req.method === "GET" && url.pathname === "/api/source") {
        const program = readProgramSource(opts.dir, url.searchParams.get("name") ?? "");
        if (!program) return json(res, 404, { error: "unknown program" });
        let map: ProgramMap | undefined;
        try { map = mapProgram(parse(program.source)); } catch { /* source may be mid-edit; run will show parse errors */ }
        return json(res, 200, { ...program, map });
      }
      if (req.method === "POST" && url.pathname === "/api/source") {
        const body = JSON.parse((await readBody(req)) || "{}") as { name?: string; source?: string };
        if (typeof body.source !== "string") return json(res, 400, { error: "missing source" });
        const r = saveProgramSource(opts.dir, body.name ?? "", body.source);
        return json(res, r.status, r.body);
      }
      if (req.method === "POST" && url.pathname === "/api/run") {
        const body = JSON.parse((await readBody(req)) || "{}") as {
          program?: string;
          provider?: string;
          promptInputs?: PromptInput[];
          principalAttestations?: PrincipalAttestation[];
        };
        const liveRun = body.provider && body.provider !== "mock";
        if (liveRun && activeLiveRuns >= 1) return json(res, 429, { error: "a live-provider run is already in progress" });
        if (liveRun) activeLiveRuns++;
        try {
          const r = await runProgram(
            opts,
            body.program ?? "",
            body.provider ?? "mock",
            body.promptInputs ?? [],
            body.principalAttestations ?? [],
          );
          return json(res, r.status, r.body);
        } finally {
          if (liveRun) activeLiveRuns--;
        }
      }
      if (req.method === "POST" && url.pathname === "/api/listen") {
        const body = JSON.parse((await readBody(req)) || "{}") as {
          program?: string;
          provider?: string;
          principalAttestations?: PrincipalAttestation[];
        };
        const liveRun = body.provider && body.provider !== "mock";
        if (liveRun && activeLiveRuns >= 1) return json(res, 429, { error: "a live-provider run is already in progress" });
        if (liveRun) activeLiveRuns++;
        try {
          const r = await startRunSession(
            opts,
            sessions,
            body.program ?? "",
            body.provider ?? "mock",
            body.principalAttestations ?? [],
          );
          return json(res, r.status, r.body);
        } finally {
          if (liveRun) activeLiveRuns--;
        }
      }
      if (req.method === "POST" && url.pathname === "/api/prompt") {
        const body = JSON.parse((await readBody(req)) || "{}") as {
          sessionId?: string;
          promptInputs?: PromptInput[];
        };
        const session = body.sessionId ? sessions.get(body.sessionId) : undefined;
        if (!session) return json(res, 404, { error: "listening session not found; press Listen again" });
        try {
          for (const input of body.promptInputs ?? []) await session.runtime.sendPrompt(input);
          return json(res, 200, runBody(session));
        } catch (e) {
          const cls = (e as { cls?: string }).cls ?? "RuntimeError";
          return json(res, 200, {
            ...runBody(session),
            ok: false,
            error: { cls, message: (e as Error).message },
          });
        }
      }
      if (req.method === "POST" && url.pathname === "/api/stop") {
        const body = JSON.parse((await readBody(req)) || "{}") as { sessionId?: string };
        const removed = body.sessionId ? sessions.delete(body.sessionId) : false;
        return json(res, 200, { ok: true, stopped: removed });
      }
      json(res, 404, { error: "not found" });
    } catch (e) {
      json(res, 500, { error: (e as Error).message });
    }
  });

  return new Promise((resolvePromise) => {
    server.listen(opts.port, () => {
      console.log(`agape studio — inspecting ${opts.dir}`);
      console.log(`  local:  http://localhost:${opts.port}${accessToken ? `/?token=${accessToken}` : ""}`);
      console.log(`  providers: ${opts.allowLive ? "mock + live (anthropic/openai/gemini)" : "mock only (start with --share or --live to enable live providers)"}`);
      if (accessToken) console.log(`  access: token-gated (append the same ?token=… to the tunnel URL)`);
      resolvePromise({ close: () => server.close() });
    });
  });
}
