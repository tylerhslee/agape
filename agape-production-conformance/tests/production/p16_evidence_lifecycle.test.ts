import { afterEach, describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  createTempProject,
  fixture,
  runCli,
  runCliCommand,
  runDiagnostic,
  readTree,
  sentinel,
  type CliResult,
  type TempProject,
} from "./harness.js";
import {
  chatCompletion,
  OpenAILoopback,
  type CompletionChoice,
  type ContentTokenEvidence,
  type RawCandidate,
} from "./openai-loopback.js";

const PRINCIPAL = "principal:p16-reviewer";
const OTHER_PRINCIPAL = "principal:p16-other";
const KEY = "62".repeat(32);
const RECORDING_KEY = "73".repeat(32);
const PROTECTED_ENV = {
  AGAPE_AUTHENTICATED_PRINCIPAL: PRINCIPAL,
  AGAPE_PROTECTED_EVIDENCE_KEY: KEY,
};

function tokenEvidence(token: string, logprob: number): ContentTokenEvidence {
  const candidate: RawCandidate = { token, logprob, bytes: [...Buffer.from(token)] };
  return { ...candidate, top_logprobs: [candidate] };
}

function choices(): CompletionChoice[] {
  return [
    { content: "Zebra", contentEvidence: [tokenEvidence("Ze", Math.log(0.9)), tokenEvidence("bra", Math.log(0.5))], finishReason: "stop" },
    { content: "Alpha", contentEvidence: [tokenEvidence("Al", Math.log(0.9)), tokenEvidence("pha", Math.log(0.5))], finishReason: "stop" },
    { content: "unmatched", contentEvidence: [tokenEvidence("unmatched", Math.log(0.1))], finishReason: "stop" },
  ];
}

function accessOf(result: CliResult): { evidence_ref: string; decision_id: number; authorization: string } {
  const entries = result.json?.evidence_access as Array<Record<string, unknown>> | undefined;
  const entry = entries?.[0];
  expect(entry).toMatchObject({ evidence_ref: expect.any(String), decision_id: expect.any(Number), authorization: expect.any(String) });
  return entry as { evidence_ref: string; decision_id: number; authorization: string };
}

describe("P16 production protected-evidence lifecycle", () => {
  let project: TempProject | undefined;
  let loopback: OpenAILoopback | undefined;

  afterEach(async () => {
    await loopback?.close();
    await project?.cleanup();
    loopback = undefined;
    project = undefined;
  });

  async function setup(): Promise<{ file: string; manifestPath: string }> {
    project = await createTempProject(sentinel("p16-project"));
    const manifestPath = join(project.root, "agape.toml");
    const manifest = await readFile(manifestPath, "utf8");
    await writeFile(manifestPath, manifest + "\n[profiles]\nadvertised = [\"studio-fact-checker\"]\n", "utf8");
    const file = await project.write("main.ag", await fixture("p16/evidence_lifecycle.ag.tmpl", {
      PROMPT: sentinel("P16_DURABLE_EVIDENCE"),
    }));
    loopback = new OpenAILoopback(() => ({
      body: chatCompletion({ choices: choices(), model: "agape-loopback-conformance" }),
    }));
    await loopback.start();
    return { file, manifestPath };
  }

  async function evidenceCommand(manifestPath: string, operation: string, access: {
    evidence_ref: string;
    decision_id: number;
    authorization?: string;
  }, extra: string[] = [], env = PROTECTED_ENV): Promise<CliResult> {
    return runCliCommand({
      project: project!,
      commandArgs: [
        "evidence", operation,
        "--manifest", manifestPath,
        "--requester", PRINCIPAL,
        ...(access.authorization ? ["--authorization", access.authorization] : []),
        "--evidence-ref", access.evidence_ref,
        "--decision-id", String(access.decision_id),
        ...extra,
        "--json",
      ],
      env,
    });
  }

  async function authorize(manifestPath: string, operation: "inspect" | "export" | "delete", access: {
    evidence_ref: string;
    decision_id: number;
  }): Promise<string> {
    const result = await evidenceCommand(manifestPath, "authorize", access, ["--operation", operation]);
    expect(result.json?.ok, `P16 ${operation} authorization failed:\n${runDiagnostic(result)}`).toBe(true);
    expect(result.json?.authorization).toEqual(expect.any(String));
    return result.json!.authorization as string;
  }

  it("[P16.retention-export] retains encrypted evidence across processes and exports an exact tamper-evident bundle", async () => {
    const { file, manifestPath } = await setup();
    const run = await runCli({ project: project!, file, env: { ...loopback!.env(), ...PROTECTED_ENV } });
    expect(run.json?.ok, runDiagnostic(run)).toBe(true);
    const access = accessOf(run);

    const inspect = await evidenceCommand(manifestPath, "inspect", { ...access });
    expect(inspect.json?.ok, runDiagnostic(inspect)).toBe(true);
    expect(inspect.json?.evidence).toMatchObject({
      evidence_ref: access.evidence_ref,
      decision_id: access.decision_id,
      retention: "durable-until-explicit-delete",
      enum_name: "Verdict",
      enum_variants: ["Zebra", "Alpha"],
      winner: "Zebra",
      runner_up: "Alpha",
      actual_margin: 0,
      candidates: expect.any(Array),
    });

    const exportAuthorization = await authorize(manifestPath, "export", access);
    const exported = await evidenceCommand(manifestPath, "export", { ...access, authorization: exportAuthorization });
    expect(exported.json?.ok, runDiagnostic(exported)).toBe(true);
    const bundle = exported.json?.export as Record<string, unknown>;
    expect(bundle).toMatchObject({
      kind: "agape-protected-evidence-export",
      version: 1,
      requester: PRINCIPAL,
      evidence: inspect.json?.evidence,
      proof: expect.stringMatching(/^[0-9a-f]{64}$/),
    });

    const bundlePath = join(project!.root, "evidence-export.json");
    await writeFile(bundlePath, JSON.stringify(bundle), "utf8");
    const verified = await runCliCommand({
      project: project!,
      commandArgs: ["evidence", "verify-export", "--manifest", manifestPath, "--bundle", bundlePath, "--json"],
      env: PROTECTED_ENV,
    });
    expect(verified.json).toMatchObject({ ok: true, valid: true });

    const tampered = structuredClone(bundle) as { evidence: { candidates: Array<{ content: string }> } };
    tampered.evidence.candidates[0]!.content = "tampered";
    await writeFile(bundlePath, JSON.stringify(tampered), "utf8");
    const rejected = await runCliCommand({
      project: project!,
      commandArgs: ["evidence", "verify-export", "--manifest", manifestPath, "--bundle", bundlePath, "--json"],
      env: PROTECTED_ENV,
    });
    expect(rejected.json).toMatchObject({ ok: true, valid: false });
  });

  it("[P16.authorization-delete] binds every operation and deletes only through an exact authorized address", async () => {
    const { file, manifestPath } = await setup();
    const run = await runCli({ project: project!, file, env: { ...loopback!.env(), ...PROTECTED_ENV } });
    expect(run.json?.ok, runDiagnostic(run)).toBe(true);
    const access = accessOf(run);

    const crossOperation = await evidenceCommand(manifestPath, "export", access);
    expect(crossOperation.json).toMatchObject({ ok: false, class: "Forbidden" });

    const wrongDecision = await evidenceCommand(manifestPath, "authorize", {
      evidence_ref: access.evidence_ref,
      decision_id: access.decision_id + 1,
    }, ["--operation", "delete"]);
    expect(wrongDecision.json).toMatchObject({ ok: false, class: "EvidenceMismatch" });

    const wrongPrincipal = await runCliCommand({
      project: project!,
      commandArgs: [
        "evidence", "authorize", "--manifest", manifestPath,
        "--requester", OTHER_PRINCIPAL, "--operation", "delete",
        "--evidence-ref", access.evidence_ref, "--decision-id", String(access.decision_id), "--json",
      ],
      env: PROTECTED_ENV,
    });
    expect(wrongPrincipal.json).toMatchObject({ ok: false, class: "Forbidden" });

    const noEnumeration = await runCliCommand({
      project: project!,
      commandArgs: [
        "evidence", "authorize", "--manifest", manifestPath,
        "--requester", PRINCIPAL, "--operation", "inspect", "--decision-id", String(access.decision_id), "--json",
      ],
      env: PROTECTED_ENV,
    });
    expect(noEnumeration.json?.ok).toBe(false);

    const exportAuthorization = await authorize(manifestPath, "export", access);
    const deleteAuthorization = await authorize(manifestPath, "delete", access);
    const deleted = await evidenceCommand(manifestPath, "delete", { ...access, authorization: deleteAuthorization });
    expect(deleted.json).toMatchObject({ ok: true, deleted: true });

    const unavailableInspect = await evidenceCommand(manifestPath, "inspect", access);
    expect(unavailableInspect.json).toMatchObject({ ok: false, class: "EvidenceUnavailable" });
    const unavailableExport = await evidenceCommand(manifestPath, "export", { ...access, authorization: exportAuthorization });
    expect(unavailableExport.json).toMatchObject({ ok: false, class: "EvidenceUnavailable" });
    const unavailableDelete = await evidenceCommand(manifestPath, "delete", { ...access, authorization: deleteAuthorization });
    expect(unavailableDelete.json).toMatchObject({ ok: false, class: "EvidenceUnavailable" });
  });

  it("[P16.record-delete-replay] replays public commitments after deletion without provider or protected-store access", async () => {
    const { file, manifestPath } = await setup();
    const recordingPath = join(project!.root, "p16.agape-recording");
    const recorded = await runCli({
      project: project!, file, env: {
        ...loopback!.env(),
        ...PROTECTED_ENV,
        AGAPE_RECORDING_KEY: RECORDING_KEY,
      },
      extraArgs: ["--record", recordingPath],
    });
    expect(recorded.json?.ok, runDiagnostic(recorded)).toBe(true);
    const access = accessOf(recorded);
    const deleteAuthorization = await authorize(manifestPath, "delete", access);
    const deleted = await evidenceCommand(manifestPath, "delete", {
      ...access, authorization: deleteAuthorization,
    });
    expect(deleted.json).toMatchObject({ ok: true, deleted: true });

    const providerCalls = loopback!.transcript.length;
    const beforeReplay = await readTree(project!.root);
    const replayed = await runCli({
      project: project!, file, env: {
        ...loopback!.env(),
        AGAPE_AUTHENTICATED_PRINCIPAL: PRINCIPAL,
        AGAPE_RECORDING_KEY: RECORDING_KEY,
      },
      extraArgs: ["--replay", recordingPath],
    });
    const afterReplay = await readTree(project!.root);
    expect(replayed.json?.ok, runDiagnostic(replayed)).toBe(true);
    expect(replayed.json?.head).toBe(recorded.json?.head);
    expect(replayed.json?.events).toEqual(recorded.json?.events);
    expect(loopback!.transcript).toHaveLength(providerCalls);
    expect(afterReplay).toEqual(beforeReplay);
  });
});
