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
import { createSession, run, type ConsultRequest, type PrincipalAttestation, type PromptInput, type RuntimeSession } from "../src/interp.js";
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
const CONFIG_NAME = "agape.toml";
const MAX_CONFIG_BYTES = 128 * 1024;

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

// ---- projects: each SUBDIRECTORY of the served workspace is its own Agape project (§17: a
// project = a directory with its own agape.toml), so per-demo config is genuinely per-demo.
// Root-level .ag files remain the "root" project (project = ""), sharing the root agape.toml.
const SAFE_PROJECT = /^[\w][\w.-]*$/; // one level, no dotfiles, no traversal

function projectOf(name: string): string {
  const i = name.indexOf("/");
  return i === -1 ? "" : name.slice(0, i);
}

function listProjectPrograms(dir: string) {
  const out: { name: string; project: string; bytes: number; modified: string; origin: "project" }[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (SAFE_NAME.test(entry) && statSync(full).isFile()) {
      const st = statSync(full);
      out.push({ name: entry, project: "", bytes: st.size, modified: st.mtime.toISOString(), origin: "project" });
      continue;
    }
    if (!SAFE_PROJECT.test(entry) || entry === "node_modules") continue;
    if (!statSync(full).isDirectory()) continue;
    for (const f of readdirSync(full)) {
      if (!SAFE_NAME.test(f)) continue;
      const st = statSync(join(full, f));
      out.push({ name: `${entry}/${f}`, project: entry, bytes: st.size, modified: st.mtime.toISOString(), origin: "project" });
    }
  }
  return out.sort((a, b) => a.project.localeCompare(b.project) || a.name.localeCompare(b.name));
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

// a program name is either `file.ag` (root project) or `project/file.ag` (one level deep).
function safeProgramRel(name: string): string | undefined {
  const project = projectOf(name);
  const file = project ? name.slice(project.length + 1) : name;
  if (project && !SAFE_PROJECT.test(project)) return undefined;
  if (!SAFE_NAME.test(file)) return undefined;
  return project ? `${project}/${file}` : file;
}

function safeProgramPath(dir: string, name: string): string | undefined {
  const rel = safeProgramRel(name);
  if (!rel) return undefined;
  const p = resolve(dir, rel);
  if (!p.startsWith(resolve(dir))) return undefined;
  return existsSync(p) ? p : undefined;
}

function safeWritableProgramPath(dir: string, name: string): string | undefined {
  const rel = safeProgramRel(name);
  if (!rel) return undefined;
  const p = resolve(dir, rel);
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
      program: { name: safeProgramRel(name)!, bytes: st.size, modified: st.mtime.toISOString(), origin: "project" as const },
    },
  };
}

// project "" = the workspace root; otherwise a one-level subdirectory project (§17).
function projectDir(dir: string, project: string): string | undefined {
  if (!project) return resolve(dir);
  if (!SAFE_PROJECT.test(project)) return undefined;
  const p = resolve(dir, project);
  return p.startsWith(resolve(dir)) ? p : undefined;
}

function configPath(dir: string, project = ""): string | undefined {
  const pd = projectDir(dir, project);
  return pd ? resolve(pd, CONFIG_NAME) : undefined;
}

function defaultConfigSource(): string {
  return `[provider]
backend = "mock"

[memory]
blob_store = "archive"
background_reindex = true
forget_policy = "cascade"
archive_retention = "forever"
`;
}

function readConfigSource(dir: string, project = ""): { source: string; exists: boolean; name: string; project: string } {
  const path = configPath(dir, project);
  const name = project ? `${project}/${CONFIG_NAME}` : CONFIG_NAME;
  if (path && existsSync(path)) return { source: readFileSync(path, "utf8"), exists: true, name, project };
  return { source: defaultConfigSource(), exists: false, name, project };
}

function saveConfigSource(dir: string, project: string, source: string) {
  const path = configPath(dir, project);
  if (!path) return { status: 400 as const, body: { error: "invalid project" } };
  const pd = projectDir(dir, project)!;
  if (!existsSync(pd)) return { status: 404 as const, body: { error: `project '${project}' does not exist` } };
  const bytes = Buffer.byteLength(source, "utf8");
  if (bytes > MAX_CONFIG_BYTES) return { status: 413 as const, body: { error: "config is too large" } };
  writeFileSync(path, source, "utf8");
  const st = statSync(path);
  return { status: 200 as const, body: { ok: true, config: { name: project ? `${project}/${CONFIG_NAME}` : CONFIG_NAME, bytes: st.size, modified: st.mtime.toISOString(), exists: true } } };
}

function loadProjectManifest(dir: string, project: string, providerName: string) {
  const path = configPath(dir, project);
  return loadManifest(path && existsSync(path) ? path : undefined, providerName);
}

// ---- structured config: the manifest as a data model -------------------------------------------
//
// The manifest (agape.toml) stays the single source of truth (§17); the UI is a FORM-EDITOR over
// it, and the raw TOML remains for inspection / occasional direct edits. parseTomlSubset reads the
// simple shape the manifest uses (tables of `key = value`, values: string/number/bool/inline
// table); patchTomlSource applies `key = value` updates LINE-WISE inside a `[table]`, preserving
// every comment and unrelated line (creating the table/key when absent).

type TomlValue = string | number | boolean | { raw: string };

function parseTomlSubset(src: string): Record<string, Record<string, TomlValue>> {
  const tables: Record<string, Record<string, TomlValue>> = {};
  let current = "";
  for (const line of src.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const th = t.match(/^\[([\w.-]+)\]$/);
    if (th) { current = th[1]!; tables[current] ??= {}; continue; }
    const kv = t.match(/^([\w.-]+)\s*=\s*(.+?)\s*$/);
    if (!kv) continue;
    const [, key, rawVal] = kv;
    let value: TomlValue;
    const stripped = rawVal!.replace(/\s+#.*$/, "").trim();
    if (/^".*"$/.test(stripped)) value = stripped.slice(1, -1);
    else if (stripped === "true" || stripped === "false") value = stripped === "true";
    else if (/^-?\d+(\.\d+)?$/.test(stripped)) value = Number(stripped);
    else value = { raw: stripped }; // an inline table (`{ mcp = "…" }`) or anything else — kept verbatim
    (tables[current] ??= {})[key!] = value;
  }
  return tables;
}

// one `key = <toml text>` update inside `[table]` — comment-preserving, create-if-missing.
function patchTomlSource(src: string, table: string, key: string, tomlText: string): string {
  const lines = src.length ? src.split("\n") : [];
  const header = `[${table}]`;
  let tStart = -1;
  for (let i = 0; i < lines.length; i++) if (lines[i]!.trim() === header) { tStart = i; break; }
  if (tStart === -1) {
    if (lines.length && lines[lines.length - 1]!.trim() !== "") lines.push("");
    lines.push(header, `${key} = ${tomlText}`);
    return lines.join("\n");
  }
  let tEnd = lines.length;
  for (let i = tStart + 1; i < lines.length; i++) if (/^\s*\[[\w.-]+\]\s*$/.test(lines[i]!)) { tEnd = i; break; }
  const keyRe = new RegExp(`^(\\s*)${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=`);
  for (let i = tStart + 1; i < tEnd; i++) {
    const m = lines[i]!.match(keyRe);
    if (m) { lines[i] = `${m[1]}${key} = ${tomlText}`; return lines.join("\n"); }
  }
  // key absent — insert at the end of the table body (before the span's trailing blank lines)
  let insertAt = tEnd;
  while (insertAt > tStart + 1 && lines[insertAt - 1]!.trim() === "") insertAt--;
  lines.splice(insertAt, 0, `${key} = ${tomlText}`);
  return lines.join("\n");
}

const PATCHABLE_TABLES = new Set(["project", "provider", "identity", "memory", "tools", "prompts"]);

function applyConfigPatch(dir: string, project: string, sets: { table?: string; key?: string; value?: string }[]) {
  const current = readConfigSource(dir, project);
  let src = current.exists ? current.source : "";
  for (const p of sets) {
    if (!p.table || !p.key || typeof p.value !== "string") return { status: 400 as const, body: { error: "each set needs table, key, and a TOML-text value" } };
    if (!PATCHABLE_TABLES.has(p.table)) return { status: 400 as const, body: { error: `table '${p.table}' is not configurable here` } };
    if (!/^[\w.-]+$/.test(p.key)) return { status: 400 as const, body: { error: `bad key '${p.key}'` } };
    if (p.value.includes("\n") || p.value.length > 500) return { status: 400 as const, body: { error: "value must be single-line TOML text" } };
    src = patchTomlSource(src, p.table, p.key, p.value);
  }
  return saveConfigSource(dir, project, src.endsWith("\n") || src === "" ? src : src + "\n");
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
  const manifest = loadProjectManifest(opts.dir, projectOf(name), providerName);
  const provider = createProvider(manifest);
  try {
    const { ledger, stdout } = await run(program, { provider, manifest, promptInputs, principalAttestations });
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
  // §13/§16.4 attestation flow: while the run is PAUSED at a principal consult, `pending` describes the
  // ruling being requested (the enum's variants are the choices); `resolveConsult` resumes the run with
  // the principal's attestation (a variant ruling) or undefined (decline → FailedPrincipalDecision).
  runState: "running" | "waiting" | "done" | "error";
  error?: { cls: string; message: string };
  pending?: ConsultRequest & { id: string };
  resolveConsult?: (att: PrincipalAttestation | undefined) => void;
  work: Promise<void>; // the in-flight start()/sendPrompt() chain, tracked for state + errors
}

// track an in-flight runtime promise onto the session's state machine.
function track(session: StudioRunSession, p: Promise<unknown>): void {
  session.runState = session.runState === "waiting" ? "waiting" : "running";
  session.work = p.then(
    () => { if (session.runState !== "waiting") session.runState = "done"; },
    (e) => {
      session.runState = "error";
      const cls = (e as { cls?: string }).cls ?? ((e as Error).constructor?.name === "ParseError" ? "ParseError" : "RuntimeError");
      session.error = { cls, message: (e as Error).message };
    },
  );
}

// give the run a short beat to finish (or to reach a consult pause) before responding, so fast runs
// return complete and consult-blocked runs return `waiting` + pendingAttestation for the UI to render.
async function settle(session: StudioRunSession, ms: number): Promise<void> {
  await Promise.race([session.work, new Promise((r) => setTimeout(r, ms))]);
}

function runBody(session: StudioRunSession, ms = Date.now() - session.startedAt) {
  const { ledger, stdout } = session.runtime.snapshot();
  return {
    ok: session.runState !== "error",
    phase: "run",
    listening: true,
    sessionId: session.id,
    runState: session.runState,
    ...(session.error ? { error: session.error } : {}),
    ...(session.pending ? { pendingAttestation: session.pending } : {}),
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
  const manifest = loadProjectManifest(opts.dir, projectOf(name), providerName);
  const provider = createProvider(manifest);
  try {
    const session: StudioRunSession = {
      id: randomBytes(12).toString("base64url"),
      name,
      source,
      sourceOrigin: sourceInfo.origin,
      map,
      provider: { backend: manifest.provider.backend, model: manifest.provider.model },
      runtime: undefined as unknown as RuntimeSession, // set right below (the consult closure needs `session`)
      startedAt,
      runState: "running",
      work: Promise.resolve(),
    };
    // the live identity seam (§16.4): an escalated principal consult PAUSES the run and surfaces a
    // pendingAttestation for the UI; POST /api/attest resolves it with the ruling (or a decline).
    session.runtime = createSession(program, {
      provider,
      manifest,
      principalAttestations,
      onConsult: (req) => new Promise<PrincipalAttestation | undefined>((resolveConsult) => {
        session.pending = { ...req, id: randomBytes(8).toString("base64url") };
        session.runState = "waiting";
        session.resolveConsult = (att) => {
          session.pending = undefined;
          session.resolveConsult = undefined;
          session.runState = "running";
          resolveConsult(att);
        };
      }),
    });
    track(session, session.runtime.start());
    await settle(session, 400);
    // a synchronous front-end rejection (check error) surfaces as an immediate error state — return the
    // classic one-shot error body for it, matching /api/run.
    if (session.runState === "error" && session.error) {
      return {
        status: 200 as const,
        body: {
          ok: false, phase: "run", source, map,
          sourceOrigin: sourceInfo.origin,
          error: session.error,
          ms: Date.now() - startedAt,
        },
      };
    }
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
          version: "1.0.0-alpha.2026.7.2.1",
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
      if (req.method === "GET" && url.pathname === "/api/config") {
        const project = url.searchParams.get("project") ?? "";
        if (project && !SAFE_PROJECT.test(project)) return json(res, 400, { error: "bad project" });
        const cfg = readConfigSource(opts.dir, project);
        return json(res, 200, { ...cfg, values: parseTomlSubset(cfg.source) });
      }
      if (req.method === "POST" && url.pathname === "/api/config/patch") {
        // structured manifest edits (the form UI): each set is one `key = <toml text>` inside a
        // `[table]`, applied comment-preservingly to agape.toml — the file stays the source of truth.
        const body = JSON.parse((await readBody(req)) || "{}") as { project?: string; sets?: { table?: string; key?: string; value?: string }[] };
        const project = body.project ?? "";
        if (project && !SAFE_PROJECT.test(project)) return json(res, 400, { error: "bad project" });
        const r = applyConfigPatch(opts.dir, project, body.sets ?? []);
        if (r.status !== 200) return json(res, r.status, r.body);
        const cfg = readConfigSource(opts.dir, project);
        return json(res, 200, { ...r.body, source: cfg.source, exists: cfg.exists, values: parseTomlSubset(cfg.source), project });
      }
      if (req.method === "POST" && url.pathname === "/api/source") {
        const body = JSON.parse((await readBody(req)) || "{}") as { name?: string; source?: string };
        if (typeof body.source !== "string") return json(res, 400, { error: "missing source" });
        const r = saveProgramSource(opts.dir, body.name ?? "", body.source);
        return json(res, r.status, r.body);
      }
      if (req.method === "POST" && url.pathname === "/api/config") {
        const body = JSON.parse((await readBody(req)) || "{}") as { project?: string; source?: string };
        if (typeof body.source !== "string") return json(res, 400, { error: "missing config source" });
        const project = body.project ?? "";
        if (project && !SAFE_PROJECT.test(project)) return json(res, 400, { error: "bad project" });
        const r = saveConfigSource(opts.dir, project, body.source);
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
        if (session.pending) return json(res, 409, { ...runBody(session), error: { cls: "AttestationPending", message: "a principal attestation is pending — rule on it first" } });
        // a prompt reaction may itself escalate to a principal, so run it TRACKED and give it a settle
        // beat: a fast reaction returns complete; a consult-blocked one returns `waiting` + the pending.
        const inputs = body.promptInputs ?? [];
        track(session, (async () => { for (const input of inputs) await session.runtime.sendPrompt(input); })());
        await settle(session, 400);
        return json(res, 200, runBody(session));
      }
      if (req.method === "GET" && url.pathname === "/api/session") {
        const session = sessions.get(url.searchParams.get("sessionId") ?? "");
        if (!session) return json(res, 404, { error: "listening session not found" });
        return json(res, 200, runBody(session));
      }
      if (req.method === "POST" && url.pathname === "/api/attest") {
        // §13/§16.4 — the principal's ruling. `decision` must be one of the gate enum's variants (the
        // attestation IS the manual variant choice); `decline: true` refuses to rule →
        // FailedPrincipalDecision, and the decision stays abstained (fail closed).
        const body = JSON.parse((await readBody(req)) || "{}") as {
          sessionId?: string;
          attestationId?: string;
          decision?: string;
          decline?: boolean;
          attester?: string;
        };
        const session = body.sessionId ? sessions.get(body.sessionId) : undefined;
        if (!session) return json(res, 404, { error: "listening session not found" });
        const pending = session.pending;
        if (!pending || !session.resolveConsult) return json(res, 409, { error: "no attestation is pending on this session" });
        if (body.attestationId && body.attestationId !== pending.id) return json(res, 409, { error: "stale attestation id — refresh the session" });
        if (!body.decline && (!body.decision || !pending.variants.includes(body.decision))) {
          return json(res, 400, { error: `the ruling must be one of the enum's variants: ${pending.variants.join(", ")} (or decline)` });
        }
        session.resolveConsult(
          body.decline
            ? undefined
            : { principal: pending.principal, decision: body.decision, attester: body.attester || "studio-user" },
        );
        await settle(session, 800); // let the resumed run finish (or reach the next consult)
        return json(res, 200, runBody(session));
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
