// Agape Studio — agent server. The somatic stand-in for the studio's agentic layer:
//   /agent/* — pair/delegate with a builder agent (Claude/OpenAI today)
//   /learn/* — the Agape-learning loop over the spine + three-modality memory (§10)
// Replaced by the Agape + MCP backend behind the same seams. See RUNTIME.md.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { buildMessages, type AgentContext, type Intent } from "./agent.ts";
import { AnthropicCognition, HashingEmbedder, MockCognition, OpenAICognition, OpenAIEmbedder, type Cognition, type Embedder } from "./provider.ts";
import { Memory } from "./memory.ts";
import { makeRunner } from "./runner.ts";
import { Learner } from "./learner.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { agentsAndPrompts, safeProjectPath as resolveSafe } from "./lib.ts";
import { makeGrader, type Grader } from "./gate.ts";
const pExecFile = promisify(execFile);

const PORT = Number(process.env.AGENT_PORT) || 8799;

type CognitionProvider = "mock" | "anthropic" | "openai";
type EmbeddingProvider = "local" | "openai";
type JudgeProvider = "anthropic" | "openai" | "gemini";
interface ProviderConfig {
  cognitionProvider: CognitionProvider;
  judgeProvider: JudgeProvider;
  embeddingProvider: EmbeddingProvider;
  samples: number;
  temperature: number;
  openaiTopLogprobs: number;
}
type RuntimeMode = "local" | "cloud";
interface RuntimeConfig {
  mode: RuntimeMode;
  endpoint: string;
  label: string;
  version: string;
}

// Find provider API keys: env first, else walk up from cwd to the repo-root .env.
function loadProviderEnv(): void {
  const explicit = [
    path.resolve(process.cwd(), "..", "..", "agape", ".env"),
    path.resolve(process.cwd(), "..", "..", ".env"),
  ];
  for (const envPath of explicit) {
    if (!fs.existsSync(envPath)) continue;
    readEnvFile(envPath);
    return;
  }
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    const envPath = path.join(dir, ".env");
    if (fs.existsSync(envPath)) {
      readEnvFile(envPath);
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

function readEnvFile(envPath: string): void {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

loadProviderEnv();
if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
  console.warn("agent-server: no ANTHROPIC_API_KEY or OPENAI_API_KEY — deterministic mock + project studio work offline; live-model features need a key.");
}

let providerConfig: ProviderConfig = {
  cognitionProvider: normalizeCognitionProvider(process.env.AGENT_COGNITION_PROVIDER || process.env.AGENT_PROVIDER || "mock"),
  judgeProvider: normalizeJudgeProvider(process.env.AGENT_JUDGE_PROVIDER || judgeProviderForCognition(process.env.AGENT_COGNITION_PROVIDER || process.env.AGENT_PROVIDER || "mock")),
  embeddingProvider: normalizeEmbeddingProvider(process.env.AGENT_EMBEDDING_PROVIDER || defaultEmbeddingProvider(normalizeCognitionProvider(process.env.AGENT_COGNITION_PROVIDER || process.env.AGENT_PROVIDER || "mock"))),
  samples: clampInt(process.env.AGENT_JUDGE_SAMPLES, 1, 50, 5),
  temperature: clampFloat(process.env.AGENT_JUDGE_TEMPERATURE, 0, 1, 0),
  openaiTopLogprobs: clampInt(process.env.OPENAI_TOP_LOGPROBS, 1, 20, 5),
};
let runtimeConfig: RuntimeConfig = {
  mode: normalizeRuntimeMode(process.env.AGAPE_STUDIO_RUNTIME_MODE || "local"),
  endpoint: String(process.env.AGAPE_RUNTIME_ENDPOINT || ""),
  label: String(process.env.AGAPE_RUNTIME_LABEL || "Local runtime"),
  version: String(process.env.AGAPE_RUNTIME_VERSION || ""),
};

// Cognition is constructed lazily, so the studio starts and serves the mock
// provider + project with no API key; the live-model endpoints throw a friendly
// error if called without one.
let _cognition: Cognition | null = null;
function cognition(): Cognition {
  if (!_cognition) {
    if (providerConfig.cognitionProvider === "openai") {
      if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not set — OpenAI cognition needs a live key.");
      _cognition = new OpenAICognition();
    } else if (providerConfig.cognitionProvider === "anthropic") {
      if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set — Claude cognition needs a live key.");
      _cognition = new AnthropicCognition();
    } else {
      _cognition = new MockCognition();
    }
  }
  return _cognition;
}

// Credence materialization (§3): produce a distribution over the variant set that the
// gate consumes. Studio derives this from the active cognition provider; AGENT_JUDGE_PROVIDER
// remains only as a low-level override for local experiments and compatibility.
let _grader: Grader | null = null;
function grader(): Grader {
  if (!_grader) _grader = makeGrader(providerConfig.judgeProvider, { openaiTopLogprobs: providerConfig.openaiTopLogprobs });
  return _grader;
}

function providerSnapshot() {
  return {
    ...providerConfig,
    keys: {
      anthropic: !!process.env.ANTHROPIC_API_KEY,
      openai: !!process.env.OPENAI_API_KEY,
      gemini: !!process.env.GEMINI_API_KEY,
      embeddings: providerConfig.embeddingProvider === "openai" ? !!process.env.OPENAI_API_KEY : true,
    },
    embeddingModel: providerConfig.embeddingProvider === "openai" ? (process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small") : "hashing-local",
    cognitionModel: providerConfig.cognitionProvider === "openai"
      ? (process.env.OPENAI_AGENT_MODEL || "gpt-4o-mini")
      : (process.env.AGENT_MODEL || "claude-haiku-4-5"),
    judgeModel: providerConfig.judgeProvider === "openai"
      ? (process.env.OPENAI_JUDGE_MODEL || "gpt-4o-mini")
      : providerConfig.judgeProvider === "gemini"
        ? (process.env.GEMINI_JUDGE_MODEL || "gemini-2.5-flash")
        : (process.env.ANTHROPIC_JUDGE_MODEL || "claude-haiku-4-5"),
  };
}

function runtimeSnapshot() {
  const version = runtimeConfig.version || localRuntimeVersion();
  return { ...runtimeConfig, version, connected: runtimeConfig.mode === "local" || !!runtimeConfig.endpoint };
}

function updateRuntimeConfig(input: Partial<RuntimeConfig>) {
  runtimeConfig = {
    mode: input.mode === undefined ? runtimeConfig.mode : normalizeRuntimeMode(input.mode),
    endpoint: input.endpoint === undefined ? runtimeConfig.endpoint : String(input.endpoint || "").trim(),
    label: input.label === undefined ? runtimeConfig.label : String(input.label || "").trim() || (normalizeRuntimeMode(input.mode || runtimeConfig.mode) === "cloud" ? "Cloud runtime" : "Local runtime"),
    version: input.version === undefined ? runtimeConfig.version : String(input.version || "").trim(),
  };
}

function updateProviderConfig(input: Partial<ProviderConfig>) {
  const nextCognitionProvider = input.cognitionProvider === undefined ? providerConfig.cognitionProvider : normalizeCognitionProvider(input.cognitionProvider);
  const nextJudgeProvider = input.judgeProvider === undefined
    ? (input.cognitionProvider === undefined ? providerConfig.judgeProvider : judgeProviderForCognition(nextCognitionProvider))
    : normalizeJudgeProvider(input.judgeProvider);
  const nextEmbeddingProvider = input.embeddingProvider === undefined
    ? (input.cognitionProvider === undefined ? providerConfig.embeddingProvider : defaultEmbeddingProvider(nextCognitionProvider))
    : normalizeEmbeddingProvider(input.embeddingProvider);
  const next: ProviderConfig = {
    cognitionProvider: nextCognitionProvider,
    judgeProvider: nextJudgeProvider,
    embeddingProvider: nextEmbeddingProvider,
    samples: input.samples === undefined ? providerConfig.samples : clampInt(input.samples, 1, 50, providerConfig.samples),
    temperature: input.temperature === undefined ? providerConfig.temperature : clampFloat(input.temperature, 0, 1, providerConfig.temperature),
    openaiTopLogprobs: input.openaiTopLogprobs === undefined ? providerConfig.openaiTopLogprobs : clampInt(input.openaiTopLogprobs, 1, 20, providerConfig.openaiTopLogprobs),
  };
  if (next.cognitionProvider !== providerConfig.cognitionProvider) _cognition = null;
  if (next.judgeProvider !== providerConfig.judgeProvider || next.openaiTopLogprobs !== providerConfig.openaiTopLogprobs) _grader = null;
  if (next.embeddingProvider !== providerConfig.embeddingProvider || next.cognitionProvider !== providerConfig.cognitionProvider) {
    sharedMemory?.close();
    sharedMemory = null;
    learner = null;
  }
  providerConfig = next;
}


function defaultEmbeddingProvider(cognitionProvider: CognitionProvider): EmbeddingProvider {
  return cognitionProvider === "mock" ? "local" : "openai";
}

function normalizeEmbeddingProvider(value: unknown): EmbeddingProvider {
  const s = String(value || "").toLowerCase();
  if (s === "openai" || s === "live") return "openai";
  return "local";
}
function normalizeCognitionProvider(value: unknown): CognitionProvider {
  const s = String(value || "").toLowerCase();
  if (s === "openai") return "openai";
  if (s === "anthropic" || s === "claude") return "anthropic";
  return "mock";
}

function normalizeJudgeProvider(value: unknown): JudgeProvider {
  const s = String(value || "").toLowerCase();
  if (s === "openai") return "openai";
  if (s === "gemini") return "gemini";
  return "anthropic";
}

function normalizeRuntimeMode(value: unknown): RuntimeMode {
  return String(value || "").toLowerCase() === "cloud" ? "cloud" : "local";
}

function judgeProviderForCognition(value: unknown): JudgeProvider {
  const provider = normalizeCognitionProvider(value);
  if (provider === "openai") return "openai";
  return "anthropic";
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function clampFloat(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

// The learning subsystem, lazily started (so /agent/* works even if better-sqlite3
// hasn't been built). Memory persists to data/agape.db; the runner uses agape-rs.
const HERE = process.cwd();
const AGAPE_ROOT =
  [
    path.resolve(HERE, "..", ".."),
    path.resolve(HERE, "..", "..", "agape"),
  ].find((p) => fs.existsSync(path.join(p, "agape-rs"))) || path.resolve(HERE, "..", "..");
const AGAPE_RS = path.join(AGAPE_ROOT, "agape-rs");
const SPEC_PATH = path.join(AGAPE_ROOT, "SPEC.md");
function localRuntimeVersion(): string {
  const cargo = path.join(AGAPE_RS, "Cargo.toml");
  if (!fs.existsSync(cargo)) return "unknown";
  return readTomlString(fs.readFileSync(cargo, "utf8"), "version") || "unknown";
}

function readTomlString(body: string, key: string, section?: string): string | null {
  let current = "";
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      current = sectionMatch[1].trim();
      continue;
    }
    if (section && current !== section) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*"([^"]*)"/);
    if (m && m[1] === key) return m[2];
  }
  return null;
}

function projectLanguageVersion(): string {
  if (!PROJECT) return "unknown";
  const toml = path.join(PROJECT, "agape.toml");
  if (!fs.existsSync(toml)) return "unknown";
  const body = fs.readFileSync(toml, "utf8");
  return (
    readTomlString(body, "language", "project") ||
    readTomlString(body, "language_version", "project") ||
    readTomlString(body, "version", "language") ||
    readTomlString(body, "agape", "language") ||
    "unknown"
  );
}

function projectManifest() {
  if (!PROJECT) return null;
  const toml = path.join(PROJECT, "agape.toml");
  if (!fs.existsSync(toml)) return null;
  return { rel: "agape.toml", languageVersion: projectLanguageVersion() };
}
let learner: Learner | null = null;
let sharedMemory: Memory | null = null;
let sharedRunner: ReturnType<typeof makeRunner> | null = null;
const DEFAULT_AGENT_ID = "Builder-1";
function createEmbedder(): Embedder {
  if (providerConfig.embeddingProvider === "local") return new HashingEmbedder();
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY not set — live Studio memory embeddings require OpenAI embeddings; set AGENT_EMBEDDING_PROVIDER=local only for offline development.");
  }
  return new OpenAIEmbedder();
}
function getMemory(): Memory {
  if (!sharedMemory) {
    fs.mkdirSync(path.join(HERE, "data"), { recursive: true });
    sharedMemory = new Memory(createEmbedder(), path.join(HERE, "data", "agape.db"));
  }
  return sharedMemory;
}
function getRunner() {
  if (!sharedRunner) sharedRunner = makeRunner(AGAPE_RS);
  return sharedRunner;
}
function getLearner(agentId = DEFAULT_AGENT_ID): Learner {
  if (!learner) console.log(`agent-server: learner ready · runner = ${getRunner().name}`);
  learner = new Learner(getMemory(), cognition(), getRunner(), agentId);
  return learner;
}

function send(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "POST, GET, OPTIONS",
  });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 2_000_000) reject(new Error("body too large")); });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

function sendText(res: http.ServerResponse, code: number, body: string): void {
  // Set Content-Length explicitly so Node never falls back to chunked encoding —
  // the zero-dep Rust client reads a plain body after the header block.
  const buf = Buffer.from(body, "utf-8");
  res.writeHead(code, { "content-type": "text/plain; charset=utf-8", "content-length": buf.length, "access-control-allow-origin": "*" });
  res.end(buf);
}

function readJson(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 2_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

// ── review: spec + conformance suite + live results (the Review studio) ──────
const REPO = AGAPE_ROOT;
const TESTS_DIR = path.resolve(REPO, "agape-conformance", "tests");

// ── project: the user's own Agape project, opened via `agape studio` ──────────
// `AGAPE_PROJECT` is set by the CLI launcher; null ⇒ no project (Review only).
const PROJECT = process.env.AGAPE_PROJECT ? resolveProjectRoot(process.env.AGAPE_PROJECT) : null;
// Resolve the `agape` binary across layouts: an explicit override, the packaged
// bundle (studio/agent-server → ../../bin/agape), or a local release/dev build.
const AGAPE_BIN =
  process.env.AGAPE_BIN ||
  [
    path.resolve(HERE, "..", "..", "bin", "agape"),
    path.resolve(AGAPE_RS, "target", "release", "agape"),
    path.resolve(AGAPE_RS, "target", "debug", "agape"),
  ].find((p) => fs.existsSync(p)) ||
  "agape";

// In a packaged bundle the agent-server also serves the built web app (one
// process, no Vite). `AGAPE_WEB_DIST` points at the static `dist/`.
const WEB_DIST = process.env.AGAPE_WEB_DIST ? path.resolve(process.env.AGAPE_WEB_DIST) : null;
const MIME: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".png": "image/png",
  ".jpg": "image/jpeg", ".woff": "font/woff", ".woff2": "font/woff2", ".map": "application/json", ".wasm": "application/wasm",
};

// Serve a file from the built web app, falling back to index.html for SPA routes.
function serveStatic(res: http.ServerResponse, url: string): boolean {
  if (!WEB_DIST) return false;
  let rel = decodeURIComponent(url).replace(/^\/+/, "");
  if (rel === "") rel = "index.html";
  let full = path.resolve(WEB_DIST, rel);
  if (!full.startsWith(WEB_DIST)) return false; // path-traversal guard
  if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) full = path.join(WEB_DIST, "index.html");
  if (!fs.existsSync(full)) return false;
  const buf = fs.readFileSync(full);
  res.writeHead(200, { "content-type": MIME[path.extname(full)] || "application/octet-stream", "content-length": buf.length });
  res.end(buf);
  return true;
}

function resolveProjectRoot(start: string): string {
  let dir = path.resolve(start);
  if (fs.existsSync(dir) && fs.statSync(dir).isFile()) dir = path.dirname(dir);
  for (let i = 0; i < 16; i++) {
    if (fs.existsSync(path.join(dir, "agape.toml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(start);
}

// List the project's .ag files with a shallow parse of the agents/sensors they
// declare — enough for the studio to show the agent inventory at a glance.
function projectFiles(): Array<{ rel: string; agents: string[]; prompts: string[] }> {
  if (!PROJECT || !fs.existsSync(PROJECT)) return [];
  const out: string[] = [];
  walkAg(PROJECT, out);
  out.sort();
  return out.map((f) => {
    const { agents, prompts } = agentsAndPrompts(fs.readFileSync(f, "utf8"));
    return { rel: path.relative(PROJECT, f).replace(/\\/g, "/"), agents, prompts };
  });
}

function projectName(): string {
  if (!PROJECT) return "";
  const toml = path.join(PROJECT, "agape.toml");
  if (fs.existsSync(toml)) {
    const m = fs.readFileSync(toml, "utf8").match(/name\s*=\s*"([^"]+)"/);
    if (m) return m[1];
  }
  return path.basename(PROJECT);
}

function safeProjectRead(rel: string, maxBytes = 12_000): string | null {
  if (!PROJECT) return null;
  const full = path.resolve(PROJECT, rel);
  const base = path.resolve(PROJECT);
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  if (!/\.(ag|md|toml|json)$/i.test(full)) return null;
  if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) return null;
  const text = fs.readFileSync(full, "utf8");
  return text.length > maxBytes ? text.slice(0, maxBytes) + "\n...[truncated]" : text;
}

function agentTask(item: any, thread: any[], intent: Intent): string {
  const lastUser = [...(Array.isArray(thread) ? thread : [])].reverse().find((m) => m?.who === "you")?.text || "";
  return [intent, item?.title, item?.destination, lastUser].filter(Boolean).join("\n");
}

function wantsProjectOverview(text: string): boolean {
  const t = text.toLowerCase();
  return (
    /\bwhat\b.*\b(project|repo|repository|app|application)\b.*\b(about|contain|contains|inside|in|so far)\b/.test(t) ||
    /\bwhat\b.*\bin this project\b/.test(t) ||
    /\b(tell|show|summarize|explain)\b.*\b(project|repo|repository|app|application)\b/.test(t) ||
    /\bwhat do we have\b.*\bso far\b/.test(t)
  );
}

function directAgentAnswer(item: any, thread: any[], intent: Intent): string | null {
  const task = agentTask(item, thread, intent);
  if (wantsProjectOverview(task)) return projectOverviewAnswer();
  return null;
}

function operationGuidance(intent: Intent): string {
  const shared =
    "The server has already gathered project files, manifest metadata, and builder memory where available. " +
    "Use that evidence directly; do not promise to fetch it later.";
  switch (intent) {
    case "inspect":
      return `${shared} This is an Inspect turn: answer with concrete findings, cite the observed files/agents/prompts/ledger state when useful, and close with the smallest next inspection or run that would reduce uncertainty.`;
    case "plan":
      return `${shared} This is a Plan turn: produce a short executable plan, state the first action, and name any user decision that blocks progress.`;
    case "build":
      return `${shared} This is a Build turn: identify the smallest safe change, the likely files involved, and whether code was actually changed in this turn. Do not imply an edit happened unless this server turn performed it.`;
    case "run":
      return `${shared} This is a Run turn: explain the command or Studio run that should be executed, the ledger events that would confirm success, and what result would count as failure.`;
    case "review":
      return `${shared} This is a Review turn: lead with bugs, authority/gate risks, misleading conversation risks, and missing tests. Keep summaries secondary.`;
    case "kickoff":
      return `${shared} This is a delegated work turn: start from the available context and give the first useful result or first concrete move.`;
    default:
      return `${shared} This is a conversational turn: answer naturally, directly, and from the current thread context.`;
  }
}

function projectContextForAgent(task: string): string {
  if (!PROJECT) return "No Agape project is currently attached to Studio.";
  const files = projectFiles();
  const sections: string[] = [
    `Project: ${projectName() || path.basename(PROJECT)}`,
    `Root: ${PROJECT}`,
    `Language version: ${projectLanguageVersion()}`,
    `Sources: ${files.length ? files.map((f) => `${f.rel} (${f.agents.length} agents, ${f.prompts.length} prompts)`).join("; ") : "none"}`,
  ];

  for (const rel of ["agape.toml", "README.md", "DESIGN.md"]) {
    const text = safeProjectRead(rel, rel.endsWith(".md") ? 8_000 : 4_000);
    if (text) sections.push(`--- ${rel} ---\n${text}`);
  }

  const terms = new Set((task.toLowerCase().match(/[a-z0-9_.\/-]+/g) || []).filter((t) => t.length > 2));
  const chosen = files
    .filter((f) => terms.has(f.rel.toLowerCase()) || f.agents.some((a) => terms.has(a.toLowerCase())) || f.prompts.some((p) => terms.has(p.toLowerCase())))
    .concat(files)
    .filter((f, i, arr) => arr.findIndex((x) => x.rel === f.rel) === i)
    .slice(0, 5);
  for (const f of chosen) {
    const text = safeProjectRead(f.rel, 10_000);
    if (text) sections.push(`--- ${f.rel} ---\n${text}`);
  }

  sections.push("Ledger evidence: no live run ledger is attached to this agent turn. Use the Run view to produce concrete runtime events when behavior, gates, or actions must be verified.");
  return limitText(sections.join("\n\n"), 26_000);
}

function agentInstanceId(item: any): string {
  const id = String(item?.assignee || item?.agent || DEFAULT_AGENT_ID).trim();
  return id || DEFAULT_AGENT_ID;
}

async function agentMemoryForTurn(agentId: string, task: string): Promise<string> {
  try {
    const ctx = await getLearner(agentId).codingContext(task, { recordConsult: true });
    const parts = [
      `Agent: ${ctx.agent}`,
      `Runner: ${ctx.runner}`,
      `Memory counts: ledger=${ctx.counts?.spine ?? 0}, facts=${ctx.counts?.facts ?? 0}, triples=${ctx.counts?.triples ?? 0}, embeddings=${ctx.counts?.embeddings ?? 0}`,
      `Memory consult: ${ctx.consultTick ? `recorded at ledger #${ctx.consultTick}` : "recorded with no new ledger tick"}`,
      ctx.rules?.length ? "Rules:\n" + ctx.rules.map((r: string) => `- ${r}`).join("\n") : "",
      ctx.context ? "Retrieved context:\n" + ctx.context : "Retrieved context: memory is empty or no entries matched.",
    ].filter(Boolean);
    return limitText(parts.join("\n\n"), 10_000);
  } catch (e: any) {
    return `Agent memory unavailable for this turn: ${e?.message || "unknown error"}.`;
  }
}

async function agentContext(item: any, thread: any[], intent: Intent): Promise<AgentContext> {
  const task = agentTask(item, thread, intent);
  const agentId = agentInstanceId(item);
  return {
    operation: operationGuidance(intent),
    project: projectContextForAgent(task),
    memory: await agentMemoryForTurn(agentId, task),
  };
}

async function recordAgentExperience(agentId: string, kind: string, subject: string, text: string, meta: Record<string, unknown> = {}): Promise<void> {
  try {
    await getLearner(agentId).internalizeExperience(kind, subject, text, meta);
  } catch (e: any) {
    console.warn(`agent-server: memory internalization failed for ${agentId}: ${e?.message || e}`);
  }
}

function normalizeAgentIntent(value: unknown): Intent {
  const s = String(value || "").toLowerCase();
  if (["kickoff", "plan", "build", "inspect", "run", "review"].includes(s)) return s as Intent;
  return "respond";
}

function routeAgentIntent(value: unknown, item: any, thread: any[]): Intent {
  const requested = normalizeAgentIntent(value);
  const task = agentTask(item, thread, requested);
  if (wantsProjectOverview(task)) return "inspect";
  return requested;
}

function placeholderProgress(text: string): boolean {
  const t = String(text || "").toLowerCase();
  if (!t.trim()) return true;
  const markers = [
    "i will retrieve",
    "i'll retrieve",
    "i will inspect",
    "i'll inspect",
    "i will analyze",
    "i'll analyze",
    "please hold",
    "one moment",
    "retrieving project",
    "fetching the project",
    "now i will present",
  ];
  return markers.some((m) => t.includes(m));
}

function fallbackAgentAnswer(item: any, thread: any[], intent: Intent, reason?: string): string | null {
  const direct = directAgentAnswer(item, thread, intent);
  if (direct) return direct;
  if (!PROJECT) return "I do not have an Agape project attached to this Studio session yet.";

  const files = projectFiles();
  const fileList = files.length ? files.map((f) => f.rel).join(", ") : "no .ag files found";
  const agents = files.flatMap((f) => f.agents.map((name) => `${name} (${f.rel})`));
  const prompts = files.flatMap((f) => f.prompts.map((name) => `${name} (${f.rel})`));
  const prefix = reason ? `The live model response was not usable (${reason}), so I am answering from the server's project observations.\n\n` : "";

  if (intent === "plan" || intent === "kickoff") {
    return prefix + [
      `Plan for ${projectName() || path.basename(PROJECT)}:`,
      "",
      `1. Inspect the declared Agape surface: ${fileList}.`,
      `2. Confirm the active agents${agents.length ? ` (${agents.join(", ")})` : ""} and prompt inputs${prompts.length ? ` (${prompts.join(", ")})` : ""}.`,
      "3. Run the relevant .ag file from Studio's Run view so the ledger shows actual Prompt, Credence, Decision, and action events.",
      "4. Use that ledger evidence to decide whether the agent needs a prompt, gate, memory, or authority change.",
    ].join("\n");
  }

  if (intent === "build") {
    return prefix + [
      "Build turn routed from the current project context:",
      "",
      `- Files to inspect first: ${fileList}.`,
      `- Declared agents: ${agents.length ? agents.join(", ") : "none found yet"}.`,
      `- Prompt inputs: ${prompts.length ? prompts.join(", ") : "none found yet"}.`,
      "- Smallest safe change: make the selected badge choose an operation, gather project and memory context before the model call, then reject placeholder progress before showing a response.",
      "- I have not edited the opened project from this Studio turn; this is the concrete next implementation direction.",
    ].join("\n");
  }

  if (intent === "run") {
    return prefix + [
      "Run turn from the available project context:",
      "",
      `- Candidate source files: ${fileList}.`,
      "- Execute the relevant file through the Run view or `/project/run`.",
      "- Confirm success in the ledger by looking for Prompt, Spawned/AgentAwake, model output or Credence, Decided, and the final action event.",
      "- If those events are missing, the issue is orchestration/runtime wiring rather than natural-language quality.",
    ].join("\n");
  }

  if (intent === "review") {
    return prefix + [
      "Review findings from the current project context:",
      "",
      "- The conversation is unsafe if it forwards raw placeholder model text like \"I will retrieve\" to the user.",
      "- Each badge should route to an operation with explicit context gathering and a response contract.",
      "- Any consequential action should remain behind Agape grants and endorse gates; conversational summaries should cite ledger evidence when available.",
      "- Add tests for route override, project-context injection, and placeholder-response repair.",
    ].join("\n");
  }

  if (intent === "inspect") return prefix + projectOverviewAnswer();
  return null;
}

function limitText(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "\n...[truncated]" : text;
}

function projectOverviewAnswer(): string {
  if (!PROJECT) return "I do not have an Agape project attached to this Studio session yet.";
  const files = projectFiles();
  const agents = files.flatMap((f) => f.agents.map((name) => `${name} (${f.rel})`));
  const prompts = files.flatMap((f) => f.prompts.map((name) => `${name} (${f.rel})`));
  const readme = firstUsefulParagraph(safeProjectRead("README.md", 4_000) || "");
  const design = firstUsefulParagraph(sectionText(safeProjectRead("DESIGN.md", 8_000) || "", "Purpose"));
  const manifest = projectManifest();

  const lines = [
    `Here is what is in ${projectName() || path.basename(PROJECT)} so far:`,
    "",
    `- Manifest: ${manifest ? `${manifest.rel}${manifest.languageVersion && manifest.languageVersion !== "unknown" ? `, language ${manifest.languageVersion}` : ""}` : "no agape.toml found"}.`,
    `- Source files: ${files.length ? files.map((f) => f.rel).join(", ") : "no .ag source files found"}.`,
    `- Agents: ${agents.length ? agents.join(", ") : "none declared yet"}.`,
    `- Prompt inputs: ${prompts.length ? prompts.join(", ") : "none declared yet"}.`,
  ];
  if (readme) lines.push(`- README: ${readme}`);
  if (design) lines.push(`- Design intent: ${design}`);
  lines.push("- Ledger: no run ledger is attached to this thread yet; run a source file from the Run view to inspect concrete events, gates, and actions.");
  return lines.join("\n");
}

function firstUsefulParagraph(text: string): string {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/^#+\s+.*/gm, "").replace(/\s+/g, " ").trim())
    .find((p) => p.length > 20 && !p.startsWith("```")) || "";
}

function sectionText(markdown: string, heading: string): string {
  if (!markdown) return "";
  const lines = markdown.split(/\r?\n/);
  const headingRe = new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, "i");
  const start = lines.findIndex((line) => headingRe.test(line.trim()));
  if (start < 0) return markdown;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i].trim())) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Resolve a project-relative path, refusing anything that escapes the root (the
// guard itself lives in lib.ts so it can be unit-tested).
function safeProjectPath(rel: string): string | null {
  return PROJECT ? resolveSafe(PROJECT, rel) : null;
}

// Run one project file through the `agape` CLI (--json), feeding prompt inputs.
// `live` routes the `<-` seam to the live provider (this same agent-server).
// The runtime flag is still named `--claude`; this server can back it with Claude or OpenAI.
async function runProjectFile(rel: string, prompts: Record<string, string>, live?: boolean, samples?: number, temperature?: number) {
  const full = safeProjectPath(rel);
  if (!full || !fs.existsSync(full)) return { ok: false, error: `no such file: ${rel}` };
  const args = ["run", full, "--json"];
  for (const [k, v] of Object.entries(prompts || {})) args.push("--prompt", `${k}=${v}`);
  if (live) {
    args.push("--claude");
    if (samples && samples > 0) args.push("--samples", String(samples));
    if (temperature && temperature > 0) args.push("--temperature", String(temperature));
  }
  const useCargo = !fs.existsSync(AGAPE_BIN);
  const bin = useCargo ? "cargo" : AGAPE_BIN;
  const argv = useCargo ? ["run", "--quiet", "--bin", "agape", "--", ...args] : args;
  // The binary reads absolute paths, so cwd only needs to exist — AGAPE_RS for the
  // cargo fallback (dev), else the project dir (a bundle has no agape-rs tree).
  const cwd = useCargo ? AGAPE_RS : (PROJECT || process.cwd());
  try {
    // Live model runs make several API calls (the sampling fallback), so allow longer.
    const r = await pExecFile(bin, argv, { cwd, timeout: live ? 180_000 : 60_000, maxBuffer: 20_000_000 });
    return JSON.parse(r.stdout);
  } catch (e: any) {
    // A static-rejection exits non-zero but still prints the JSON error envelope.
    if (e?.stdout) { try { return JSON.parse(e.stdout); } catch {} }
    return { ok: false, error: e?.stderr || e?.message || "run failed" };
  }
}

function walkAg(dir: string, out: string[]): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkAg(p, out);
    else if (e.name.endsWith(".ag")) out.push(p);
  }
}

function parseAg(file: string): { header: Record<string, string>; body: string } {
  const header: Record<string, string> = {};
  const body: string[] = [];
  let inBody = false;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (inBody) { body.push(line); continue; }
    const s = line.trim();
    if (s.startsWith("//!")) {
      const c = s.slice(3).trim();
      if (c === "---") { inBody = true; continue; }
      const i = c.indexOf(":");
      if (i >= 0) header[c.slice(0, i).trim()] = c.slice(i + 1).trim();
    } else { inBody = true; body.push(line); }
  }
  return { header, body: body.join("\n") };
}

// Async + single-flight so the cargo run never blocks the event loop (a sync spawn
// wedges the whole server) and concurrent refreshes share one run.
let conformanceInflight: Promise<{ status: Record<string, string>; buildOk: boolean; summary: string }> | null = null;

function runConformance() {
  if (conformanceInflight) return conformanceInflight;
  conformanceInflight = (async () => {
    let stdout = "", stderr = "";
    try {
      const r = await pExecFile("cargo", ["run", "--quiet", "--bin", "conformance", "--", "--fails"],
        { cwd: AGAPE_RS, timeout: 120_000, maxBuffer: 50_000_000 });
      stdout = r.stdout; stderr = r.stderr;
    } catch (e: any) {
      // execFile rejects on a non-zero exit (the runner exits non-zero when tests
      // fail) — the output we want is still on e.stdout/e.stderr.
      stdout = e?.stdout || ""; stderr = e?.stderr || String(e?.message || e);
    }
    const text = stdout + "\n" + stderr;
    const status: Record<string, string> = {};
    let buildOk = true, summary = "";
    if (text.includes("error[") || text.includes("could not compile")) buildOk = false;
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*✗\s+(\S+)\s+(\S+)\s+(.*)/);
      if (m) status[m[2]] = m[3].trim();
      const m2 = line.match(/(\d+)\s+pass\b[^\d]*?(\d+)\s+fail/);
      if (m2) summary = line.trim();
    }
    return { status, buildOk, summary };
  })();
  conformanceInflight.finally(() => { conformanceInflight = null; });
  return conformanceInflight;
}

// Run the suite and project each .ag file to a {test, status} row. No spec read,
// so the "Run tests" button can refresh results without disturbing the editor.
async function reviewTests() {
  const files: string[] = [];
  if (fs.existsSync(TESTS_DIR)) walkAg(TESTS_DIR, files);
  files.sort();
  const { status, buildOk, summary } = await runConformance();
  const tests = files.map((f) => {
    const { header, body } = parseAg(f);
    const id = header.id || path.basename(f, ".ag");
    const directives: Record<string, string> = {};
    for (const k of ["provider", "attest", "manifest", "replay", "order", "spine", "contains", "absent"]) if (header[k]) directives[k] = header[k];
    return {
      id, section: path.basename(path.dirname(f)),
      rel: path.relative(REPO, f).replace(/\\/g, "/"),
      expect: header.expect || "", error: header.error || "", spec: header.spec || "", note: header.note || "",
      body, status: status[id] ? "fail" : "pass", reason: status[id] || "", directives,
    };
  });
  return { tests, buildOk, summary, passed: tests.filter((t) => t.status === "pass").length, total: tests.length };
}

async function reviewData() {
  const spec = fs.existsSync(SPEC_PATH) ? fs.readFileSync(SPEC_PATH, "utf8") : "";
  return { spec, ...(await reviewTests()) };
}

const server = http.createServer(async (req, res) => {
  const url = (req.url || "").split("?")[0];
  try {
    if (req.method === "OPTIONS") return send(res, 204, {});

    if (req.method === "GET" && url === "/agent/health") {
      return send(res, 200, { ok: true, ...providerSnapshot() });
    }

    if (req.method === "GET" && url === "/agent/config") {
      return send(res, 200, providerSnapshot());
    }

    if (req.method === "POST" && url === "/agent/config") {
      updateProviderConfig((await readJson(req)) || {});
      return send(res, 200, providerSnapshot());
    }

    if (req.method === "GET" && url === "/runtime/config") {
      return send(res, 200, runtimeSnapshot());
    }

    if (req.method === "POST" && url === "/runtime/config") {
      updateRuntimeConfig((await readJson(req)) || {});
      return send(res, 200, runtimeSnapshot());
    }

    // ── pair / delegate ──
    if (req.method === "POST" && url === "/agent/respond") {
      const { item, thread, intent } = (await readJson(req)) || {};
      if (!item || !item.title) return send(res, 400, { error: "item.title is required" });
      const safeThread = Array.isArray(thread) ? thread : [];
      const agentId = agentInstanceId(item);
      const turnIntent = routeAgentIntent(intent, item, safeThread);
      const context = await agentContext(item, safeThread, turnIntent);
      const task = agentTask(item, safeThread, turnIntent);
      const direct = directAgentAnswer(item, safeThread, turnIntent);
      if (direct) {
        await recordAgentExperience(agentId, "agent-turn", task, direct, { source: "project-context", intent: turnIntent });
        return send(res, 200, { text: direct, intent: turnIntent, source: "project-context" });
      }
      const { system, messages } = buildMessages(item, safeThread, turnIntent, context);
      try {
        const text = await cognition().complete(system, messages, 1024);
        if (placeholderProgress(text)) {
          const repaired = fallbackAgentAnswer(item, safeThread, turnIntent, "placeholder progress");
          if (repaired) {
            await recordAgentExperience(agentId, "agent-turn", task, repaired, { source: "repair", intent: turnIntent, reason: "placeholder progress" });
            return send(res, 200, { text: repaired, intent: turnIntent, source: "repair" });
          }
        }
        const responseText = text || "(the agent had nothing to add)";
        await recordAgentExperience(agentId, "agent-turn", task, responseText, { source: "model", intent: turnIntent });
        return send(res, 200, { text: responseText, intent: turnIntent, source: "model" });
      } catch (e: any) {
        const fallback = fallbackAgentAnswer(item, safeThread, turnIntent, e?.message || "provider unavailable");
        if (fallback) {
          await recordAgentExperience(agentId, "agent-turn", task, fallback, { source: "fallback", intent: turnIntent, error: e?.message || "provider unavailable" });
          return send(res, 200, { text: fallback, intent: turnIntent, source: "fallback" });
        }
        throw e;
      }
    }

    // ── the learning loop ──
    if (req.method === "POST" && url === "/learn/ingest") {
      const { maxChunks, text, rel, kind, uri, title, agent } = (await readJson(req)) || {};
      let body = typeof text === "string" ? text : "";
      if (!body && rel) {
        const projectText = safeProjectRead(String(rel), 240_000);
        if (!projectText) return send(res, 404, { error: `project artifact not found or not readable: ${rel}` });
        body = projectText;
      }
      const source = {
        kind: String(kind || (rel ? "project-file" : body ? "artifact" : "spec")),
        uri: String(uri || (rel ? String(rel) : body ? "inline-artifact" : "SPEC.md")),
        title: String(title || (rel ? path.basename(String(rel)) : body ? "Inline knowledge artifact" : "Agape language specification")),
      };
      if (!body) {
        if (!fs.existsSync(SPEC_PATH)) return send(res, 404, { error: `SPEC.md not found at ${SPEC_PATH}` });
        body = fs.readFileSync(SPEC_PATH, "utf8");
      }
      const out = await getLearner(String(agent || DEFAULT_AGENT_ID)).ingest(body, Number(maxChunks) || 8, source);
      return send(res, 200, out);
    }

    if (req.method === "POST" && url === "/learn/step") {
      const { task, agent } = (await readJson(req)) || {};
      if (!task) return send(res, 400, { error: "task is required" });
      return send(res, 200, await getLearner(String(agent || DEFAULT_AGENT_ID)).step(String(task)));
    }

    if (req.method === "POST" && url === "/learn/context") {
      const { task, agent } = (await readJson(req)) || {};
      if (!task) return send(res, 400, { error: "task is required" });
      return send(res, 200, await getLearner(String(agent || DEFAULT_AGENT_ID)).codingContext(String(task)));
    }

    if (req.method === "GET" && url === "/learn/state") {
      return send(res, 200, getLearner(DEFAULT_AGENT_ID).state());
    }

    // Free read-only snapshot for the inspector (no cognition).
    if (req.method === "GET" && url === "/learn/inspect") {
      return send(res, 200, getLearner(DEFAULT_AGENT_ID).inspect());
    }

    if (req.method === "GET" && url === "/learn/recall") {
      const q = new URL(req.url || "", "http://x").searchParams.get("q") || "";
      return send(res, 200, { query: q, hits: await getLearner(DEFAULT_AGENT_ID).recall(q) });
    }

    // ── the Review studio ──
    if (req.method === "GET" && url === "/review/data") {
      return send(res, 200, await reviewData());
    }
    // Re-run the conformance suite only (no spec read) — backs the "Run tests" button.
    if (req.method === "GET" && url === "/review/run") {
      return send(res, 200, await reviewTests());
    }
    if (req.method === "POST" && url === "/review/spec-edit") {
      const { anchor, instruction, selection } = (await readJson(req)) || {};
      if (!selection || !instruction) return send(res, 400, { error: "selection and instruction are required" });
      const system =
        "You are editing the Agape language specification (SPEC.md), a precise formal document. " +
        "You receive a SELECTION (a contiguous span of the spec) and an INSTRUCTION. Return ONLY the " +
        "revised replacement text for that exact span — same Markdown style and indentation, no code " +
        "fences wrapping it, no commentary. Preserve section numbering, cross-references (§x.y), and the " +
        "terse precise voice. Make the minimal change that satisfies the instruction.";
      const user = `SELECTION (${anchor || "spec span"}):\n\n${selection}\n\n---\nINSTRUCTION:\n${instruction}`;
      const edited = await cognition().complete(system, [{ role: "user", content: user }], 2048);
      return send(res, 200, { edited });
    }
    if (req.method === "POST" && url === "/review/spec-save") {
      const { text } = (await readJson(req)) || {};
      if (typeof text !== "string" || text.length < 500) return send(res, 400, { error: "refusing to write a suspiciously short SPEC.md" });
      fs.writeFileSync(SPEC_PATH, text, "utf8");
      return send(res, 200, { ok: true, bytes: text.length });
    }
    // ── the live provider seam behind the runtime's `<-` ──
    // Plain text/line wire format so the zero-dep Rust runtime can call it.
    if (req.method === "POST" && url === "/provider/text") {
      const prompt = await readBody(req);
      const system = "You are an autonomous agent in a multi-agent system. Answer the request directly and concisely — at most one short paragraph. No preamble, no caveats.";
      const text = await cognition().complete(system, [{ role: "user", content: prompt }], 300);
      return sendText(res, 200, text || "(no answer)");
    }
    // The gate seam (§3): a `Credence` over the variant set. The grader's capability picks
    // the path — token logprobs (OpenAI) or the sampling fallback (Anthropic, §16.8). Backend
    // is AGENT_JUDGE_PROVIDER; `samples`/`temperature` are honored only by the sampling path.
    if (req.method === "POST" && url === "/provider/judge") {
      const raw = await readBody(req);
      const nl = raw.indexOf("\n"), nl2 = raw.indexOf("\n", nl + 1);
      const variants = raw.slice(0, nl).split(",").map((s) => s.trim()).filter(Boolean);
      const cfg = raw.slice(nl + 1, nl2).trim().split(/\s+/);
      const samples = Math.max(1, Math.min(50, parseInt(cfg[0], 10) || 5));
      const temperature = cfg[1] !== undefined && cfg[1] !== "" ? Math.max(0, Math.min(1, parseFloat(cfg[1]))) : undefined;
      const prompt = raw.slice(nl2 + 1);
      const dist = await grader().judge(prompt, variants, { samples, temperature });
      const lines = dist.map(([v, p]) => `${v} ${p.toFixed(4)}`);
      return sendText(res, 200, lines.join("\n"));
    }

    // ── the project studio (opened via `agape studio`) ──
    if (req.method === "GET" && url === "/project/info") {
      return send(res, 200, {
        hasProject: !!PROJECT,
        root: PROJECT || "",
        name: projectName(),
        manifest: projectManifest(),
        languageVersion: projectLanguageVersion(),
        runtime: runtimeSnapshot(),
        files: projectFiles(),
      });
    }
    if (req.method === "GET" && url === "/project/file") {
      const rel = new URL(req.url || "", "http://x").searchParams.get("rel") || "";
      const full = safeProjectPath(rel);
      if (!full || !fs.existsSync(full)) return send(res, 404, { error: "not a project .ag file" });
      return send(res, 200, { rel, body: fs.readFileSync(full, "utf8") });
    }
    if (req.method === "POST" && url === "/project/file") {
      const { rel, body } = (await readJson(req)) || {};
      const full = safeProjectPath(String(rel || ""));
      if (!full) return send(res, 400, { error: "path must be a .ag under the project root" });
      fs.writeFileSync(full, String(body ?? ""), "utf8");
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && url === "/project/run") {
      const body = (await readJson(req)) || {};
      const { rel, prompts, claude, live, cognitionProvider, judgeProvider, samples, temperature, openaiTopLogprobs, agent } = body;
      if (!rel) return send(res, 400, { error: "rel (a project .ag file) is required" });
      updateProviderConfig({
        ...(cognitionProvider === undefined ? {} : { cognitionProvider }),
        ...(judgeProvider === undefined ? {} : { judgeProvider }),
        samples,
        temperature,
        openaiTopLogprobs,
      });
      const out = await runProjectFile(String(rel), prompts || {}, !!(live ?? claude), Number(samples) || 0, Number(temperature) || 0);
      await recordAgentExperience(String(agent || DEFAULT_AGENT_ID), "project-run", String(rel), JSON.stringify(out).slice(0, 8000), { ok: !!out.ok, rel: String(rel) });
      return send(res, 200, out);
    }

    if (req.method === "POST" && url === "/review/test-save") {
      const { rel, body } = (await readJson(req)) || {};
      const full = path.resolve(REPO, String(rel || ""));
      if (!full.startsWith(TESTS_DIR) || !full.endsWith(".ag")) return send(res, 400, { error: "path must be a .ag under agape-conformance/tests/" });
      fs.writeFileSync(full, String(body ?? ""), "utf8");
      return send(res, 200, { ok: true });
    }

    // The built web app (bundle mode) — any unmatched GET falls through to here.
    if (req.method === "GET" && serveStatic(res, url)) return;

    return send(res, 404, { error: "not found" });
  } catch (e: any) {
    console.error("agent-server:", e?.message || e);
    return send(res, 502, { error: e?.message || "request failed" });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  const hasLiveKey = !!(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY);
  console.log(`agent-server on http://127.0.0.1:${PORT} · ${hasLiveKey ? `${providerConfig.cognitionProvider}/${providerConfig.judgeProvider}` : "mock (no API key)"}${WEB_DIST ? " · serving web app" : ""}`);
});
