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

    return send(res, 404, { error: "not found" });
  } catch (e: any) {
    console.error("agent-server:", e?.message || e);
    return send(res, 502, { error: e?.message || "request failed" });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`agent-server on http://127.0.0.1:${PORT} · model ${cognition.model}`);
});
