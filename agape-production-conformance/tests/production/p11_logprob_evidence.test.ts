import { afterEach, describe, expect, it } from "vitest";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createTempProject, eventsOf, fixture, payloadObject, readTree, runCli, runDiagnostic, sentinel, type TempProject } from "./harness.js";
import { chatCompletion, messagesText, OpenAILoopback, type CompletionChoice, type ContentTokenEvidence, type RawCandidate } from "./openai-loopback.js";

interface CandidateSequence {
  content: string;
  variant?: "Approve" | "Reject";
  tokens: Array<{ token: string; logprob: number }>;
}

const EXTRA_TOKEN = " unmatched-evidence-token";
const EXTRA_SUFFIX = " unmatched-suffix";
const RAW_RESPONSE_ID = "chatcmpl-p11-exact-evidence";
const RAW_CREATED = "1700000000";
const RAW_USAGE_KEYS = ["usage", "prompt_tokens", "completion_tokens", "total_tokens"];
const SEQUENCES: CandidateSequence[] = [
  { content: "Approve", variant: "Approve", tokens: [
    { token: "App", logprob: Math.log(0.9) },
    { token: "rove", logprob: Math.log(0.51) },
  ] },
  { content: "Reject", variant: "Reject", tokens: [
    { token: "Rej", logprob: Math.log(0.9) },
    { token: "ect", logprob: Math.log(0.49) },
  ] },
  { content: `${EXTRA_TOKEN}${EXTRA_SUFFIX}`, tokens: [
    { token: EXTRA_TOKEN, logprob: Math.log(0.5) },
    { token: EXTRA_SUFFIX, logprob: Math.log(0.2) },
  ] },
];

function tokenEvidence(token: string, logprob: number): ContentTokenEvidence {
  const candidate: RawCandidate = { token, logprob, bytes: [...Buffer.from(token)] };
  return { ...candidate, top_logprobs: [candidate] };
}

function completionChoices(): CompletionChoice[] {
  return SEQUENCES.map((sequence) => ({
    content: sequence.content,
    contentEvidence: sequence.tokens.map(({ token, logprob }) => tokenEvidence(token, logprob)),
    finishReason: "stop",
  }));
}

function sequenceMass(sequence: CandidateSequence): number {
  return Math.exp(sequence.tokens.reduce((sum, token) => sum + token.logprob, 0));
}

function encodedRepresentations(value: string): string[] {
  const bytes = Buffer.from(value);
  return [bytes.toString("base64"), bytes.toString("base64url"), bytes.toString("hex"), bytes.toString("hex").toUpperCase()];
}

function expectAbsent(surface: string, needles: string[], label: string): void {
  for (const needle of new Set(needles.filter(Boolean))) {
    expect.soft(surface, `${label}: leaked protected representation ${needle}`).not.toContain(needle);
  }
}

function schemaEnumValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(schemaEnumValues);
  if (value === null || typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  const direct = Array.isArray(object.enum) ? object.enum.filter((item): item is string => typeof item === "string") : [];
  return [...direct, ...Object.entries(object).filter(([key]) => key !== "enum").flatMap(([, child]) => schemaEnumValues(child))];
}

function expectNoProtectedEvidence(surface: string, label: string, prompt: string): void {
  const rawSecrets = [prompt, prompt.slice(0, 12), prompt.slice(-12), EXTRA_TOKEN, EXTRA_SUFFIX, EXTRA_TOKEN + EXTRA_SUFFIX, RAW_RESPONSE_ID, RAW_CREATED, ...RAW_USAGE_KEYS];
  expectAbsent(surface, rawSecrets.flatMap((value) => [value, ...encodedRepresentations(value)]), label);
  expectAbsent(surface, ["\"finish_reason\"", "\"finishReason\""], label);
  for (const sequence of SEQUENCES) {
    for (const token of sequence.tokens) {
      const bytesJson = JSON.stringify([...Buffer.from(token.token)]);
      const logprobText = JSON.stringify(token.logprob);
      expectAbsent(surface, [
        JSON.stringify(token.token),
        ...encodedRepresentations(token.token),
        logprobText,
        ...encodedRepresentations(logprobText),
        bytesJson,
        ...encodedRepresentations(bytesJson),
      ], label);
    }
  }
}

describe("P11 production JudgmentEvidence", () => {
  let project: TempProject | undefined;
  let loopback: OpenAILoopback | undefined;
  let requestViolations: string[] = [];

  afterEach(async () => {
    await loopback?.close();
    await project?.cleanup();
    const violations = requestViolations;
    requestViolations = [];
    expect(violations, "P11 loopback rejected the production request contract").toEqual([]);
  });

  async function setup(): Promise<{ file: string; prompt: string }> {
    project = await createTempProject(sentinel("p11-project"));
    const prompt = sentinel("P11_CLOSE_GATE_PROMPT");
    const file = await project.write("main.ag", await fixture("p11/evidence.ag.tmpl", { PROMPT: prompt }));
    loopback = new OpenAILoopback(({ body }) => {
      const userData = messagesText(body, "user");
      const systemData = messagesText(body, "system");
      const contractData = systemData + "\n" + JSON.stringify(body.response_format ?? {});
      if (!userData.includes(prompt)) requestViolations.push("exact prompt was not user data");
      if (contractData.includes(prompt)) requestViolations.push("protected prompt leaked into system/contract data");
      if (!contractData.includes("Verdict")) requestViolations.push("contract omitted the Verdict enum name");
      const declaredVariants = [...new Set(schemaEnumValues(body.response_format))].sort();
      if (JSON.stringify(declaredVariants) !== JSON.stringify(["Approve", "Reject"])) {
        requestViolations.push("contract did not declare exactly Approve and Reject");
      }
      if (body.n !== SEQUENCES.length) requestViolations.push("request did not declare n=3");
      if (body.logprobs !== true) requestViolations.push("request did not enable logprobs");
      if (!Number.isInteger(body.top_logprobs) || body.top_logprobs! < 1 || body.top_logprobs! > 20) {
        requestViolations.push("top_logprobs was not an integer in 1..20");
      }
      const choices = completionChoices();
      if (typeof body.n !== "number" || choices.length > body.n) {
        requestViolations.push("fixture emitted more complete sequences than declared n");
      }
      return { body: chatCompletion({
        choices,
        responseId: RAW_RESPONSE_ID,
        model: "agape-loopback-conformance",
      }) };
    });
    await loopback.start();
    return { file, prompt };
  }

  it("[P11.sequence-evidence] links public gate arithmetic to protected complete multi-token sequences", async () => {
    const { file, prompt } = await setup();
    const result = await runCli({ project: project!, file, env: loopback!.env() });
    expect(loopback!.transcript.length, "P11: production connector made no request").toBeGreaterThan(0);
    expect.soft(loopback!.transcript, "P11: one logical judgment must use one bounded request").toHaveLength(1);
    const request = loopback!.transcript[0]!.body;
    expect.soft(request.n, "P11: production connector request must declare the complete-sequence count").toBe(SEQUENCES.length);
    expect.soft(request.logprobs, "P11: production connector request must ask for logprobs").toBe(true);
    expect.soft(request.top_logprobs, "P11: production connector request must declare a valid integer per-token bound")
      .toSatisfy((value) => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 20);
    expect.soft(completionChoices().length, "P11: fixture cannot return more complete sequences than declared n")
      .toSatisfy((length) => typeof request.n === "number" && length <= request.n);
    const userData = messagesText(request, "user");
    const systemData = messagesText(request, "system");
    const contractData = systemData + "\n" + JSON.stringify(request.response_format ?? {});
    expect.soft(userData, "P11: protected prompt must be delivered exactly as user data").toContain(prompt);
    expect.soft(systemData, "P11: protected prompt must not be promoted to system instructions").not.toContain(prompt);
    expect.soft(contractData, "P11: protected prompt must not leak into system or schema contract").not.toContain(prompt);
    expect.soft(contractData, "P11: contract must name the Verdict enum").toContain("Verdict");
    expect.soft([...new Set(schemaEnumValues(request.response_format))].sort(),
      "P11: contract must expose exactly the two declared variants").toEqual(["Approve", "Reject"]);
    expect(result.json?.ok, runDiagnostic(result)).toBe(true);

    const resolved = eventsOf(result, "Resolved")[0];
    const decided = eventsOf(result, "Decided")[0];
    expect(resolved, "P11: provider call must close with Resolved").toBeTruthy();
    expect(decided, "P11: close gate must append Decided").toBeTruthy();
    const resolvedPayload = payloadObject(resolved);
    const decidedPayload = payloadObject(decided);
    expect.soft(resolvedPayload, "P11: Resolved must link immutable JudgmentEvidence").toMatchObject({
      evidence_id: expect.any(String), evidence_hash: expect.any(String),
      evidence_ref: expect.any(String), gate_scores: expect.any(Object),
    });
    expectNoProtectedEvidence(JSON.stringify(resolvedPayload), "P11 public Resolved", prompt);
    expect.soft(decidedPayload, "P11: Decided must repeat evidence linkage and exact gate arithmetic").toMatchObject({
      evidence_id: expect.any(String), evidence_hash: expect.any(String), evidence_ref: expect.any(String),
      winner: "Approve", runner_up: "Reject", threshold: 0.5, minimum_margin: 0.03,
      floor: 0.015, margin: expect.closeTo(0.02, 12), arithmetic: expect.any(Object), committed: "abstained",
    });
    expectNoProtectedEvidence(JSON.stringify(decidedPayload), "P11 public Decided", prompt);

    const massByVariant = Object.fromEntries(SEQUENCES.filter((sequence) => sequence.variant)
      .map((sequence) => [sequence.variant!, sequenceMass(sequence)])) as Record<"Approve" | "Reject", number>;
    const unmatchedMass = SEQUENCES.filter((sequence) => !sequence.variant)
      .reduce((sum, sequence) => sum + sequenceMass(sequence), 0);
    expect.soft(massByVariant.Approve + massByVariant.Reject + unmatchedMass,
      "P11 fixture control: complete sequence masses must form a valid bounded distribution").toBeCloseTo(1, 12);
    const matchedMass = massByVariant.Approve + massByVariant.Reject;
    const recomputed = { Approve: massByVariant.Approve / matchedMass, Reject: massByVariant.Reject / matchedMass };
    const publicScores = resolvedPayload.gate_scores as Record<string, number> | undefined;
    expect.soft(publicScores?.Approve ?? Number.NaN).toBeCloseTo(recomputed.Approve, 12);
    expect.soft(publicScores?.Reject ?? Number.NaN).toBeCloseTo(recomputed.Reject, 12);
    expect.soft((publicScores?.Approve ?? 0) - (publicScores?.Reject ?? 0)).toBeCloseTo(0.02, 12);
  });

  it("[P11.record-replay] keeps the protected recording opaque and replays without calls or durable mutation", async () => {
    const { file, prompt } = await setup();
    const recordingPath = join(project!.root, "run.agape-recording");
    const recorded = await runCli({ project: project!, file, env: loopback!.env(), extraArgs: ["--record", recordingPath] });
    expect.soft(recorded.json?.ok, `P11: shipped CLI must accept --record and produce a protected recording:\n${runDiagnostic(recorded)}`).toBe(true);
    let exists = true;
    try { await access(recordingPath); } catch { exists = false; }
    expect.soft(exists, "P11: --record produced no recording artifact").toBe(true);
    if (!exists) return;

    const opaqueRecording = await readFile(recordingPath);
    expectNoProtectedEvidence(opaqueRecording.toString("utf8"), "P11 opaque recording", prompt);
    const recordedResolved = eventsOf(recorded, "Resolved")[0];
    expect.soft(payloadObject(recordedResolved), "P11: recording must retain a protected evidence hash/ref without plaintext candidates")
      .toMatchObject({ evidence_hash: expect.any(String), evidence_ref: expect.any(String) });
    expectNoProtectedEvidence(JSON.stringify(payloadObject(recordedResolved)), "P11 public recorded ledger", prompt);

    const recordedEvents = eventsOf(recorded);
    expect.soft(recordedEvents, "P11: recorded source ledger must contain the full event sequence").not.toHaveLength(0);
    const liveHead = recorded.json?.head;
    expect.soft(liveHead, "P11: recorded source head must be a nonempty canonical hash")
      .toSatisfy((value) => typeof value === "string" && value.length > 0);
    const liveCalls = loopback!.transcript.length;
    const beforeReplay = await readTree(project!.root);
    const replayed = await runCli({ project: project!, file, env: loopback!.env(), extraArgs: ["--replay", recordingPath] });
    const afterReplay = await readTree(project!.root);
    expect.soft(replayed.json?.ok, `P11: replay failed:\n${runDiagnostic(replayed)}`).toBe(true);
    expect.soft(replayed.json?.head, "P11: replay head must be a nonempty canonical hash")
      .toSatisfy((value) => typeof value === "string" && value.length > 0);
    expect.soft(replayed.json?.head, "P11: verification replay must reproduce the source head").toBe(liveHead);
    const replayedEvents = eventsOf(replayed);
    expect.soft(replayedEvents, "P11: replay must reproduce every recorded source event, not a head-only no-op")
      .toEqual(recordedEvents);
    const replayedResolved = replayedEvents.find((event) => event.etype === "Resolved");
    expect.soft(payloadObject(replayedResolved), "P11: replay must preserve exact JudgmentEvidence linkage")
      .toMatchObject({
        evidence_id: payloadObject(recordedResolved).evidence_id,
        evidence_hash: payloadObject(recordedResolved).evidence_hash,
        evidence_ref: payloadObject(recordedResolved).evidence_ref,
      });
    expect.soft(loopback!.transcript.length, "P11: verification replay invoked the provider instead of serving the journal").toBe(liveCalls);
    expect.soft(afterReplay, "P11: read-only verification replay mutated durable project state").toEqual(beforeReplay);
  });

  it("[P11.principal-resolution] requires principal-bound lossless resolution through the real protected-content transport", () => {
    expect.fail("P11/P16 required gap: no production principal-proof transport fixture can yet authorize and resolve raw_candidates_ref losslessly");
  });
});
