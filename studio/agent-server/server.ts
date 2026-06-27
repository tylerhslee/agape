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
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("agent-server: ANTHROPIC_API_KEY not found (env or repo-root .env).");
  process.exit(1);
}

const cognition = new AnthropicCognition();

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
    learner = new Learner(mem, cognition, runner);
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
      return send(res, 200, { ok: true, model: cognition.model });
    }

    // ── pair / delegate ──
    if (req.method === "POST" && url === "/agent/respond") {
      const { item, thread, intent } = (await readJson(req)) || {};
      if (!item || !item.title) return send(res, 400, { error: "item.title is required" });
      const { system, messages } = buildMessages(item, Array.isArray(thread) ? thread : [], intent === "kickoff" ? "kickoff" : "respond");
      const text = await cognition.complete(system, messages, 1024);
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
      const edited = await cognition.complete(system, [{ role: "user", content: user }], 2048);
      return send(res, 200, { edited });
    }
    if (req.method === "POST" && url === "/review/spec-save") {
      const { text } = (await readJson(req)) || {};
      if (typeof text !== "string" || text.length < 500) return send(res, 400, { error: "refusing to write a suspiciously short SPEC.md" });
      fs.writeFileSync(SPEC_PATH, text, "utf8");
      return send(res, 200, { ok: true, bytes: text.length });
    }
    if (req.method === "POST" && url === "/review/test-save") {
      const { rel, body } = (await readJson(req)) || {};
      const full = path.resolve(REPO, String(rel || ""));
      if (!full.startsWith(TESTS_DIR) || !full.endsWith(".ag")) return send(res, 400, { error: "path must be a .ag under agape-conformance/tests/" });
      fs.writeFileSync(full, String(body ?? ""), "utf8");
      return send(res, 200, { ok: true });
    }

    return send(res, 404, { error: "not found" });
  } catch (e: any) {
    console.error("agent-server:", e?.message || e);
    return send(res, 502, { error: e?.message || "request failed" });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`agent-server on http://127.0.0.1:${PORT} · model ${cognition.model}`);
});
