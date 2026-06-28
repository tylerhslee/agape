// Integration tests: boot the real agent-server against a scaffolded project and
// drive the user journeys over HTTP. Deterministic — uses the mock provider, so no
// API key and byte-stable spines. Requires a built `agape` binary.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = ["target/release/agape", "target/debug/agape"]
  .map((p) => path.resolve(HERE, "..", "..", "agape-rs", p))
  .find((p) => existsSync(p));

const PORT = 8910;
const base = `http://127.0.0.1:${PORT}`;
const get = (p: string) => fetch(base + p);
const post = (p: string, body: unknown) =>
  fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

let srv: ChildProcess;
let proj: string;

beforeAll(async () => {
  if (!BIN) throw new Error("no agape binary — build it first (cargo build --bin agape)");
  proj = path.join(mkdtempSync(path.join(tmpdir(), "agape-it-")), "app");
  execFileSync(BIN, ["init", proj], { stdio: "ignore" });

  srv = spawn("npx", ["tsx", "server.ts"], {
    cwd: HERE,
    env: { ...process.env, AGENT_PORT: String(PORT), AGAPE_PROJECT: proj, AGAPE_BIN: BIN },
    stdio: "ignore",
  });
  for (let i = 0; i < 60; i++) {
    try { if ((await get("/agent/health")).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("agent-server did not come up");
}, 60_000);

afterAll(() => { srv?.kill(); });

describe("studio backend — user journeys (integration)", () => {
  it("serves health", async () => {
    expect((await (await get("/agent/health")).json()).ok).toBe(true);
  });

  it("lists the scaffolded project's agents and sensors", async () => {
    const d = await (await get("/project/info")).json();
    expect(d.hasProject).toBe(true);
    const main = d.files.find((f: any) => f.rel === "main.ag");
    expect(main.agents).toEqual(expect.arrayContaining(["Responder", "FactChecker"]));
    expect(main.prompts).toContain("question");
  });

  it("runs a program (mock) and delivers a verified answer", async () => {
    const d = await (await post("/project/run", { rel: "main.ag", prompts: { question: "hi" } })).json();
    expect(d.ok).toBe(true);
    const types = d.events.map((e: any) => e.etype);
    expect(types).toContain("Decided"); // the gate committed
    expect(types).toContain("Reply"); // ...and the verified answer was performed
  });

  it("reports a static rejection as ok:false, not a crash", async () => {
    // `perform` without the grant → AuthorityViolation at check time.
    await post("/project/file", {
      rel: "bad.ag",
      body: 'action A(text m);\nagent X { on awake { perform A("x"); } }\nspawn X x;\nawake x;\n',
    });
    const d = await (await post("/project/run", { rel: "bad.ag" })).json();
    expect(d.ok).toBe(false);
    expect(d.error || d.class).toBeTruthy();
  });

  it("refuses a path-traversal file read (security guard, end to end)", async () => {
    const r = await get("/project/file?rel=" + encodeURIComponent("../../../../etc/passwd.ag"));
    expect(r.ok).toBe(false); // 404/400 — never serves outside the project root
    // and the server is still alive afterward
    expect((await get("/agent/health")).ok).toBe(true);
  });
});
