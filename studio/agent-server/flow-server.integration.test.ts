import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const AGAPE_TS = path.join(ROOT, "agape-ts");
const VERSION = JSON.parse(readFileSync(path.join(AGAPE_TS, "package.json"), "utf8")).version;
const CLI = path.join(AGAPE_TS, "src", "cli.ts");
const TSX = [path.join(AGAPE_TS, "node_modules", "tsx", "dist", "cli.mjs"), path.join(HERE, "node_modules", "tsx", "dist", "cli.mjs")].find(existsSync)!;
const PORT = 8911;
const base = `http://127.0.0.1:${PORT}`;
const source = `prompt text question;
enum Verdict { Accept, Reject }
action Reply(text answer);
action Audit();
action Admin();
event Ping();
event Pong();
agent FactChecker grants { perform Reply, perform Audit } {
  when (Ping e) { emit Pong(); }
  when (Pong e) { say("done"); }
  when (Prompt p about question) {
    Credence<Verdict> c = self <- f"check: \${p.text}";
    Decision<Verdict> d = decide c by confidence 0.5;
    if (d.committed == Accept) {
      Endorsement<text> e = endorse p.text by d;
      perform Reply(e);
    }
  }
}
spawn FactChecker checker;
awake checker;
`;

let server: ChildProcess;
let project: string;

beforeAll(async () => {
  project = mkdtempSync(path.join(tmpdir(), "agape-flow-it-"));
  mkdirSync(path.join(project, "nested"));
  writeFileSync(path.join(project, "agape.toml"), `[project]\nname = "Flow fixture"\nlanguage = "${VERSION}"\n`, "utf8");
  writeFileSync(path.join(project, "main.ag"), source, "utf8");
  server = spawn(process.execPath, [TSX, "server.ts"], { cwd: HERE, env: { ...process.env, AGENT_PORT: String(PORT), AGAPE_PROJECT: path.join(project, "nested"), AGENT_COGNITION_PROVIDER: "mock", AGENT_EMBEDDING_PROVIDER: "local", AGAPE_TS_CLI: CLI, TSX_CLI: TSX }, stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${base}/agent/health`)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("flow integration server did not start");
}, 30_000);

afterAll(() => server?.kill());

describe("Studio flow HTTP API", () => {
  it("loads, safely edits, rejects stale and malicious edits, and compile-checks before replacement", async () => {
    const loadedResponse = await fetch(`${base}/project/flow?rel=main.ag`);
    expect(loadedResponse.status).toBe(200);
    const loaded: any = await loadedResponse.json();
    const ids = new Set(loaded.nodes.map((node: any) => node.id));
    expect(loaded.edges.every((edge: any) => ids.has(edge.source) && ids.has(edge.target))).toBe(true);
    const model = loaded.nodes.find((node: any) => node.kind === "model");

    const savedResponse = await fetch(`${base}/project/flow?rel=main.ag`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: loaded.revision, changes: [{ nodeId: model.id, field: "instruction", value: "check carefully: ${p.text}" }] }) });
    expect(savedResponse.status).toBe(200);
    const saved: any = await savedResponse.json();
    expect(saved.revision).not.toBe(loaded.revision);
    expect(readFileSync(path.join(project, "main.ag"), "utf8")).toContain('f"check carefully: ${p.text}"');

    const stale = await fetch(`${base}/project/flow?rel=main.ag`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: loaded.revision, changes: [{ nodeId: model.id, field: "instruction", value: "stale" }] }) });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "stale_revision", currentRevision: saved.revision });

    const beforeRejected = readFileSync(path.join(project, "main.ag"), "utf8");
    const malicious = await fetch(`${base}/project/flow?rel=main.ag`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: saved.revision, changes: [{ nodeId: "../../secret", field: "instruction", value: "x" }] }) });
    expect(malicious.status).toBe(422);
    expect(await malicious.json()).toMatchObject({ code: "invalid_flow_edit", diagnostics: [expect.objectContaining({ code: "read_only_property" })] });
    expect(readFileSync(path.join(project, "main.ag"), "utf8")).toBe(beforeRejected);

    const decision = saved.nodes.find((node: any) => node.kind === "decision");
    for (const value of [null, true, false, "0.7"]) {
      const invalidNumber = await fetch(`${base}/project/flow?rel=main.ag`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: saved.revision, changes: [{ nodeId: decision.id, field: "threshold", value }] }) });
      expect(invalidNumber.status).toBe(422);
      const payload: any = await invalidNumber.json();
      expect(payload).toMatchObject({ code: "invalid_flow_edit", diagnostics: [expect.objectContaining({ code: "invalid_value", nodeId: decision.id, field: "threshold" })] });
      expect(readFileSync(path.join(project, "main.ag"), "utf8")).toBe(beforeRejected);
    }

    const invalidInterpolation = await fetch(`${base}/project/flow?rel=main.ag`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: saved.revision, changes: [{ nodeId: model.id, field: "instruction", value: "unterminated ${" }] }) });
    expect(invalidInterpolation.status).toBe(422);
    const interpolationPayload: any = await invalidInterpolation.json();
    expect(interpolationPayload).toMatchObject({ code: "invalid_flow_edit", diagnostics: [expect.objectContaining({ code: "invalid_value", nodeId: model.id, field: "instruction" })] });
    expect(interpolationPayload.diagnostics[0].message).toContain("Interpolation tokens must be preserved exactly");
    expect(readFileSync(path.join(project, "main.ag"), "utf8")).toBe(beforeRejected);

    const concurrentValues = ["first concurrent: ${p.text}", "second concurrent: ${p.text}"];
    const concurrentResponses = await Promise.all(concurrentValues.map((value) =>
      fetch(`${base}/project/flow?rel=main.ag`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ revision: saved.revision, changes: [{ nodeId: model.id, field: "instruction", value }] }),
      })
    ));
    expect(concurrentResponses.map((response) => response.status).sort()).toEqual([200, 409]);
    const winnerIndex = concurrentResponses.findIndex((response) => response.status === 200);
    const winner: any = await concurrentResponses[winnerIndex].json();
    const loser: any = await concurrentResponses[1 - winnerIndex].json();
    expect(loser).toMatchObject({ code: "stale_revision", currentRevision: winner.revision });
    const winnerValue = concurrentValues[winnerIndex];
    const expectedWinnerSource = beforeRejected.replace('f"check carefully: ${p.text}"', `f"${winnerValue}"`);
    expect(readFileSync(path.join(project, "main.ag"), "utf8")).toBe(expectedWinnerSource);
    expect(readdirSync(project).filter((name) => name.startsWith(".main.flow-") && name.endsWith(".ag"))).toEqual([]);

    const createdResponse = await fetch(`${base}/project/flow?rel=main.ag`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: winner.revision, patch: { op: "create_agent", name: "Reviewer" } }),
    });
    expect(createdResponse.status).toBe(200);
    const created: any = await createdResponse.json();
    expect(created.sourceDiff).toContain("+agent Reviewer {");
    expect(created.nodes.some((node: any) => node.id === "agent:Reviewer")).toBe(true);

    const reloaded: any = await (await fetch(`${base}/project/flow?rel=main.ag`)).json();
    expect(reloaded.revision).toBe(created.revision);
    expect(reloaded.nodes.some((node: any) => node.id === "agent:Reviewer")).toBe(true);

    const deletedResponse = await fetch(`${base}/project/flow?rel=main.ag`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: created.revision, patch: { op: "delete_agent", nodeId: "agent:Reviewer" } }),
    });
    expect(deletedResponse.status).toBe(200);
    const deleted: any = await deletedResponse.json();
    expect(deleted.nodes.some((node: any) => node.id === "agent:Reviewer")).toBe(false);

    const assertRejectedRollback = async (patch: any, expectedCode: string) => {
      const before = readFileSync(path.join(project, "main.ag"), "utf8");
      const response = await fetch(`${base}/project/flow?rel=main.ag`, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ revision: deleted.revision, patch }),
      });
      expect(response.status).toBe(422);
      const payload: any = await response.json();
      expect(payload).toMatchObject({ code: "invalid_structural_edit", diagnostics: [expect.objectContaining({ code: expectedCode })] });
      expect(readFileSync(path.join(project, "main.ag"), "utf8")).toBe(before);
      expect(readdirSync(project).filter((name) => name.startsWith(".main.flow-") && name.endsWith(".ag"))).toEqual([]);
    };

    await assertRejectedRollback({ op: "delete_agent", nodeId: "agent:Reviewer", changes: [] }, "invalid_structural_patch");
    await assertRejectedRollback({ op: "reorder_step", nodeId: "event:FactChecker:Pong", beforeNodeId: "action:FactChecker:Reply" }, "cross_context_reorder");
    await assertRejectedRollback({ op: "reconnect_handoff", nodeId: "action:FactChecker:Reply", target: "Audit" }, "incompatible_handoff_type");
    await assertRejectedRollback({ op: "add_handoff", contextNodeId: "agent:FactChecker", handoff: "action", target: "Admin" }, "structural_authority");
    await assertRejectedRollback({ op: "reconnect_handoff", nodeId: "event:FactChecker:Pong", target: "Ping" }, "structural_cycle");
  }, 15_000);
});
