import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import type {
  AttesterRequest,
  ConsultRequest,
  PrincipalAttestation,
  PromptInput,
  RuntimeSession,
  RunResult,
} from "../../agape-ts/src/interp.ts";
import { Ledger } from "../../agape-ts/src/runtime.ts";
import {
  RuntimeSessionApiError,
  StudioRuntimeSessionRegistry,
  validatedEndorsementCertificates,
  type RuntimeSessionFactory,
  type RuntimeSessionOpenRequest,
} from "./runtime-session.ts";

function fixtureCanonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(fixtureCanonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, member]) => `${JSON.stringify(key)}:${fixtureCanonicalJson(member)}`).join(",")}}`;
}
function fixtureHash(value: unknown): string {
  return createHash("sha256").update(fixtureCanonicalJson(value), "utf8").digest("hex");
}

class AttestationRuntime implements RuntimeSession {
  readonly ledger = new Ledger(0);
  readonly stdout: string[] = [];
  private started = false;
  private closed = false;

  constructor(
    private readonly request: RuntimeSessionOpenRequest,
    private readonly tamper?: (request: AttesterRequest) => AttesterRequest,
  ) {}

  async start(): Promise<RunResult> {
    if (!this.started) {
      this.started = true;
      this.ledger.append("PromptOpened", "message");
      this.ledger.append("Spawned", "agent-instance", null, "assistant");
    }
    return this.snapshot();
  }

  async sendPrompt(input: PromptInput): Promise<RunResult> {
    if (this.closed) throw new Error("closed");
    await this.start();
    this.ledger.append("Prompt", input.name, { value: input.value }, "assistant");
    const scores = { Approve: 0.5, Deny: 0.5 };
    const pendingTick = this.ledger.events.length;
    const rule = { kind: "principal", principal: "reviewer" };
    const ruleHash = fixtureHash(rule);
    const principalRequestFields = {
      corr: pendingTick,
      who: "reviewer",
      credence_id: "Approval",
      evidence_hash: null,
      rule_hash: ruleHash,
      subject_hash: fixtureHash({ kind: "credence", enum: "Approval", scores }),
      governed_operation: null,
      governed_request_hash: null,
    };
    const principalRequest = fixtureHash({ domain: "agape/principal-request/v1", request: principalRequestFields });
    this.ledger.append("PendingPrincipalDecision", "reviewer", {
      ...principalRequestFields, request_hash: principalRequest, credence: "Approval", scores,
    }, "assistant", pendingTick);
    const attestation = await this.request.onConsult({
      principal: "reviewer",
      enumName: "Approval",
      variants: ["Approve", "Deny"],
      scores,
      margin: 0,
      agent: "assistant",
    } satisfies ConsultRequest);
    if (!attestation) {
      this.ledger.append("FailedPrincipalDecision", "reviewer", { pending: pendingTick }, "assistant", pendingTick);
      const tick = this.ledger.events.length;
      this.ledger.append("Decided", "approval", {
        decision_id: tick, committed: "abstained", basis: "Principal", margin: 0,
      }, "assistant");
      return this.snapshot();
    }
    const rulingTick = this.ledger.events.length;
    const verifyRequest = {
      principal: "reviewer",
      corr: pendingTick,
      attester: attestation.attester,
      binding: { driver: "host" },
    } satisfies AttesterRequest;
    const verified = await this.request.attesterVerifier(this.tamper?.(verifyRequest) ?? verifyRequest);
    if (verified !== "reviewer") throw new Error("attester rejected");
    this.ledger.append("PrincipalDecision", "reviewer", {
      pending: pendingTick,
      decision: attestation.decision,
      ruled_variant: attestation.decision,
      corr: pendingTick, request_hash: principalRequest, who: "reviewer",
      evidence_hash: null, governed_request_hash: null,
      attestation: { ...attestation, attester_verification: "verified" },
    }, "assistant", pendingTick);
    const decisionTick = this.ledger.events.length;
    const subjectCommitment = { kind: "text", value: "answer" };
    const subjectHash = fixtureHash(subjectCommitment);
    this.ledger.append("Decided", "approval", {
      decision_id: decisionTick,
      committed: attestation.decision,
      basis: "Principal",
      margin: 0,
      principal_event: rulingTick,
      rule,
      rule_hash: ruleHash,
      evidence_ref: null,
      principal_request: principalRequest,
    }, "assistant");
    if (attestation.decision === "Approve") {
      const endorsed = this.ledger.append("Endorsed", "answer", {
        subject_hash: subjectHash,
        subject_commitment: subjectCommitment,
        decision_id: decisionTick,
        variant: "Approve",
        rule_hash: ruleHash,
        evidence_ref: null,
        principal_event: rulingTick,
        principal_request: principalRequest,
      }, "assistant");
      const actionTick = this.ledger.events.length;
      const arguments_ = ["answer"];
      const argumentCommitments = [subjectCommitment];
      const argumentHash = fixtureHash(subjectCommitment);
      const requestHash = fixtureHash({ action: "Reply", argument_hashes: [argumentHash] });
      const authorizationBinding = {
        argument_index: 0,
        argument_hash: argumentHash,
        derivation_path: [] as string[],
        subject_hash: subjectHash,
        endorsement_tick: endorsed.tick,
        decision_id: decisionTick,
        rule_hash: ruleHash,
        evidence_ref: null,
      };
      this.ledger.appendBatch([
        { etype: "Reply", subject: "assistant", payload: {
          arguments: arguments_, argument_commitments: argumentCommitments,
          argument_hashes: [argumentHash], authorization_argument_indices: [0],
          authorization_bindings: [authorizationBinding], request_hash: requestHash,
        }, agent: "assistant" },
        { etype: "ActionAuthorized", subject: "assistant", agent: "assistant", corr: actionTick, payload: {
          action_tick: actionTick, action: "Reply", action_agent: "assistant", action_corr: null,
          request_hash: requestHash, argument_index: 0, argument_hash: argumentHash,
          derivation_path: [], subject_hash: subjectHash, endorsement_tick: endorsed.tick,
          decision_id: decisionTick, rule_hash: ruleHash, evidence_ref: null,
        } },
      ]);
    }
    return this.snapshot();
  }

  snapshot(): RunResult {
    return {
      ledger: this.ledger,
      stdout: this.stdout,
      warnings: [],
      namedMemoryRecording: {
        kind: "agape.named-memory.runtime-recording",
        version: 2,
        identity_commitment: "fake",
        operations: [],
      },
    };
  }

  async close(): Promise<RunResult> {
    this.closed = true;
    return this.snapshot();
  }
}

class AttestationFactory implements RuntimeSessionFactory {
  opened: RuntimeSessionOpenRequest[] = [];
  runtimes: AttestationRuntime[] = [];
  evidenceRequests: Parameters<NonNullable<RuntimeSessionFactory["inspectEvidence"]>>[0][] = [];
  constructor(private readonly tamper?: (request: AttesterRequest) => AttesterRequest) {}

  open(request: RuntimeSessionOpenRequest): RuntimeSession {
    this.opened.push(request);
    const runtime = new AttestationRuntime(request, this.tamper);
    this.runtimes.push(runtime);
    return runtime;
  }

  async inspectEvidence(request: Parameters<NonNullable<RuntimeSessionFactory["inspectEvidence"]>>[0]) {
    this.evidenceRequests.push(request);
    return {
      version: 1 as const,
      method: "bounded-complete-sequence-logprobs" as const,
      connector: "test",
      enum_name: "Verdict",
      enum_variants: ["Approve", "Deny"],
      candidate_bound: 1,
      candidates: [{
        content: "Approve", variant: "Approve", tokens: [{ token: "Approve", logprob: -0.1, bytes: null }],
        aggregate_logprob: -0.1, aggregate_score: Math.exp(-0.1), finish_reason: "stop",
      }],
      mapping_version: "exact-enum-v1" as const,
      normalization_version: "matched-sequence-mass-v1" as const,
      gate_scores: { Approve: 1, Deny: 0 },
      evidence_id: "evidence-id",
      evidence_hash: "evidence-hash",
      evidence_ref: request.evidenceRef,
      retention: "durable-until-explicit-delete" as const,
      decision_id: request.decisionId,
      winner: "Approve",
      runner_up: "Deny",
      threshold: 0.8,
      required_margin: 0.1,
      floor: 0.2,
      actual_margin: 1,
      passed: true,
    };
  }
}

const user = { issuer: "urn:test", subject: "user-7", verified: true as const };

async function expectApiError(promise: Promise<unknown>, status: number, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ status, code } satisfies Partial<RuntimeSessionApiError>);
}

describe("StudioRuntimeSessionRegistry", () => {
  it("reopens the same authenticated conversation lineage with a fresh session ID", async () => {
    const firstRegistry = new StudioRuntimeSessionRegistry(new AttestationFactory());
    const secondRegistry = new StudioRuntimeSessionRegistry(new AttestationFactory());
    const base = {
      sourceRef: "assistant.ag",
      projectRoot: "/project",
      projectSubject: "project:test",
      conversationId: "conversation-stable",
      user,
    };
    const first = await firstRegistry.create(base);
    const reopened = await secondRegistry.create(base);
    expect(reopened.sessionLineageId).toBe(first.sessionLineageId);
    expect(reopened.sessionId).not.toBe(first.sessionId);

    const otherProject = await secondRegistry.create({
      ...base,
      projectSubject: "project:other",
    });
    const otherUser = await secondRegistry.create({
      ...base,
      user: { issuer: user.issuer, subject: "user-8", verified: true },
    });
    const otherIssuer = await secondRegistry.create({
      ...base,
      user: { issuer: "urn:other", subject: user.subject, verified: true },
    });
    const otherConversation = await secondRegistry.create({
      ...base,
      conversationId: "conversation-other",
    });
    expect(new Set([
      first.sessionLineageId,
      otherProject.sessionLineageId,
      otherUser.sessionLineageId,
      otherIssuer.sessionLineageId,
      otherConversation.sessionLineageId,
    ])).toHaveLength(5);
  });

  it("preserves one authenticated runtime session across prompts and exact rulings", async () => {
    const factory = new AttestationFactory();
    const registry = new StudioRuntimeSessionRegistry(factory);
    const created = await registry.create({
      sourceRef: "assistant.ag",
      projectRoot: "/project",
      projectSubject: "project:test",
      conversationId: "conversation-9",
      user,
    });
    expect(created.state).toBe("ready");
    expect(created.conversationId).toBe("conversation-9");
    expect(factory.opened).toHaveLength(1);
    expect(factory.opened[0]!.identity).toMatchObject({
      sessionId: created.sessionId,
      sessionLineageId: created.sessionLineageId,
      conversationId: "conversation-9",
      user,
    });

    const pending = await registry.sendPrompt(created.sessionId, created.accessToken, { name: "message", value: "hello" });
    expect(pending.state).toBe("pending-ruling");
    expect(pending.pending).toMatchObject({ principal: "reviewer", pendingTick: 3 });
    const requestId = pending.pending!.requestId;

    await expectApiError(
      registry.rule({ sessionId: created.sessionId, accessToken: "wrong", requestId, principal: "reviewer", outcome: "approve" }),
      401,
      "invalid_session_capability",
    );
    await expectApiError(
      registry.rule({ sessionId: created.sessionId, accessToken: created.accessToken, requestId, principal: "somebody-else", outcome: "approve" }),
      403,
      "wrong_principal",
    );

    const resumed = await registry.rule({
      sessionId: created.sessionId,
      accessToken: created.accessToken,
      requestId,
      principal: "reviewer",
      outcome: "approve",
    });
    expect(resumed.state).toBe("ready");
    expect(resumed.ledger.map((event) => event.etype)).toEqual(expect.arrayContaining([
      "PendingPrincipalDecision", "PrincipalDecision", "Decided", "Endorsed", "Reply", "ActionAuthorized",
    ]));
    expect(resumed.certificates).toHaveLength(1);
    expect(resumed.certificates[0]).toMatchObject({
      kind: "agape.action-authorization-certificate.v1",
      ledgerHead: resumed.ledgerHead,
      action: "Reply",
      actionTick: 7,
      argumentIndex: 0,
      basis: "Principal",
      committed: "Approve",
      principalAttestationVerified: true,
    });
    await expectApiError(
      registry.rule({ sessionId: created.sessionId, accessToken: created.accessToken, requestId, principal: "reviewer", outcome: "approve" }),
      409,
      "duplicate_ruling",
    );

    const secondPending = await registry.sendPrompt(created.sessionId, created.accessToken, { name: "message", value: "again" });
    expect(secondPending.sessionLineageId).toBe(created.sessionLineageId);
    expect(secondPending.conversationId).toBe(created.conversationId);
    expect(secondPending.pending!.pendingTick).toBeGreaterThan(pending.pending!.pendingTick);
    expect(secondPending.ledger.length).toBeGreaterThan(resumed.ledger.length);
    const declined = await registry.rule({
      sessionId: created.sessionId,
      accessToken: created.accessToken,
      requestId: secondPending.pending!.requestId,
      principal: "reviewer",
      outcome: "decline",
    });
    expect(declined.ledger.at(-2)?.etype).toBe("FailedPrincipalDecision");
    expect(declined.certificates).toHaveLength(1);
  });

  it("inspects protected evidence only for the authenticated session's exact Decided binding", async () => {
    const factory = new AttestationFactory();
    const registry = new StudioRuntimeSessionRegistry(factory);
    const created = await registry.create({
      sourceRef: "assistant.ag",
      projectRoot: "/project",
      projectSubject: "project:test",
      user,
    });
    const runtime = factory.runtimes[0]!;
    const decisionId = runtime.ledger.events.length;
    const evidenceRef = "protected:evidence:v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    runtime.ledger.append("Decided", "approval", {
      decision_id: decisionId,
      committed: "Approve",
      basis: "Confidence",
      margin: 0.7,
      evidence_ref: evidenceRef,
    });

    await expectApiError(
      registry.inspectEvidence(created.sessionId, "wrong", evidenceRef, decisionId),
      401,
      "invalid_session_capability",
    );
    await expectApiError(
      registry.inspectEvidence(created.sessionId, created.accessToken, evidenceRef, decisionId + 1),
      409,
      "evidence_mismatch",
    );
    await expectApiError(
      registry.inspectEvidence(created.sessionId, created.accessToken, `${evidenceRef}x`, decisionId),
      409,
      "evidence_mismatch",
    );

    const inspected = await registry.inspectEvidence(created.sessionId, created.accessToken, evidenceRef, decisionId);
    expect(inspected).toMatchObject({ evidence_ref: evidenceRef, decision_id: decisionId, threshold: 0.8, actual_margin: 1, passed: true });
    expect(factory.evidenceRequests).toHaveLength(1);
    expect(factory.evidenceRequests[0]!.identity).toMatchObject({
      sessionId: created.sessionId,
      user,
    });
  });

  it.each([
    ["signature", (request: AttesterRequest) => ({ ...request, attester: `${request.attester}x` })],
    ["pending correlation", (request: AttesterRequest) => ({ ...request, corr: request.corr + 1 })],
    ["principal", (request: AttesterRequest) => ({ ...request, principal: "other" })],
  ])("rejects a ruling with a tampered %s binding", async (_label, tamper) => {
    const registry = new StudioRuntimeSessionRegistry(new AttestationFactory(tamper));
    const created = await registry.create({
      sourceRef: "assistant.ag",
      projectRoot: "/project",
      projectSubject: "project:test",
      user,
    });
    const pending = await registry.sendPrompt(created.sessionId, created.accessToken, {
      name: "message",
      value: "hello",
    });
    await expect(registry.rule({
      sessionId: created.sessionId,
      accessToken: created.accessToken,
      requestId: pending.pending!.requestId,
      principal: "reviewer",
      outcome: "approve",
    })).rejects.toThrow("attester rejected");
    const snapshot = registry.inspect(created.sessionId, created.accessToken);
    expect(snapshot.ledger.map((event) => event.etype)).not.toContain("PrincipalDecision");
    expect(snapshot.ledger.map((event) => event.etype)).not.toContain("Endorsed");
    expect(snapshot.certificates).toEqual([]);
  });

  it("rejects every tampered action authorization binding without throwing", async () => {
    const registry = new StudioRuntimeSessionRegistry(new AttestationFactory());
    const created = await registry.create({
      sourceRef: "assistant.ag", projectRoot: "/project", projectSubject: "project:test", user,
    });
    const pending = await registry.sendPrompt(created.sessionId, created.accessToken, {
      name: "message", value: "hello",
    });
    const completed = await registry.rule({
      sessionId: created.sessionId,
      accessToken: created.accessToken,
      requestId: pending.pending!.requestId,
      principal: "reviewer",
      outcome: "approve",
    });
    expect(completed.certificates).toHaveLength(1);

    type MutableRow = {
      etype: string; subject: string; payload: any; agent: string; corr: number | null;
    };
    const rebuild = (mutate: (rows: MutableRow[]) => void) => {
      const rows = completed.ledger.map((event) => ({
        etype: event.etype,
        subject: event.subject,
        payload: structuredClone(event.payload),
        agent: event.agent,
        corr: event.corr,
      }));
      mutate(rows);
      const rebuilt = new Ledger(0);
      for (const row of rows) rebuilt.append(row.etype, row.subject, row.payload, row.agent, row.corr);
      return rebuilt.events;
    };
    const receipt = (rows: MutableRow[]) => rows.find((row) => row.etype === "ActionAuthorized")!;
    const action = (rows: MutableRow[]) => rows.find((row) => row.etype === "Reply")!;
    const endorsed = (rows: MutableRow[]) => rows.find((row) => row.etype === "Endorsed")!;
    const decided = (rows: MutableRow[]) => rows.find((row) => row.etype === "Decided")!;
    const addSecondAuthorizedArgument = (rows: MutableRow[]) => {
      const actionRow = action(rows);
      const firstReceipt = receipt(rows);
      const argumentHash = actionRow.payload.argument_hashes[0];
      const requestHash = fixtureHash({
        action: "Reply",
        argument_hashes: [argumentHash, argumentHash],
      });
      actionRow.payload.arguments.push(structuredClone(actionRow.payload.arguments[0]));
      actionRow.payload.argument_commitments.push(
        structuredClone(actionRow.payload.argument_commitments[0]),
      );
      actionRow.payload.argument_hashes.push(argumentHash);
      actionRow.payload.authorization_argument_indices.push(1);
      actionRow.payload.authorization_bindings.push({
        ...structuredClone(actionRow.payload.authorization_bindings[0]),
        argument_index: 1,
      });
      actionRow.payload.request_hash = requestHash;
      firstReceipt.payload.request_hash = requestHash;
      const secondReceipt = structuredClone(firstReceipt);
      secondReceipt.payload.argument_index = 1;
      rows.splice(rows.indexOf(firstReceipt) + 1, 0, secondReceipt);
    };
    const completeBatch = rebuild(addSecondAuthorizedArgument);
    expect(validatedEndorsementCertificates("session", completeBatch)).toHaveLength(2);
    const incompleteBatch = rebuild((rows) => {
      addSecondAuthorizedArgument(rows);
      const firstReceiptIndex = rows.findIndex((row) => row.etype === "ActionAuthorized");
      rows.splice(firstReceiptIndex + 1, 1);
    });
    expect(validatedEndorsementCertificates("session", incompleteBatch)).toEqual([]);
    const forgedHash = "0".repeat(64);
    const mutations: Array<[string, (rows: MutableRow[]) => void]> = [
      ["request_hash", (rows) => { receipt(rows).payload.request_hash = forgedHash; }],
      ["argument_hash", (rows) => { receipt(rows).payload.argument_hash = forgedHash; }],
      ["argument commitment", (rows) => { action(rows).payload.argument_commitments[0].value = "forged"; }],
      ["noncanonical primitive commitment", (rows) => { action(rows).payload.argument_commitments[0] = "answer"; }],
      ["authorization indices", (rows) => { action(rows).payload.authorization_argument_indices = [1]; }],
      ["subject_hash", (rows) => { receipt(rows).payload.subject_hash = forgedHash; }],
      ["subject commitment", (rows) => { endorsed(rows).payload.subject_commitment.value = "forged"; }],
      ["action_tick", (rows) => { receipt(rows).payload.action_tick = 0; }],
      ["argument_index", (rows) => { receipt(rows).payload.argument_index = 1; }],
      ["endorsement_tick", (rows) => { receipt(rows).payload.endorsement_tick = 0; }],
      ["decision_id", (rows) => { receipt(rows).payload.decision_id = 0; }],
      ["rule_hash", (rows) => { receipt(rows).payload.rule_hash = forgedHash; }],
      ["rule", (rows) => { decided(rows).payload.rule.principal = "forged"; }],
      ["variant", (rows) => { endorsed(rows).payload.variant = "Deny"; }],
      ["principal_request", (rows) => { decided(rows).payload.principal_request = forgedHash; }],
      ["ruling request_hash", (rows) => { rows.find((row) => row.etype === "PrincipalDecision")!.payload.request_hash = forgedHash; }],
      ["old principal decision shape", (rows) => { delete rows.find((row) => row.etype === "PrincipalDecision")!.payload.ruled_variant; }],
      ["evidence_ref", (rows) => { receipt(rows).payload.evidence_ref = "blob:forged"; }],
      ["derivation_path", (rows) => { receipt(rows).payload.derivation_path = ["forged"]; }],
      ["dual-copy nonexistent derivation path", (rows) => {
        receipt(rows).payload.derivation_path = ["forged"];
        action(rows).payload.authorization_bindings[0].derivation_path = ["forged"];
      }],
      ["dual-copy unrelated argument", (rows) => {
        const commitment = { kind: "text", value: "forged" };
        const argumentHash = fixtureHash(commitment);
        const requestHash = fixtureHash({ action: "Reply", argument_hashes: [argumentHash] });
        action(rows).payload.argument_commitments[0] = commitment;
        action(rows).payload.argument_hashes[0] = argumentHash;
        action(rows).payload.request_hash = requestHash;
        action(rows).payload.authorization_bindings[0].argument_hash = argumentHash;
        receipt(rows).payload.argument_hash = argumentHash;
        receipt(rows).payload.request_hash = requestHash;
      }],
      ["coordinated noncanonical metadata commitment", (rows) => {
        const commitment = { kind: "text", value: "answer", trust: "settled" };
        const commitmentHash = fixtureHash(commitment);
        const requestHash = fixtureHash({ action: "Reply", argument_hashes: [commitmentHash] });
        endorsed(rows).payload.subject_commitment = commitment;
        endorsed(rows).payload.subject_hash = commitmentHash;
        action(rows).payload.argument_commitments[0] = commitment;
        action(rows).payload.argument_hashes[0] = commitmentHash;
        action(rows).payload.request_hash = requestHash;
        Object.assign(action(rows).payload.authorization_bindings[0], {
          argument_hash: commitmentHash,
          subject_hash: commitmentHash,
        });
        Object.assign(receipt(rows).payload, {
          argument_hash: commitmentHash,
          subject_hash: commitmentHash,
          request_hash: requestHash,
        });
      }],
      ["missing canonical null", (rows) => { delete receipt(rows).payload.evidence_ref; }],
      ["extra receipt field", (rows) => { receipt(rows).payload.forged = true; }],
      ["noncontiguous receipt", (rows) => {
        const index = rows.findIndex((row) => row.etype === "ActionAuthorized");
        rows.splice(index, 0, { etype: "Unrelated", subject: "x", payload: null, agent: "assistant", corr: null });
      }],
      ["missing receipt", (rows) => rows.splice(rows.findIndex((row) => row.etype === "ActionAuthorized"), 1)],
      ["extra receipt", (rows) => rows.push(structuredClone(receipt(rows)))],
    ];
    for (const [label, mutate] of mutations) {
      expect(() => validatedEndorsementCertificates("session", rebuild(mutate)), label).not.toThrow();
      expect(validatedEndorsementCertificates("session", rebuild(mutate)), label).toEqual([]);
    }
  });

  it("rejects unverified users and never certifies a broken decision link", async () => {
    const registry = new StudioRuntimeSessionRegistry(new AttestationFactory());
    await expectApiError(registry.create({
      sourceRef: "assistant.ag",
      projectRoot: "/project",
      projectSubject: "project:test",
      user: { issuer: "urn:test", subject: "forged", verified: false as true },
    }), 401, "unverified_application_user");

    const ledger = new Ledger(0);
    ledger.append("Decided", "x", { decision_id: 0, committed: "Approve", basis: "Threshold", margin: 0.8 });
    ledger.append("Endorsed", "x", {
      decision: { decision_id: 0, committed: "Deny", basis: "Threshold", margin: 0.8 },
      endorsement: { committed: "Deny" },
    });
    expect(validatedEndorsementCertificates("session", ledger.events)).toEqual([]);
  });
});
