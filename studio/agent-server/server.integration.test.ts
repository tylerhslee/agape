// Integration tests: boot the real agent-server against a scaffolded TypeScript Agape project and
// drive the user journeys over HTTP. Deterministic: uses the mock provider, so no API key and
// byte-stable spines.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGAPE_ROOT =
  [
    path.resolve(HERE, "..", ".."),
    path.resolve(HERE, "..", "..", "agape"),
  ].find((p) => existsSync(path.join(p, "agape-ts"))) || path.resolve(HERE, "..", "..");
const AGAPE_TS = path.join(AGAPE_ROOT, "agape-ts");
const AGAPE_TS_CLI = path.join(AGAPE_TS, "src", "cli.ts");
const TSX_BIN = [
  path.join(AGAPE_TS, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx"),
  path.join(AGAPE_TS, "node_modules", ".bin", "tsx"),
].find((p) => existsSync(p)) || path.join(AGAPE_TS, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
const STUDIO_TSX_CLI = [
  path.join(AGAPE_TS, "node_modules", "tsx", "dist", "cli.mjs"),
  path.join(HERE, "node_modules", "tsx", "dist", "cli.mjs"),
].find((p) => existsSync(p)) || path.join(HERE, "node_modules", "tsx", "dist", "cli.mjs");

const PORT = 8910;
const base = `http://127.0.0.1:${PORT}`;
const get = (p: string) => fetch(base + p);
const post = (p: string, body: unknown) =>
  fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const MAIN_SOURCE = `
prompt text question;
enum Verdict { Accept, Reject }
action Reply(text answer);

agent FactChecker {
  on awake { say("fact checker ready"); }
}

agent Responder grants { perform Reply } {
  when (Prompt p about question) {
    text answer = f"verified answer: {p.text}";
    Credence<Verdict> c = self <- f"is this answer safe to send: {answer}";
    Decision<Verdict> d = decide c by confidence 0.5;
    if (d.committed == Accept) {
      Endorsement<text> e = endorse answer by d;
      perform Reply(e);
    }
  }
}

spawn FactChecker checker;
spawn Responder responder;
awake checker;
awake responder;
`;

let srv: ChildProcess;
let proj: string;
let launchDir: string;

beforeAll(async () => {
  proj = path.join(mkdtempSync(path.join(tmpdir(), "agape-it-")), "app");
  launchDir = path.join(proj, "src", "nested");
  mkdirSync(launchDir, { recursive: true });
  writeFileSync(path.join(proj, "agape.toml"), `[project]\nname = "Integration Fixture"\nlanguage = "1.0.0-beta.2026.7.14.1"\n\n[memory]\ndriver = "markdown"\npath = ".agape/memory"\n`, "utf8");
  writeFileSync(path.join(proj, "main.ag"), MAIN_SOURCE, "utf8");

  srv = spawn(process.execPath, [STUDIO_TSX_CLI, "server.ts"], {
    cwd: HERE,
    env: {
      ...process.env,
      AGENT_PORT: String(PORT),
      AGAPE_PROJECT: launchDir,
      AGENT_COGNITION_PROVIDER: "mock",
      AGENT_EMBEDDING_PROVIDER: "local",
      AGAPE_TS_CLI,
      TSX_BIN,
      TSX_CLI: STUDIO_TSX_CLI,
    },
    stdio: "ignore",
  });
  for (let i = 0; i < 60; i++) {
    try { if ((await get("/agent/health")).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("agent-server did not come up");
}, 60_000);

afterAll(() => { srv?.kill(); });

describe("studio backend - user journeys (integration)", () => {
  it("serves health", async () => {
    expect((await (await get("/agent/health")).json()).ok).toBe(true);
  });

  it("lists the scaffolded project's agents and sensors", async () => {
    const d = await (await get("/project/info")).json();
    expect(d.hasProject).toBe(true);
    expect(path.resolve(d.root)).toBe(path.resolve(proj));
    expect(d.runtime.mode).toBe("local");
    expect(d.languageVersion).toBeTruthy();
    const main = d.files.find((f: any) => f.rel === "main.ag");
    expect(main.agents).toEqual(expect.arrayContaining(["Responder", "FactChecker"]));
    expect(main.prompts).toContain("question");
  });

  it("routes a project-overview prompt to inspect even when the Build badge is selected", async () => {
    const d = await (await post("/agent/respond", {
      item: {
        title: "can you tell me what is in this project so far?",
        destination: "Build - next best work",
        status: "active",
      },
      thread: [{ who: "you", text: "can you tell me what is in this project so far?" }],
      intent: "build",
    })).json();

    expect(d.intent).toBe("inspect");
    expect(d.source).toBe("project-context");
    expect(d.text).toContain("Here is what is in");
    expect(d.text).toContain("main.ag");
    expect(d.text).toContain("Responder");
    expect(d.text).toContain("FactChecker");
    expect(d.text).not.toMatch(/retriev|please hold|one moment/i);
  });

  it("configures runtime deployment independently of the project", async () => {
    const before = await (await get("/runtime/config")).json();
    expect(before.mode).toBe("local");
    const after = await (await post("/runtime/config", {
      mode: "cloud",
      label: "Soma staging",
      endpoint: "https://soma.example/agape",
      version: "2026.6",
    })).json();
    expect(after).toMatchObject({
      mode: "cloud",
      label: "Soma staging",
      endpoint: "https://soma.example/agape",
      version: "2026.6",
      connected: true,
    });
  });

  it("runs a program (mock) and delivers a verified answer", async () => {
    const d = await (await post("/project/run", { rel: "main.ag", prompts: { question: "hi" } })).json();
    expect(d.ok).toBe(true);
    const types = d.events.map((e: any) => e.etype);
    expect(types).toContain("Endorsed");
    expect(types).toContain("Reply");
  });

  it("reports a static rejection as ok:false, not a crash", async () => {
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
    expect(r.ok).toBe(false);
    expect((await get("/agent/health")).ok).toBe(true);
  });
});