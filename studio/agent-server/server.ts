// Agape Studio — agent server. The somatic stand-in for the studio's agentic layer:
//   /agent/* — pair/delegate with a builder agent (Claude today)
//   /learn/* — the Agape-learning loop over the spine + three-modality memory (§10)
// Replaced by the Agape + MCP backend behind the same seams. See RUNTIME.md.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { buildMessages } from "./agent.ts";
import { AnthropicCognition, HashingEmbedder } from "./provider.ts";
import { Memory } from "./memory.ts";
import { makeRunner } from "./runner.ts";
import { Learner } from "./learner.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pickVariant, agentsAndPrompts, safeProjectPath as resolveSafe } from "./lib.ts";
const pExecFile = promisify(execFile);

const PORT = Number(process.env.AGENT_PORT) || 8799;

// Find ANTHROPIC_API_KEY: env first, else walk up from cwd to the repo-root .env.
function loadApiKey(): void {
  if (process.env.ANTHROPIC_API_KEY) return;
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    const envPath = path.join(dir, ".env");
    if (fs.existsSync(envPath)) {
      for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
        const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
      if (process.env.ANTHROPIC_API_KEY) return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

loadApiKey();
const HAS_KEY = !!process.env.ANTHROPIC_API_KEY;
if (!HAS_KEY) {
  console.warn("agent-server: no ANTHROPIC_API_KEY — the deterministic mock + project studio work offline; live-model features (🧠 Claude) will error until a key is set.");
}

// Cognition is constructed lazily, so the studio starts and serves the mock
// provider + project with no API key; the live-model endpoints throw a friendly
// error if called without one.
let _cognition: AnthropicCognition | null = null;
function cognition(): AnthropicCognition {
  if (!_cognition) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set — this feature needs a live model (or use the deterministic mock).");
    _cognition = new AnthropicCognition();
  }
  return _cognition;
}

// The learning subsystem, lazily started (so /agent/* works even if better-sqlite3
// hasn't been built). Memory persists to data/agape.db; the runner uses agape-rs.
const HERE = process.cwd();
const AGAPE_RS = path.resolve(HERE, "..", "..", "agape-rs");
const SPEC_PATH = path.resolve(HERE, "..", "..", "SPEC.md");
let learner: Learner | null = null;
function getLearner(): Learner {
  if (!learner) {
    fs.mkdirSync(path.join(HERE, "data"), { recursive: true });
    const mem = new Memory(new HashingEmbedder(), path.join(HERE, "data", "agape.db"));
    const runner = makeRunner(AGAPE_RS);
    learner = new Learner(mem, cognition(), runner);
    console.log(`agent-server: learner ready · runner = ${runner.name}`);
  }
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
const REPO = path.resolve(HERE, "..", "..");
const TESTS_DIR = path.resolve(REPO, "agape-conformance", "tests");

// ── project: the user's own Agape project, opened via `agape studio` ──────────
// `AGAPE_PROJECT` is set by the CLI launcher; null ⇒ no project (Review only).
const PROJECT = process.env.AGAPE_PROJECT ? path.resolve(process.env.AGAPE_PROJECT) : null;
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

// Resolve a project-relative path, refusing anything that escapes the root (the
// guard itself lives in lib.ts so it can be unit-tested).
function safeProjectPath(rel: string): string | null {
  return PROJECT ? resolveSafe(PROJECT, rel) : null;
}

// Run one project file through the `agape` CLI (--json), feeding prompt inputs.
// `claude` routes the `<-` seam to the live provider (this same agent-server).
async function runProjectFile(rel: string, prompts: Record<string, string>, claude?: boolean, samples?: number, temperature?: number) {
  const full = safeProjectPath(rel);
  if (!full || !fs.existsSync(full)) return { ok: false, error: `no such file: ${rel}` };
  const args = ["run", full, "--json"];
  for (const [k, v] of Object.entries(prompts || {})) args.push("--prompt", `${k}=${v}`);
  if (claude) {
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
    const r = await pExecFile(bin, argv, { cwd, timeout: claude ? 180_000 : 60_000, maxBuffer: 20_000_000 });
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
      return send(res, 200, { ok: true, model: process.env.AGENT_MODEL || "claude-haiku-4-5", live: HAS_KEY });
    }

    // ── pair / delegate ──
    if (req.method === "POST" && url === "/agent/respond") {
      const { item, thread, intent } = (await readJson(req)) || {};
      if (!item || !item.title) return send(res, 400, { error: "item.title is required" });
      const { system, messages } = buildMessages(item, Array.isArray(thread) ? thread : [], intent === "kickoff" ? "kickoff" : "respond");
      const text = await cognition().complete(system, messages, 1024);
      return send(res, 200, { text: text || "(the agent had nothing to add)" });
    }

    // ── the learning loop ──
    if (req.method === "POST" && url === "/learn/ingest") {
      const { maxChunks } = (await readJson(req)) || {};
      if (!fs.existsSync(SPEC_PATH)) return send(res, 404, { error: `SPEC.md not found at ${SPEC_PATH}` });
      const spec = fs.readFileSync(SPEC_PATH, "utf8");
      const out = await getLearner().ingest(spec, Number(maxChunks) || 8);
      return send(res, 200, out);
    }

    if (req.method === "POST" && url === "/learn/step") {
      const { task } = (await readJson(req)) || {};
      if (!task) return send(res, 400, { error: "task is required" });
      return send(res, 200, await getLearner().step(String(task)));
    }

    if (req.method === "GET" && url === "/learn/state") {
      return send(res, 200, getLearner().state());
    }

    // Free read-only snapshot for the inspector (no cognition).
    if (req.method === "GET" && url === "/learn/inspect") {
      return send(res, 200, getLearner().inspect());
    }

    if (req.method === "GET" && url === "/learn/recall") {
      const q = new URL(req.url || "", "http://x").searchParams.get("q") || "";
      return send(res, 200, { query: q, hits: getLearner().recall(q) });
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
    // ── the live provider seam (a real Claude behind the runtime's `<-`) ──
    // Plain text/line wire format so the zero-dep Rust runtime can call it.
    if (req.method === "POST" && url === "/provider/text") {
      const prompt = await readBody(req);
      const system = "You are an autonomous agent in a multi-agent system. Answer the request directly and concisely — at most one short paragraph. No preamble, no caveats.";
      const text = await cognition().complete(system, [{ role: "user", content: prompt }], 300);
      return sendText(res, 200, text || "(no answer)");
    }
    // The sampling fallback (§16.8): a text-only model has no logprobs, so we force
    // a single-label choice `samples` times and return the empirical frequency.
    if (req.method === "POST" && url === "/provider/judge") {
      const raw = await readBody(req);
      const nl = raw.indexOf("\n"), nl2 = raw.indexOf("\n", nl + 1);
      const variants = raw.slice(0, nl).split(",").map((s) => s.trim()).filter(Boolean);
      // line 2 is `samples [temperature]` — the sampling fallback knobs (§16.8, §17).
      const cfg = raw.slice(nl + 1, nl2).trim().split(/\s+/);
      const samples = Math.max(1, Math.min(50, parseInt(cfg[0], 10) || 5));
      const temperature = cfg[1] !== undefined && cfg[1] !== "" ? Math.max(0, Math.min(1, parseFloat(cfg[1]))) : undefined;
      const prompt = raw.slice(nl2 + 1);
      const system = `You are a careful judge. Respond with EXACTLY ONE word — one of: ${variants.join(", ")}. No explanation, no punctuation.`;
      const draws = await Promise.all(
        Array.from({ length: samples }, () =>
          cognition().complete(system, [{ role: "user", content: prompt }], 8, temperature).then((t) => pickVariant(t, variants)).catch(() => null))
      );
      const counts: Record<string, number> = {};
      for (const v of variants) counts[v] = 0;
      let valid = 0;
      for (const d of draws) if (d) { counts[d]++; valid++; }
      const denom = valid || 1;
      const lines = variants.map((v) => `${v} ${(counts[v] / denom).toFixed(4)}`);
      return sendText(res, 200, lines.join("\n"));
    }

    // ── the project studio (opened via `agape studio`) ──
    if (req.method === "GET" && url === "/project/info") {
      return send(res, 200, { hasProject: !!PROJECT, root: PROJECT || "", name: projectName(), files: projectFiles() });
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
      const { rel, prompts, claude, samples, temperature } = (await readJson(req)) || {};
      if (!rel) return send(res, 400, { error: "rel (a project .ag file) is required" });
      return send(res, 200, await runProjectFile(String(rel), prompts || {}, !!claude, Number(samples) || 0, Number(temperature) || 0));
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
  console.log(`agent-server on http://127.0.0.1:${PORT} · ${HAS_KEY ? `model ${process.env.AGENT_MODEL || "claude-haiku-4-5"}` : "mock (no API key)"}${WEB_DIST ? " · serving web app" : ""}`);
});
