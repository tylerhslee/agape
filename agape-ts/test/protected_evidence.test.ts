import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  FileProtectedEvidenceStore,
  ProtectedEvidenceError,
  type JudgmentEvidence,
  type ProtectedEvidenceRequest,
} from "../src/protected_evidence.js";

const KEY = Buffer.alloc(32, 0x5a);
const CRASH_HELPER = fileURLToPath(new URL("./fixtures/protected_evidence_crash_helper.ts", import.meta.url));
const TSX_CLI = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));

interface CrashHelperConfig {
  mode: "delete-crash" | "inspect";
  root: string;
  keyHex: string;
  principal: string;
  request: ProtectedEvidenceRequest;
}

function runCrashHelper(config: CrashHelperConfig): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TSX_CLI, CRASH_HELPER], {
      env: { ...process.env, AGAPE_P16_CRASH_HELPER: Buffer.from(JSON.stringify(config)).toString("base64url") },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stderr }));
  });
}

function evidence(): JudgmentEvidence {
  return {
    version: 1,
    method: "bounded-complete-sequence-logprobs",
    connector: "openai-chat-completions",
    enum_name: "Verdict",
    enum_variants: ["Approve", "Reject"],
    candidate_bound: 3,
    candidates: [
      {
        content: "Approve",
        variant: "Approve",
        tokens: [
          { token: "App", logprob: Math.log(0.9), bytes: [65, 112, 112] },
          { token: "rove", logprob: Math.log(0.51), bytes: [114, 111, 118, 101] },
        ],
        aggregate_logprob: Math.log(0.9) + Math.log(0.51),
        aggregate_score: 0.9 * 0.51,
        finish_reason: "stop",
      },
      {
        content: "Reject",
        variant: "Reject",
        tokens: [
          { token: "Rej", logprob: Math.log(0.9), bytes: [82, 101, 106] },
          { token: "ect", logprob: Math.log(0.49), bytes: [101, 99, 116] },
        ],
        aggregate_logprob: Math.log(0.9) + Math.log(0.49),
        aggregate_score: 0.9 * 0.49,
        finish_reason: "stop",
      },
      {
        content: "unknown",
        variant: null,
        tokens: [{ token: "unknown", logprob: Math.log(0.1), bytes: null }],
        aggregate_logprob: Math.log(0.1),
        aggregate_score: 0.1,
        finish_reason: "stop",
      },
    ],
    mapping_version: "exact-enum-v1",
    normalization_version: "matched-sequence-mass-v1",
    gate_scores: { Approve: 0.51, Reject: 0.49 },
  };
}

describe("principal-bound protected JudgmentEvidence", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  async function open(
    principal = "principal:reviewer",
    now?: () => number,
    afterDeletionMarker?: () => void | Promise<void>,
    beforeInspectionFinalCheck?: () => void | Promise<void>,
  ) {
    root ??= await mkdtemp(join(tmpdir(), "agape-protected-evidence-"));
    return FileProtectedEvidenceStore.open({
      root,
      key: KEY,
      authenticatedPrincipal: principal,
      ...(now ? { now } : {}),
      ...(afterDeletionMarker ? { afterDeletionMarker } : {}),
      ...(beforeInspectionFinalCheck ? { beforeInspectionFinalCheck } : {}),
    });
  }

  it("keeps exact multi-token candidates encrypted while exposing only immutable linkage", async () => {
    const store = await open();
    const exact = evidence();
    const link = await store.retain({
      evidence: exact,
      ownerPrincipal: "principal:reviewer",
      scope: "project:demo/run:1/judgment:4",
    });
    await store.bindDecision(link.evidence_ref, {
      decision_id: 8,
      winner: "Approve",
      runner_up: "Reject",
      threshold: 0.5,
      required_margin: 0.03,
      floor: 0.015,
      actual_margin: 0.02,
      passed: false,
    });

    expect(link).toMatchObject({
      evidence_id: expect.any(String),
      evidence_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      evidence_ref: expect.stringMatching(/^protected:evidence:v1:/),
    });
    const files = store.artifactPaths(link.evidence_ref);
    const bytes = await readFile(files.evidence);
    expect(bytes.toString("utf8")).not.toContain("Approve");
    expect(bytes.toString("utf8")).not.toContain("App");
    expect(bytes.toString("utf8")).not.toContain(JSON.stringify(exact.candidates[0]!.tokens[0]!.logprob));

    const authorization = store.issueAuthorization({
      requester: "principal:reviewer",
      operation: "inspect",
      evidence_ref: link.evidence_ref,
      decision_id: 8,
    });
    await expect(store.inspect({
      requester: "principal:reviewer",
      authorization,
      evidence_ref: link.evidence_ref,
      decision_id: 8,
    })).resolves.toMatchObject({
      ...exact,
      evidence_id: link.evidence_id,
      evidence_hash: link.evidence_hash,
      evidence_ref: link.evidence_ref,
      decision_id: 8,
      winner: "Approve",
      runner_up: "Reject",
      threshold: 0.5,
      required_margin: 0.03,
      floor: 0.015,
      actual_margin: 0.02,
      passed: false,
    });
  });

  it("fails closed for a different principal, operation, decision, reference, or tampered token", async () => {
    const store = await open();
    const link = await store.retain({ evidence: evidence(), ownerPrincipal: "principal:reviewer", scope: "scope:a" });
    await store.bindDecision(link.evidence_ref, {
      decision_id: 7, winner: "Approve", runner_up: "Reject", threshold: 0.5,
      required_margin: 0.03, floor: 0.015, actual_margin: 0.02, passed: false,
    });
    const authorization = store.issueAuthorization({
      requester: "principal:reviewer", operation: "inspect",
      evidence_ref: link.evidence_ref, decision_id: 7,
    });
    const request = { requester: "principal:reviewer", authorization, evidence_ref: link.evidence_ref, decision_id: 7 };

    await expect(store.inspect({ ...request, requester: "principal:other" }))
      .rejects.toMatchObject({ code: "Forbidden" });
    await expect(store.export({ ...request }))
      .rejects.toMatchObject({ code: "Forbidden" });
    await expect(store.inspect({ ...request, decision_id: 8 }))
      .rejects.toMatchObject({ code: "Forbidden" });
    const mismatchedAuthorization = store.issueAuthorization({
      requester: "principal:reviewer", operation: "inspect",
      evidence_ref: link.evidence_ref, decision_id: 8,
    });
    await expect(store.inspect({ ...request, authorization: mismatchedAuthorization, decision_id: 8 }))
      .rejects.toMatchObject({ code: "EvidenceMismatch" });
    await expect(store.inspect({ ...request, evidence_ref: link.evidence_ref + "x" }))
      .rejects.toMatchObject({ code: "Forbidden" });
    await expect(store.inspect({ ...request, authorization: authorization.slice(0, -1) + "x" }))
      .rejects.toBeInstanceOf(ProtectedEvidenceError);
    await expect(store.authorize({
      requester: "principal:reviewer", operation: "delete",
      evidence_ref: link.evidence_ref, decision_id: 8,
    })).rejects.toMatchObject({ code: "EvidenceMismatch" });

    const otherStore = await open("principal:other");
    expect(() => otherStore.issueAuthorization({
      requester: "principal:reviewer", operation: "inspect",
      evidence_ref: link.evidence_ref, decision_id: 7,
    })).toThrowError(/authenticated principal/i);
  });

  it("retains across fresh processes, exports a tamper-evident exact bundle, and deletes explicitly", async () => {
    const live = await open();
    const link = await live.retain({ evidence: evidence(), ownerPrincipal: "principal:reviewer", scope: "scope:durable" });
    await live.bindDecision(link.evidence_ref, {
      decision_id: 11, winner: "Approve", runner_up: "Reject", threshold: 0.5,
      required_margin: 0.03, floor: 0.015, actual_margin: 0.02, passed: false,
    });
    await live.close();

    const restarted = await open();
    const inspect = restarted.issueAuthorization({
      requester: "principal:reviewer", operation: "inspect",
      evidence_ref: link.evidence_ref, decision_id: 11,
    });
    await expect(restarted.inspect({
      requester: "principal:reviewer", authorization: inspect,
      evidence_ref: link.evidence_ref, decision_id: 11,
    })).resolves.toMatchObject({ candidates: evidence().candidates });

    const exportAuthorization = restarted.issueAuthorization({
      requester: "principal:reviewer", operation: "export",
      evidence_ref: link.evidence_ref, decision_id: 11,
    });
    const exported = await restarted.export({
      requester: "principal:reviewer", authorization: exportAuthorization,
      evidence_ref: link.evidence_ref, decision_id: 11,
    });
    expect(exported).toMatchObject({
      kind: "agape-protected-evidence-export",
      version: 1,
      requester: "principal:reviewer",
      evidence: { candidates: evidence().candidates },
      proof: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(restarted.verifyExport(exported)).toBe(true);
    expect(restarted.verifyExport({ ...exported, requester: "principal:other" })).toBe(false);

    const deleteAuthorization = restarted.issueAuthorization({
      requester: "principal:reviewer", operation: "delete",
      evidence_ref: link.evidence_ref, decision_id: 11,
    });
    await restarted.delete({
      requester: "principal:reviewer", authorization: deleteAuthorization,
      evidence_ref: link.evidence_ref, decision_id: 11,
    });
    await expect(restarted.inspect({
      requester: "principal:reviewer", authorization: inspect,
      evidence_ref: link.evidence_ref, decision_id: 11,
    })).rejects.toMatchObject({ code: "EvidenceUnavailable" });
    await restarted.close();

    const otherPrincipal = await open("principal:other");
    await otherPrincipal.close();
    const afterRestart = await open();
    await expect(afterRestart.retain({
      evidence: evidence(),
      ownerPrincipal: "principal:reviewer",
      scope: "scope:durable",
    })).rejects.toMatchObject({ code: "EvidenceUnavailable" });
  });

  it("expires operation capabilities without consulting the addressed artifact", async () => {
    let now = 1_000;
    const store = await open("principal:reviewer", () => now);
    const link = await store.retain({ evidence: evidence(), ownerPrincipal: "principal:reviewer", scope: "scope:expiry" });
    await store.bindDecision(link.evidence_ref, {
      decision_id: 12, winner: "Approve", runner_up: "Reject", threshold: 0.5,
      required_margin: 0.03, floor: 0.015, actual_margin: 0.02, passed: false,
    });
    const authorization = await store.authorize({
      requester: "principal:reviewer", operation: "inspect",
      evidence_ref: link.evidence_ref, decision_id: 12, expires_at: 1_001,
    });
    now = 1_002;
    await expect(store.inspect({
      requester: "principal:reviewer", authorization,
      evidence_ref: link.evidence_ref + "x", decision_id: 12,
    })).rejects.toMatchObject({ code: "Forbidden" });
  });

  it("recovers an abrupt delete crash with two concurrent process contenders", async () => {
    const live = await open();
    const link = await live.retain({ evidence: evidence(), ownerPrincipal: "principal:reviewer", scope: "scope:process-crash" });
    await live.bindDecision(link.evidence_ref, {
      decision_id: 13, winner: "Approve", runner_up: "Reject", threshold: 0.5,
      required_margin: 0.03, floor: 0.015, actual_margin: 0.02, passed: false,
    });
    const deleteAuthorization = await live.authorize({
      requester: "principal:reviewer", operation: "delete",
      evidence_ref: link.evidence_ref, decision_id: 13,
    });
    const inspectAuthorization = await live.authorize({
      requester: "principal:reviewer", operation: "inspect",
      evidence_ref: link.evidence_ref, decision_id: 13,
    });
    await live.close();
    const base = { root: root!, keyHex: KEY.toString("hex"), principal: "principal:reviewer" };
    const crash = await runCrashHelper({
      ...base, mode: "delete-crash",
      request: { requester: "principal:reviewer", authorization: deleteAuthorization, evidence_ref: link.evidence_ref, decision_id: 13 },
    });
    expect(crash, crash.stderr).toMatchObject({ code: 86 });

    const inspectRequest = { requester: "principal:reviewer", authorization: inspectAuthorization, evidence_ref: link.evidence_ref, decision_id: 13 };
    const contenders = await Promise.all([
      runCrashHelper({ ...base, mode: "inspect", request: inspectRequest }),
      runCrashHelper({ ...base, mode: "inspect", request: inspectRequest }),
    ]);
    for (const contender of contenders) expect(contender, contender.stderr).toMatchObject({ code: 0 });

    const restarted = await open();
    await expect(restarted.retain({
      evidence: evidence(), ownerPrincipal: "principal:reviewer", scope: "scope:process-crash",
    })).rejects.toMatchObject({ code: "EvidenceUnavailable" });
  });

  it("serializes concurrent export, retain, and delete across store instances", async () => {
    const first = await open();
    const second = await open();
    const link = await first.retain({ evidence: evidence(), ownerPrincipal: "principal:reviewer", scope: "scope:race" });
    await first.bindDecision(link.evidence_ref, {
      decision_id: 14, winner: "Approve", runner_up: "Reject", threshold: 0.5,
      required_margin: 0.03, floor: 0.015, actual_margin: 0.02, passed: false,
    });
    const exportAuthorization = await first.authorize({
      requester: "principal:reviewer", operation: "export",
      evidence_ref: link.evidence_ref, decision_id: 14,
    });
    const deleteAuthorization = await first.authorize({
      requester: "principal:reviewer", operation: "delete",
      evidence_ref: link.evidence_ref, decision_id: 14,
    });
    const request = { requester: "principal:reviewer", evidence_ref: link.evidence_ref, decision_id: 14 };
    const [exported, retained, deleted] = await Promise.allSettled([
      first.export({ ...request, authorization: exportAuthorization }),
      second.retain({ evidence: evidence(), ownerPrincipal: "principal:reviewer", scope: "scope:race" }),
      second.delete({ ...request, authorization: deleteAuthorization }),
    ]);
    expect(deleted.status).toBe("fulfilled");
    expect(["fulfilled", "rejected"]).toContain(exported.status);
    expect(["fulfilled", "rejected"]).toContain(retained.status);
    const restarted = await open();
    await expect(restarted.retain({
      evidence: evidence(), ownerPrincipal: "principal:reviewer", scope: "scope:race",
    })).rejects.toMatchObject({ code: "EvidenceUnavailable" });
  });

  it("rejects an inspection whose final marker check follows concurrent deletion", async () => {
    const owner = await open();
    const link = await owner.retain({ evidence: evidence(), ownerPrincipal: "principal:reviewer", scope: "scope:inspect-race" });
    await owner.bindDecision(link.evidence_ref, {
      decision_id: 18, winner: "Approve", runner_up: "Reject", threshold: 0.5,
      required_margin: 0.03, floor: 0.015, actual_margin: 0.02, passed: false,
    });
    const inspectAuthorization = await owner.authorize({ requester: "principal:reviewer", operation: "inspect", evidence_ref: link.evidence_ref, decision_id: 18 });
    const deleteAuthorization = await owner.authorize({ requester: "principal:reviewer", operation: "delete", evidence_ref: link.evidence_ref, decision_id: 18 });
    const paths = owner.artifactPaths(link.evidence_ref);
    let inspectionBuilt!: () => void;
    const built = new Promise<void>((resolve) => { inspectionBuilt = resolve; });
    let finishInspection!: () => void;
    const finish = new Promise<void>((resolve) => { finishInspection = resolve; });
    const inspector = await open("principal:reviewer", undefined, undefined, async () => {
      inspectionBuilt();
      await finish;
    });
    const pending = inspector.inspect({ requester: "principal:reviewer", authorization: inspectAuthorization, evidence_ref: link.evidence_ref, decision_id: 18 });
    await built;
    await owner.delete({ requester: "principal:reviewer", authorization: deleteAuthorization, evidence_ref: link.evidence_ref, decision_id: 18 });
    await expect(readFile(paths.evidence)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(paths.binding)).rejects.toMatchObject({ code: "ENOENT" });
    finishInspection();
    await expect(pending).rejects.toMatchObject({ code: "EvidenceUnavailable" });
  });

  it("gives another authenticated principal no cross-namespace existence oracle", async () => {
    const owner = await open();
    const link = await owner.retain({ evidence: evidence(), ownerPrincipal: "principal:reviewer", scope: "scope:opaque" });
    await owner.bindDecision(link.evidence_ref, {
      decision_id: 15, winner: "Approve", runner_up: "Reject", threshold: 0.5,
      required_margin: 0.03, floor: 0.015, actual_margin: 0.02, passed: false,
    });
    const other = await open("principal:other");
    const query = (ref: string) => other.authorize({
      requester: "principal:other", operation: "inspect", evidence_ref: ref, decision_id: 15,
    });
    await expect(query(link.evidence_ref)).rejects.toMatchObject({ code: "EvidenceUnavailable" });
    await expect(query("protected:evidence:v1:" + "A".repeat(43)))
      .rejects.toMatchObject({ code: "EvidenceUnavailable" });
    const deletion = await owner.authorize({
      requester: "principal:reviewer", operation: "delete",
      evidence_ref: link.evidence_ref, decision_id: 15,
    });
    await owner.delete({
      requester: "principal:reviewer", authorization: deletion,
      evidence_ref: link.evidence_ref, decision_id: 15,
    });
    await expect(query(link.evidence_ref)).rejects.toMatchObject({ code: "EvidenceUnavailable" });
  });


  it("validates exact connector evidence instead of accepting invented or incomplete sequences", async () => {
    const store = await open();
    const incomplete = evidence();
    incomplete.candidates[0]!.aggregate_logprob += 0.1;
    await expect(store.retain({ evidence: incomplete, ownerPrincipal: "principal:reviewer", scope: "scope:bad" }))
      .rejects.toThrowError(/aggregate_logprob/i);

    const badScores = evidence();
    badScores.gate_scores = { Approve: 0.9, Reject: 0.1 };
    await expect(store.retain({ evidence: badScores, ownerPrincipal: "principal:reviewer", scope: "scope:bad-score" }))
      .rejects.toThrowError(/gate_scores/i);

    const extraScore = evidence();
    extraScore.gate_scores = { Approve: 0.51, Reject: 0.49, Invented: 0 };
    await expect(store.retain({ evidence: extraScore, ownerPrincipal: "principal:reviewer", scope: "scope:extra-score" }))
      .rejects.toThrowError(/exactly equal enum_variants/i);

    const omittedVariant = evidence();
    omittedVariant.enum_variants = ["Approve", "Reject", "Abstain"];
    await expect(store.retain({ evidence: omittedVariant, ownerPrincipal: "principal:reviewer", scope: "scope:omitted-variant" }))
      .rejects.toThrowError(/exactly equal enum_variants/i);

    const inconsistentBinding = await store.retain({ evidence: evidence(), ownerPrincipal: "principal:reviewer", scope: "scope:bad-binding" });
    await expect(store.bindDecision(inconsistentBinding.evidence_ref, {
      decision_id: 9, winner: "Approve", runner_up: "Reject", threshold: 0.5,
      required_margin: 0.03, floor: 0.015, actual_margin: 0.5, passed: true,
    })).rejects.toThrowError(/arithmetic/i);

    const zeroVariant = evidence();
    zeroVariant.candidates[1] = {
      content: "{\"value\":\"Approve\"}", variant: "Approve",
      tokens: [
        { token: "{\"value\":\"App", logprob: Math.log(0.9), bytes: null },
        { token: "rove\"}", logprob: Math.log(0.49), bytes: null },
      ],
      aggregate_logprob: Math.log(0.9) + Math.log(0.49),
      aggregate_score: 0.9 * 0.49,
      finish_reason: "stop",
    };
    zeroVariant.gate_scores = { Approve: 1, Reject: 0 };
    await expect(store.retain({ evidence: zeroVariant, ownerPrincipal: "principal:reviewer", scope: "scope:zero-variant" }))
      .resolves.toMatchObject({ gate_scores: { Approve: 1, Reject: 0 } });

    const tied = evidence();
    tied.candidates[0] = {
      content: "Approve", variant: "Approve", tokens: [{ token: "Approve", logprob: Math.log(0.45), bytes: null }],
      aggregate_logprob: Math.log(0.45), aggregate_score: 0.45, finish_reason: "stop",
    };
    tied.candidates[1] = {
      content: "Reject", variant: "Reject", tokens: [{ token: "Reject", logprob: Math.log(0.45), bytes: null }],
      aggregate_logprob: Math.log(0.45), aggregate_score: 0.45, finish_reason: "stop",
    };
    tied.gate_scores = { Approve: 0.5, Reject: 0.5 };
    const tiedLink = await store.retain({ evidence: tied, ownerPrincipal: "principal:reviewer", scope: "scope:tie" });
    await expect(store.bindDecision(tiedLink.evidence_ref, {
      decision_id: 17, winner: "Reject", runner_up: "Approve", threshold: 0.5,
      required_margin: 0, floor: 0, actual_margin: 0, passed: true,
    })).rejects.toThrowError(/winner/i);
    await expect(store.bindDecision(tiedLink.evidence_ref, {
      decision_id: 17, winner: "Approve", runner_up: "Reject", threshold: 0.5,
      required_margin: 0, floor: 0, actual_margin: 0, passed: true,
    })).resolves.toBeUndefined();
  });
});
