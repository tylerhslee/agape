import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { RecordingProvider, ReplayProvider, readRuntimeRecording, writeRuntimeRecording } from "../src/runtime_recording.js";
import type { Provider } from "../src/runtime.js";
import type { JudgmentEvidence } from "../src/protected_evidence.js";

const KEY = Buffer.alloc(32, 0x31);

function exactEvidence(): JudgmentEvidence {
  return {
    version: 1,
    method: "bounded-complete-sequence-logprobs",
    connector: "test",
    enum_name: "Verdict",
    enum_variants: ["Yes", "No"],
    candidate_bound: 2,
    candidates: [
      { content: "Yes", variant: "Yes", tokens: [{ token: "Yes", logprob: Math.log(0.8), bytes: [89, 101, 115] }], aggregate_logprob: Math.log(0.8), aggregate_score: 0.8, finish_reason: "stop" },
      { content: "No", variant: "No", tokens: [{ token: "No", logprob: Math.log(0.2), bytes: [78, 111] }], aggregate_logprob: Math.log(0.2), aggregate_score: 0.2, finish_reason: "stop" },
    ],
    mapping_version: "exact-enum-v1",
    normalization_version: "matched-sequence-mass-v1",
    gate_scores: { Yes: 0.8, No: 0.2 },
  };
}

describe("authenticated runtime provider recording", () => {
  let root: string | undefined;
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = undefined; });

  it("encrypts exact evidence and replays it without invoking a provider", async () => {
    let calls = 0;
    const live: Provider = {
      async judge() { calls++; return { scores: { Yes: 0.8, No: 0.2 }, evidence: exactEvidence() }; },
      async structured() { calls++; return { answer: "private-structured" }; },
      async reply() { calls++; return "private-reply"; },
    };
    const recording = new RecordingProvider(live);
    const judged = await recording.judge("private prompt", "Verdict", ["Yes", "No"]);
    const structured = await recording.structured!("private struct", { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false }, "Answer");
    const replied = await recording.reply("private reply prompt");
    expect(calls).toBe(3);

    root = await mkdtemp(join(tmpdir(), "agape-runtime-recording-"));
    const path = join(root, "run.agape-recording");
    await writeRuntimeRecording(path, KEY, {
      kind: "agape-runtime-recording",
      version: 1,
      source_hash: "a".repeat(64),
      manifest_hash: "b".repeat(64),
      identity: { projectSubject: "project", sessionLineageId: "lineage", sessionId: "session", conversationId: "conversation" },
      provider: recording.snapshot(),
      named_memory: { kind: "agape-named-memory-recording", version: 1, identityCommitment: "c".repeat(64), operations: [] },
      ledger_timing: [],
      head: "d".repeat(64),
    });
    const bytes = await readFile(path);
    for (const secret of ["private prompt", "private-structured", "private-reply", "Yes", JSON.stringify(exactEvidence().candidates[0]!.tokens[0]!.logprob)]) {
      expect(bytes.toString("utf8")).not.toContain(secret);
    }

    const restored = await readRuntimeRecording(path, KEY);
    const replay = new ReplayProvider(restored.provider);
    await expect(replay.judge("private prompt", "Verdict", ["Yes", "No"])).resolves.toEqual(judged);
    await expect(replay.structured!("private struct", { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false }, "Answer")).resolves.toEqual(structured);
    await expect(replay.reply("private reply prompt")).resolves.toBe(replied);
    expect(() => replay.assertConsumed()).not.toThrow();
    expect(calls).toBe(3);
  });

  it("fails closed on request drift, unconsumed operations, tampering, or the wrong key", async () => {
    const live: Provider = { async judge() { return { scores: { Yes: 1 } }; }, async reply() { return "x"; } };
    const recording = new RecordingProvider(live);
    await recording.judge("expected", "Verdict", ["Yes"]);
    const replay = new ReplayProvider(recording.snapshot());
    await expect(replay.judge("different", "Verdict", ["Yes"])).rejects.toThrow(/request mismatch/i);

    const unconsumed = new ReplayProvider(recording.snapshot());
    expect(() => unconsumed.assertConsumed()).toThrow(/unconsumed/i);

    root = await mkdtemp(join(tmpdir(), "agape-runtime-recording-"));
    const path = join(root, "run.agape-recording");
    await writeRuntimeRecording(path, KEY, {
      kind: "agape-runtime-recording", version: 1, source_hash: "a".repeat(64), manifest_hash: "b".repeat(64),
      identity: { projectSubject: "project", sessionLineageId: "lineage", sessionId: "session", conversationId: "conversation" },
      provider: recording.snapshot(), named_memory: { kind: "agape-named-memory-recording", version: 1, identityCommitment: "c".repeat(64), operations: [] }, ledger_timing: [], head: "d".repeat(64),
    });
    const original = await readFile(path);
    const tampered = Buffer.from(original); tampered[tampered.length - 1] ^= 1;
    await import("node:fs/promises").then(({ writeFile }) => writeFile(path, tampered));
    await expect(readRuntimeRecording(path, KEY)).rejects.toThrow(/authentication/i);
    await import("node:fs/promises").then(({ writeFile }) => writeFile(path, original));
    await expect(readRuntimeRecording(path, Buffer.alloc(32, 0x32))).rejects.toThrow(/authentication/i);
  });
});
