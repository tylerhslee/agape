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
const sessionPost = (p: string, token: string, body: unknown) =>
  fetch(base + p, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });

const MAIN_SOURCE = `
prompt text question;
enum Verdict { Accept, Reject }
action Reply(text answer);

agent FactChecker {
  on awake { say("fact checker ready"); }
}

agent Responder grants { perform Reply } {
  when (Prompt p about question) {
    text answer = f"candidate answer: {p.text}";
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

const ATTESTATION_SOURCE = `
prompt text message;
principal reviewer;
enum Approval { Approve, Deny }
action ReplyAttested(text answer);

agent Assistant grants { perform ReplyAttested } {
  when (Prompt p about message) {
    text answer = self <- f"answer the user: {p.text}";
    Credence<Approval> c = self <- answer;
    Decision<Approval> d = reviewer decide c by conformal 0.1 readiness 10;
    if (d.committed == Approve) {
      Endorsement<text> e = endorse answer by d;
      perform ReplyAttested(e);
    }
  }
}

spawn Assistant assistant;
awake assistant;
`;

let srv: ChildProcess;
let proj: string;
let launchDir: string;

beforeAll(async () => {
  proj = path.join(mkdtempSync(path.join(tmpdir(), "agape-it-")), "app");
  launchDir = path.join(proj, "src", "nested");
  mkdirSync(launchDir, { recursive: true });
  writeFileSync(path.join(proj, "agape.toml"), `[project]\nname = "Integration Fixture"\nlanguage = "1.0.0-beta.2026.8.6.0"\n\n[memory]\ndriver = "markdown"\npath = ".agape/memory"\n\n[security.attesters.reviewer]\ndriver = "host"\n`, "utf8");
  writeFileSync(path.join(proj, "main.ag"), MAIN_SOURCE, "utf8");
  writeFileSync(path.join(proj, "attestation.ag"), ATTESTATION_SOURCE, "utf8");

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

  it("runs a one-shot program with a runtime endorsement and action", async () => {
    const d = await (await post("/project/run", { rel: "main.ag", prompts: { question: "hi" } })).json();
    expect(d.ok).toBe(true);
    const types = d.events.map((e: any) => e.etype);
    expect(types).toContain("Endorsed");
    expect(types).toContain("Reply");
  });

  it("pauses and resumes the same runtime session through an authenticated principal ruling", async () => {
    const hostileOrigin = await fetch(base + "/runtime/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ rel: "attestation.ag" }),
    });
    expect(hostileOrigin.status).toBe(403);
    expect((await hostileOrigin.json()).code).toBe("untrusted_origin");

    const createdResponse = await post("/runtime/sessions", {
      rel: "attestation.ag",
      conversationId: "conversation-integration",
    });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json();
    expect(created).toMatchObject({ state: "ready", conversationId: "conversation-integration" });
    expect(created.accessToken).toEqual(expect.any(String));

    const pendingResponse = await sessionPost(`/runtime/sessions/${created.sessionId}/prompts`, created.accessToken, {
      name: "message",
      value: "hello",
    });
    expect(pendingResponse.status).toBe(200);
    const pending = await pendingResponse.json();
    expect(pending).toMatchObject({
      sessionId: created.sessionId,
      sessionLineageId: created.sessionLineageId,
      conversationId: created.conversationId,
      state: "pending-ruling",
      pending: { principal: "reviewer", enumName: "Approval" },
    });
    expect(pending.ledger.at(-1).etype).toBe("PendingPrincipalDecision");
    expect(pending.certificates).toEqual([]);

    const wrongPrincipal = await sessionPost(`/runtime/sessions/${created.sessionId}/rulings`, created.accessToken, {
      requestId: pending.pending.requestId,
      principal: "somebody-else",
      outcome: "approve",
    });
    expect(wrongPrincipal.status).toBe(403);
    expect((await wrongPrincipal.json()).code).toBe("wrong_principal");

    const wrongCapability = await sessionPost(`/runtime/sessions/${created.sessionId}/rulings`, "wrong", {
      requestId: pending.pending.requestId,
      principal: "reviewer",
      outcome: "approve",
    });
    expect(wrongCapability.status).toBe(401);

    const resumedResponse = await sessionPost(`/runtime/sessions/${created.sessionId}/rulings`, created.accessToken, {
      requestId: pending.pending.requestId,
      principal: "reviewer",
      outcome: "approve",
    });
    expect(resumedResponse.status).toBe(200);
    const resumed = await resumedResponse.json();
    expect(resumed.state).toBe("ready");
    expect(resumed.ledger.map((event: any) => event.etype)).toEqual(expect.arrayContaining([
      "PendingPrincipalDecision", "PrincipalDecision", "Decided", "Endorsed", "ReplyAttested",
    ]));
    expect(resumed.certificates).toHaveLength(1);
    expect(resumed.certificates[0]).toMatchObject({
      kind: "agape.action-authorization-certificate.v1",
      sessionId: created.sessionId,
      ledgerHead: resumed.ledgerHead,
      basis: "Principal",
      principalAttestationVerified: true,
    });

    const unauthorizedEvidence = await sessionPost(`/runtime/sessions/${created.sessionId}/evidence`, "wrong", {
      evidenceRef: "protected:evidence:v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      decisionId: resumed.certificates[0].decisionTick,
    });
    expect(unauthorizedEvidence.status).toBe(401);
    expect((await unauthorizedEvidence.json()).code).toBe("invalid_session_capability");

    const mismatchedEvidence = await sessionPost(`/runtime/sessions/${created.sessionId}/evidence`, created.accessToken, {
      evidenceRef: "protected:evidence:v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      decisionId: resumed.certificates[0].decisionTick,
    });
    expect(mismatchedEvidence.status).toBe(409);
    expect((await mismatchedEvidence.json()).code).toBe("evidence_mismatch");

    const malformedEvidence = await sessionPost(`/runtime/sessions/${created.sessionId}/evidence`, created.accessToken, {
      evidenceRef: "",
      decisionId: -1,
    });
    expect(malformedEvidence.status).toBe(400);
    expect((await malformedEvidence.json()).code).toBe("invalid_evidence_request");

    const duplicate = await sessionPost(`/runtime/sessions/${created.sessionId}/rulings`, created.accessToken, {
      requestId: pending.pending.requestId,
      principal: "reviewer",
      outcome: "approve",
    });
    expect(duplicate.status).toBe(409);
    expect((await duplicate.json()).code).toBe("duplicate_ruling");
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