import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import type {
  AttesterRequest,
  ConsultRequest,
  PrincipalAttestation,
  PromptInput,
  RuntimeIdentityContext,
  RuntimeSession,
  RunResult,
} from "../../agape-ts/src/interp.ts";
import { Ledger, type LedgerEvent } from "../../agape-ts/src/runtime.ts";
import type { ProtectedEvidenceInspection } from "../../agape-ts/src/protected_evidence.ts";

export interface VerifiedApplicationUser {
  readonly issuer: string;
  readonly subject: string;
  readonly verified: true;
}

export interface RuntimeSessionOpenRequest {
  readonly sourceRef: string;
  readonly projectRoot: string;
  readonly identity: RuntimeIdentityContext;
  readonly onConsult: (request: ConsultRequest) => Promise<PrincipalAttestation | undefined>;
  readonly attesterVerifier: (request: AttesterRequest) => Promise<string | undefined>;
}

export interface RuntimeEvidenceInspectRequest {
  readonly identity: RuntimeIdentityContext;
  readonly evidenceRef: string;
  readonly decisionId: number;
}

export interface RuntimeSessionFactory {
  open(request: RuntimeSessionOpenRequest): Promise<RuntimeSession> | RuntimeSession;
  inspectEvidence?(request: RuntimeEvidenceInspectRequest): Promise<ProtectedEvidenceInspection>;
}

export interface PendingRuling {
  readonly requestId: string;
  readonly principal: string;
  readonly enumName: string;
  readonly variants: readonly string[];
  readonly scores: Readonly<Record<string, number>>;
  readonly margin: number;
  readonly agent?: string;
  readonly pendingTick: number;
  readonly ledgerHead: string;
}

export interface EndorsementCertificate {
  readonly kind: "agape.action-authorization-certificate.v1";
  readonly sessionId: string;
  readonly ledgerHead: string;
  readonly actionTick: number;
  readonly action: string;
  readonly argumentIndex: number;
  readonly requestHash: string;
  readonly argumentHash: string;
  readonly subjectHash: string;
  readonly ruleHash: string;
  readonly evidenceRef: string | null;
  readonly derivationPath: readonly string[];
  readonly endorsementTick: number;
  readonly decisionTick: number;
  readonly committed: string;
  readonly basis: string;
  readonly margin: number;
  readonly principalDecisionTick?: number;
  readonly principalAttestationVerified?: boolean;
}

export interface StudioRuntimeSessionView {
  readonly sessionId: string;
  readonly sessionLineageId: string;
  readonly conversationId: string;
  readonly projectSubject: string;
  readonly sourceRef: string;
  readonly user: VerifiedApplicationUser;
  readonly state: "ready" | "pending-ruling" | "closed";
  readonly pending?: PendingRuling;
  readonly ledger: readonly LedgerEvent[];
  readonly ledgerHead: string;
  readonly stdout: readonly string[];
  readonly warnings: RunResult["warnings"];
  readonly namedMemoryRecording: RunResult["namedMemoryRecording"];
  readonly certificates: readonly EndorsementCertificate[];
}

export interface CreatedStudioRuntimeSession extends StudioRuntimeSessionView {
  /** Opaque bearer capability. It is returned once and only its digest is retained. */
  readonly accessToken: string;
}

export interface CreateStudioRuntimeSessionRequest {
  readonly sourceRef: string;
  readonly projectRoot: string;
  readonly projectSubject: string;
  readonly user: VerifiedApplicationUser;
  readonly conversationId?: string;
  readonly initialPrompt?: PromptInput;
}

export interface RulingRequest {
  readonly sessionId: string;
  readonly accessToken: string;
  readonly requestId: string;
  readonly principal: string;
  readonly outcome: "decision" | "approve" | "deny" | "decline";
  readonly decision?: string;
}

export class RuntimeSessionApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

interface PendingInternal extends PendingRuling {
  readonly deferred: Deferred<PrincipalAttestation | undefined>;
}

interface ResolvedRuling {
  readonly requestId: string;
  readonly principal: string;
  readonly decision: string;
  readonly pendingTick: number;
}

interface SessionEntry {
  readonly sessionId: string;
  readonly sessionLineageId: string;
  readonly conversationId: string;
  readonly projectSubject: string;
  readonly sourceRef: string;
  readonly user: VerifiedApplicationUser;
  readonly accessTokenDigest: Buffer;
  session?: RuntimeSession;
  active?: Promise<RunResult>;
  pending?: PendingInternal;
  pendingVersion: number;
  waiters: Set<() => void>;
  usedRulings: Set<string>;
  resolvedRulings: Map<number, ResolvedRuling>;
  closed: boolean;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function digestToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

function tokenMatches(token: string, expected: Buffer): boolean {
  const actual = digestToken(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export function deriveStudioSessionLineageId(
  projectSubject: string,
  user: VerifiedApplicationUser,
  conversationId: string,
): string {
  const hash = createHash("sha256").update("agape.studio.session-lineage.v1", "utf8");
  for (const field of [projectSubject, user.issuer, user.subject, conversationId]) {
    const bytes = Buffer.from(field, "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length);
    hash.update(bytes);
  }
  return `studio-lineage-v1:${hash.digest("hex")}`;
}


function nonblank(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RuntimeSessionApiError(400, "invalid_request", `${label} must be a nonblank string`);
  }
  return value.trim();
}

function exactVariant(variants: readonly string[], requested: string): string | undefined {
  if (variants.includes(requested)) return requested;
  const folded = variants.filter((variant) => variant.toLowerCase() === requested.toLowerCase());
  return folded.length === 1 ? folded[0] : undefined;
}

function eventObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record);
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(record, key));
}

function canonicalReceiptJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalReceiptJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, member]) => member !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, member]) => `${JSON.stringify(key)}:${canonicalReceiptJson(member)}`)
    .join(",")}}`;
}

function receiptHash(value: unknown): string {
  return createHash("sha256").update(canonicalReceiptJson(value), "utf8").digest("hex");
}

const RECEIPT_HASH = /^[0-9a-f]{64}$/;
const RECEIPT_KEYS = [
  "action_tick", "action", "action_agent", "action_corr", "request_hash", "argument_index",
  "argument_hash", "derivation_path", "subject_hash", "endorsement_tick", "decision_id",
  "rule_hash", "evidence_ref",
] as const;
const AUTHORIZATION_BINDING_KEYS = [
  "argument_index", "argument_hash", "derivation_path", "subject_hash", "endorsement_tick",
  "decision_id", "rule_hash", "evidence_ref",
] as const;
const ENDORSED_KEYS = [
  "subject_commitment", "subject_hash", "decision_id", "variant", "rule_hash", "evidence_ref",
  "principal_event", "principal_request",
] as const;

function isCanonicalTypedCommitment(value: unknown): boolean {
  const record = eventObject(value);
  if (!record || typeof record.kind !== "string") return false;
  switch (record.kind) {
    case "text":
      return hasExactKeys(record, ["kind", "value"]) && typeof record.value === "string";
    case "int":
      return hasExactKeys(record, ["kind", "value"]) && Number.isSafeInteger(record.value);
    case "float":
      return hasExactKeys(record, ["kind", "value"])
        && typeof record.value === "number" && Number.isFinite(record.value);
    case "bool":
      return hasExactKeys(record, ["kind", "value"]) && typeof record.value === "boolean";
    case "null":
      return hasExactKeys(record, ["kind", "value"]) && record.value === null;
    case "enumval":
      return hasExactKeys(record, ["kind", "enum", "variant"])
        && typeof record.enum === "string" && typeof record.variant === "string";
    case "agentref":
      return hasExactKeys(record, ["kind", "name", "agent_type"])
        && typeof record.name === "string" && record.name.length > 0
        && typeof record.agent_type === "string" && record.agent_type.length > 0;
    case "taskref":
      return hasExactKeys(record, ["kind", "subject", "corr"])
        && typeof record.subject === "string" && record.subject.length > 0
        && Number.isSafeInteger(record.corr) && (record.corr as number) >= 0;
    case "struct": {
      const keys = Object.keys(record);
      const exact = keys.length === 2 && hasExactKeys(record, ["kind", "fields"])
        || keys.length === 3 && hasExactKeys(record, ["kind", "type", "fields"])
          && typeof record.type === "string";
      const fields = eventObject(record.fields);
      return exact && !!fields && Object.values(fields).every(isCanonicalTypedCommitment);
    }
    case "array":
      return hasExactKeys(record, ["kind", "items"])
        && Array.isArray(record.items) && record.items.every(isCanonicalTypedCommitment);
    default:
      return false;
  }
}

function projectedTypedCommitment(root: unknown, path: readonly string[]): unknown | undefined {
  let current = root;
  for (const segment of path) {
    const record = eventObject(current);
    if (!record || record.kind !== "struct") return undefined;
    const fields = eventObject(record.fields);
    if (!fields || !Object.prototype.hasOwnProperty.call(fields, segment)) return undefined;
    current = fields[segment];
  }
  return current;
}

function commitmentHash(value: unknown): string | undefined {
  const record = eventObject(value);
  if (!record) return undefined;
  const protectedKeys = ["content_hash", "protected_ref", "redaction_policy_hash"];
  const hasProtectedKey = protectedKeys.some((key) => Object.prototype.hasOwnProperty.call(record, key));
  if (!hasProtectedKey) return isCanonicalTypedCommitment(value) ? receiptHash(value) : undefined;
  if (Object.keys(record).length !== protectedKeys.length
    || !protectedKeys.every((key) => Object.prototype.hasOwnProperty.call(record, key))) return undefined;
  const contentHash = record.content_hash;
  const protectedRef = record.protected_ref;
  const redactionPolicyHash = record.redaction_policy_hash;
  if (typeof contentHash !== "string" || !RECEIPT_HASH.test(contentHash)
    || typeof protectedRef !== "string"
    || typeof redactionPolicyHash !== "string" || !RECEIPT_HASH.test(redactionPolicyHash)) return undefined;
  const expectedRef = `blob:sha256:${receiptHash({ kind: "protected-cognition", content_hash: contentHash })}`;
  const expectedPolicy = receiptHash({ policy: "protected-cognition-v1" });
  return protectedRef === expectedRef && redactionPolicyHash === expectedPolicy ? contentHash : undefined;
}

/** Validate exact ActionAuthorized -> action -> Endorsed -> Decided links. */
export function validatedEndorsementCertificates(
  sessionId: string,
  events: readonly LedgerEvent[],
): EndorsementCertificate[] {
  const ledger = Ledger.restore(events);
  const ledgerHead = ledger.head();
  const certificates: EndorsementCertificate[] = [];
  for (const receiptEvent of ledger.events) {
    if (receiptEvent.etype !== "ActionAuthorized") continue;
    const receipt = eventObject(receiptEvent.payload);
    const actionTick = receipt?.action_tick;
    if (!receipt || !hasExactKeys(receipt, RECEIPT_KEYS)) continue;
    const endorsementTick = receipt?.endorsement_tick;
    const decisionTick = receipt?.decision_id;
    const argumentIndex = receipt?.argument_index;
    const action = receipt?.action;
    const actionAgent = receipt?.action_agent;
    const actionCorr = receipt?.action_corr ?? null;
    const requestHash = receipt?.request_hash;
    const argumentHash = receipt?.argument_hash;
    const subjectHash = receipt?.subject_hash;
    const ruleHash = receipt?.rule_hash;
    const evidenceRef = receipt?.evidence_ref ?? null;
    const derivationPath = receipt?.derivation_path;
    if (![actionTick, endorsementTick, decisionTick, argumentIndex].every((value) => Number.isSafeInteger(value) && (value as number) >= 0)
      || typeof action !== "string" || action.length === 0
      || typeof actionAgent !== "string"
      || typeof requestHash !== "string" || !RECEIPT_HASH.test(requestHash)
      || typeof argumentHash !== "string" || !RECEIPT_HASH.test(argumentHash)
      || typeof subjectHash !== "string" || !RECEIPT_HASH.test(subjectHash)
      || typeof ruleHash !== "string" || !RECEIPT_HASH.test(ruleHash)
      || !(evidenceRef === null || typeof evidenceRef === "string")
      || !Array.isArray(derivationPath) || !derivationPath.every((part) => typeof part === "string")) continue;

    const actionEvent = ledger.events[actionTick as number];
    const actionPayload = eventObject(actionEvent?.payload);
    const actionArguments = actionPayload?.arguments;
    const argumentHashes = actionPayload?.argument_hashes;
    const argumentCommitments = actionPayload?.argument_commitments;
    const authorizationIndices = actionPayload?.authorization_argument_indices;
    const authorizationBindings = actionPayload?.authorization_bindings;
    const authorizationPosition = Array.isArray(authorizationIndices)
      ? authorizationIndices.indexOf(argumentIndex)
      : -1;
    const authorizationBinding = Array.isArray(authorizationBindings)
      ? eventObject(authorizationBindings[authorizationPosition])
      : undefined;
    const recomputedArgumentHashes = Array.isArray(argumentCommitments)
      ? argumentCommitments.map(commitmentHash)
      : [];
    const recomputedRequestHash = receiptHash({
      action, argument_hashes: recomputedArgumentHashes,
    });
    if (!actionEvent || actionEvent.etype !== action
      || receiptEvent.tick !== (actionTick as number) + 1 + authorizationPosition
      || actionEvent.subject !== receiptEvent.subject
      || actionEvent.agent !== actionAgent || receiptEvent.agent !== actionAgent
      || actionEvent.corr !== actionCorr || receiptEvent.corr !== actionTick
      || actionPayload?.request_hash !== requestHash
      || !Array.isArray(actionArguments) || !Array.isArray(argumentCommitments)
      || !Array.isArray(argumentHashes) || !Array.isArray(authorizationIndices)
      || !Array.isArray(authorizationBindings)
      || authorizationBindings.length !== authorizationIndices.length
      || actionArguments.length !== argumentCommitments.length
      || actionArguments.length !== argumentHashes.length
      || argumentHashes.length !== recomputedArgumentHashes.length
      || argumentHashes.some((hash) => typeof hash !== "string" || !RECEIPT_HASH.test(hash))
      || argumentHashes.some((hash, index) => hash !== recomputedArgumentHashes[index])
      || !authorizationIndices.every((index, position) => Number.isSafeInteger(index)
        && (index as number) >= 0
        && (index as number) < actionArguments.length
        && (position === 0 || (index as number) > (authorizationIndices[position - 1] as number)))
      || !authorizationIndices.includes(argumentIndex)
      || !authorizationIndices.every((index, offset) => {
        const sibling = ledger.events[(actionTick as number) + 1 + offset];
        const siblingPayload = eventObject(sibling?.payload);
        return sibling?.etype === "ActionAuthorized"
          && sibling.corr === actionTick
          && siblingPayload?.action_tick === actionTick
          && siblingPayload?.argument_index === index;
      })
      || !authorizationBinding || !hasExactKeys(authorizationBinding, AUTHORIZATION_BINDING_KEYS)
      || authorizationBinding?.argument_index !== argumentIndex
      || authorizationBinding?.argument_hash !== argumentHash
      || receiptHash(authorizationBinding?.derivation_path) !== receiptHash(derivationPath)
      || authorizationBinding?.subject_hash !== subjectHash
      || authorizationBinding?.endorsement_tick !== endorsementTick
      || authorizationBinding?.decision_id !== decisionTick
      || authorizationBinding?.rule_hash !== ruleHash
      || (authorizationBinding?.evidence_ref ?? null) !== evidenceRef
      || requestHash !== recomputedRequestHash
      || (argumentIndex as number) >= actionArguments.length
      || argumentHashes[argumentIndex as number] !== argumentHash) continue;

    const endorsementEvent = ledger.events[endorsementTick as number];
    if (!endorsementEvent || endorsementEvent.etype !== "Endorsed"
      || (endorsementTick as number) >= (actionTick as number)) continue;
    const payload = eventObject(endorsementEvent.payload);
    if (!payload || !hasExactKeys(payload, ENDORSED_KEYS)) continue;
    const recomputedSubjectHash = commitmentHash(payload?.subject_commitment);
    const projectedSubject = derivationPath.length === 0
      ? payload?.subject_commitment
      : projectedTypedCommitment(payload?.subject_commitment, derivationPath as string[]);
    if (projectedSubject === undefined || commitmentHash(projectedSubject) !== argumentHash) continue;
    const decidedEvent = ledger.events[decisionTick as number];
    if (!decidedEvent || decidedEvent.etype !== "Decided") continue;
    const decided = eventObject(decidedEvent.payload);
    const committed = decided?.committed;
    const basis = decided?.basis;
    const margin = decided?.margin;
    if (
      payload?.subject_hash !== subjectHash
      || recomputedSubjectHash !== subjectHash
      || payload?.decision_id !== decisionTick
      || payload?.variant !== committed
      || payload?.rule_hash !== ruleHash
      || payload?.evidence_ref !== evidenceRef
      || payload?.principal_event !== decided?.principal_event
      || payload?.principal_request !== decided?.principal_request
      || decided?.decision_id !== decisionTick
      || (decisionTick as number) >= endorsementEvent.tick
      || decidedEvent.agent !== endorsementEvent.agent
      || decided?.rule_hash !== ruleHash
      || decided?.rule === undefined
      || receiptHash(decided.rule) !== ruleHash
      || decided?.evidence_ref !== evidenceRef
      || typeof committed !== "string"
      || committed === "abstained"
      || typeof basis !== "string"
      || typeof margin !== "number"
      || !Number.isFinite(margin)
    ) continue;

    let principalDecisionTick: number | undefined;
    let principalAttestationVerified: boolean | undefined;
    if (basis === "Principal") {
      const candidate = decided.principal_event;
      if (!Number.isSafeInteger(candidate) || (candidate as number) < 0) continue;
      const ruling = ledger.events[candidate as number];
      const rulingPayload = eventObject(ruling?.payload);
      if (!ruling || ruling.etype !== "PrincipalDecision" || rulingPayload?.ruled_variant !== committed || (candidate as number) >= (decisionTick as number)) continue;
      const principalRequest = decided.principal_request;
      const pendingTick = rulingPayload.corr;
      if (!Number.isSafeInteger(pendingTick) || (pendingTick as number) >= (candidate as number)) continue;
      const pending = ledger.events[pendingTick as number];
      if (!pending || pending.etype !== "PendingPrincipalDecision") continue;
      if (pending.subject !== ruling.subject || pending.corr !== pending.tick) continue;
      if (ruling.corr !== pendingTick) continue;
      const pendingPayload = eventObject(pending.payload);
      if (typeof principalRequest !== "string" || !RECEIPT_HASH.test(principalRequest)
        || pendingPayload?.request_hash !== principalRequest
        || rulingPayload.request_hash !== principalRequest
        || pendingPayload?.corr !== pendingTick
        || rulingPayload.corr !== pendingTick
        || pendingPayload?.who !== pending.subject
        || rulingPayload.who !== pendingPayload.who
        || rulingPayload.evidence_hash !== pendingPayload.evidence_hash
        || rulingPayload.governed_request_hash !== pendingPayload.governed_request_hash
        || receiptHash({ domain: "agape/principal-request/v1", request: {
          corr: pendingPayload.corr,
          who: pendingPayload.who,
          credence_id: pendingPayload.credence_id,
          evidence_hash: pendingPayload.evidence_hash,
          rule_hash: pendingPayload.rule_hash,
          subject_hash: pendingPayload.subject_hash,
          governed_operation: pendingPayload.governed_operation,
          governed_request_hash: pendingPayload.governed_request_hash,
        } }) !== principalRequest) continue;
      const attestation = eventObject(rulingPayload.attestation);
      principalDecisionTick = candidate as number;
      principalAttestationVerified = attestation?.attester_verification === "verified";
      if (!principalAttestationVerified) continue;
    }

    certificates.push(Object.freeze({
      kind: "agape.action-authorization-certificate.v1",
      sessionId,
      ledgerHead,
      actionTick: actionTick as number,
      action,
      argumentIndex: argumentIndex as number,
      requestHash,
      argumentHash,
      subjectHash,
      ruleHash,
      evidenceRef,
      derivationPath: Object.freeze([...(derivationPath as string[])]),
      endorsementTick: endorsementEvent.tick,
      decisionTick: decisionTick as number,
      committed,
      basis,
      margin,
      ...(principalDecisionTick === undefined ? {} : { principalDecisionTick, principalAttestationVerified }),
    }));
  }
  return certificates.filter((certificate) => {
    const action = ledger.events[certificate.actionTick];
    const expected = eventObject(action?.payload)?.authorization_argument_indices;
    if (!Array.isArray(expected)) return false;
    const actionReceipts = ledger.events.filter((event) => {
      const payload = eventObject(event.payload);
      return event.etype === "ActionAuthorized" && payload?.action_tick === certificate.actionTick;
    });
    const group = certificates
      .filter((candidate) => candidate.actionTick === certificate.actionTick)
      .sort((left, right) => left.argumentIndex - right.argumentIndex);
    return actionReceipts.length === expected.length
      && group.length === expected.length
      && group.every((candidate, index) => candidate.argumentIndex === expected[index]);
  });
}

export class StudioRuntimeSessionRegistry {
  private readonly entries = new Map<string, SessionEntry>();
  private readonly signingKey = randomBytes(32);

  constructor(
    private readonly factory: RuntimeSessionFactory,
    private readonly principalAuthorization: (user: VerifiedApplicationUser, principal: string) => boolean = () => true,
  ) {}

  async create(request: CreateStudioRuntimeSessionRequest): Promise<CreatedStudioRuntimeSession> {
    const sourceRef = nonblank(request.sourceRef, "sourceRef");
    const projectRoot = nonblank(request.projectRoot, "projectRoot");
    const projectSubject = nonblank(request.projectSubject, "projectSubject");
    const user = request.user;
    if (user?.verified !== true || !user.issuer?.trim() || !user.subject?.trim()) {
      throw new RuntimeSessionApiError(401, "unverified_application_user", "a host-verified application user is required");
    }
    const sessionId = randomUUID();
    const conversationId = request.conversationId === undefined ? randomUUID() : nonblank(request.conversationId, "conversationId");
    const sessionLineageId = deriveStudioSessionLineageId(projectSubject, user, conversationId);
    const accessToken = randomBytes(32).toString("base64url");
    const entry: SessionEntry = {
      sessionId,
      sessionLineageId,
      conversationId,
      projectSubject,
      sourceRef,
      user: Object.freeze({ issuer: user.issuer, subject: user.subject, verified: true }),
      accessTokenDigest: digestToken(accessToken),
      pendingVersion: 0,
      waiters: new Set(),
      usedRulings: new Set(),
      resolvedRulings: new Map(),
      closed: false,
    };
    this.entries.set(sessionId, entry);
    try {
      entry.session = await this.factory.open({
        sourceRef,
        projectRoot,
        identity: {
          projectSubject,
          sessionLineageId,
          sessionId,
          conversationId,
          user: entry.user,
        },
        onConsult: async (consult) => this.pauseForRuling(entry, consult),
        attesterVerifier: async (attester) => this.verifyAttester(entry, attester),
      });
      let view = await this.begin(entry, () => entry.session!.start());
      if (request.initialPrompt && view.state === "ready") {
        view = await this.begin(entry, () => entry.session!.sendPrompt(request.initialPrompt!));
      }
      return { ...view, accessToken };
    } catch (error) {
      this.entries.delete(sessionId);
      if (entry.session) {
        try { await entry.session.close(); }
        catch { /* preserve the original creation/start failure */ }
      }
      throw error;
    }
  }

  async sendPrompt(sessionId: string, accessToken: string, input: PromptInput): Promise<StudioRuntimeSessionView> {
    const entry = this.authenticatedEntry(sessionId, accessToken);
    if (entry.closed) throw new RuntimeSessionApiError(409, "session_closed", "runtime session is closed");
    if (entry.pending) throw new RuntimeSessionApiError(409, "ruling_pending", "resolve the pending ruling before sending another prompt");
    return this.begin(entry, () => entry.session!.sendPrompt(input));
  }

  inspect(sessionId: string, accessToken: string): StudioRuntimeSessionView {
    return this.view(this.authenticatedEntry(sessionId, accessToken));
  }

  async inspectEvidence(
    sessionId: string,
    accessToken: string,
    evidenceRef: string,
    decisionId: number,
  ): Promise<ProtectedEvidenceInspection> {
    const entry = this.authenticatedEntry(sessionId, accessToken);
    if (typeof evidenceRef !== "string" || !evidenceRef.trim() || !Number.isSafeInteger(decisionId) || decisionId < 0) {
      throw new RuntimeSessionApiError(400, "invalid_evidence_request", "evidenceRef and a nonnegative decisionId are required");
    }
    const event = entry.session!.snapshot().ledger.events[decisionId];
    const payload = eventObject(event?.payload);
    if (
      !event
      || event.etype !== "Decided"
      || event.tick !== decisionId
      || payload?.decision_id !== decisionId
      || payload?.evidence_ref !== evidenceRef
    ) {
      throw new RuntimeSessionApiError(409, "evidence_mismatch", "evidence reference is not bound to this session decision");
    }
    if (!this.factory.inspectEvidence) {
      throw new RuntimeSessionApiError(404, "evidence_unavailable", "protected evidence inspection is unavailable for this runtime session");
    }
    return this.factory.inspectEvidence({
      identity: this.identity(entry),
      evidenceRef,
      decisionId,
    });
  }

  async rule(request: RulingRequest): Promise<StudioRuntimeSessionView> {
    const entry = this.authenticatedEntry(request.sessionId, request.accessToken);
    if (entry.usedRulings.has(request.requestId)) {
      throw new RuntimeSessionApiError(409, "duplicate_ruling", "this ruling request has already been resolved");
    }
    const pending = entry.pending;
    if (!pending || pending.requestId !== request.requestId) {
      throw new RuntimeSessionApiError(409, "stale_ruling", "the ruling request is no longer pending for this session");
    }
    if (request.principal !== pending.principal) {
      throw new RuntimeSessionApiError(403, "wrong_principal", "the ruling principal does not match the pending decision");
    }
    if (!this.principalAuthorization(entry.user, pending.principal)) {
      throw new RuntimeSessionApiError(403, "principal_not_authorized", "the application user is not authorized for this principal");
    }
    let attestation: PrincipalAttestation | undefined;
    if (request.outcome !== "decline") {
      const requested = request.outcome === "approve" ? "approve"
        : request.outcome === "deny" ? "deny"
        : nonblank(request.decision, "decision");
      const decision = exactVariant(pending.variants, requested);
      if (!decision) {
        throw new RuntimeSessionApiError(422, "invalid_ruling", `decision must be one of: ${pending.variants.join(", ")}`);
      }
      const ruling = {
        requestId: pending.requestId,
        principal: pending.principal,
        decision,
        pendingTick: pending.pendingTick,
      };
      const attester = this.signAttester(entry, ruling);
      entry.resolvedRulings.set(pending.pendingTick, ruling);
      attestation = {
        principal: pending.principal,
        decision,
        attester,
        signature: attester.split(".").at(-1),
        application_user: entry.user,
        pending_tick: pending.pendingTick,
        request_id: pending.requestId,
      };
    }
    entry.usedRulings.add(pending.requestId);
    entry.pending = undefined;
    pending.deferred.resolve(attestation);
    this.notify(entry);
    return this.awaitActive(entry, entry.pendingVersion);
  }

  async close(sessionId: string, accessToken: string): Promise<StudioRuntimeSessionView> {
    const entry = this.authenticatedEntry(sessionId, accessToken);
    if (entry.pending) throw new RuntimeSessionApiError(409, "ruling_pending", "decline or decide the pending ruling before closing");
    if (entry.active) throw new RuntimeSessionApiError(409, "session_busy", "the runtime session is still processing");
    if (!entry.closed) {
      await entry.session!.close();
      entry.closed = true;
    }
    return this.view(entry);
  }

  private async begin(entry: SessionEntry, operation: () => Promise<RunResult>): Promise<StudioRuntimeSessionView> {
    if (entry.active) throw new RuntimeSessionApiError(409, "session_busy", "the runtime session already has an active operation");
    const active = operation();
    entry.active = active;
    return this.awaitActive(entry, entry.pendingVersion);
  }

  private async awaitActive(entry: SessionEntry, observedPendingVersion: number): Promise<StudioRuntimeSessionView> {
    const active = entry.active;
    if (!active) return this.view(entry);
    for (;;) {
      if (entry.pending && entry.pendingVersion > observedPendingVersion) return this.view(entry);
      const changed = new Promise<{ kind: "changed" }>((resolve) => {
        const waiter = () => resolve({ kind: "changed" });
        entry.waiters.add(waiter);
        active.finally(() => entry.waiters.delete(waiter)).catch(() => undefined);
      });
      const result = await Promise.race([
        active.then((value) => ({ kind: "complete" as const, value }), (error) => ({ kind: "error" as const, error })),
        changed,
      ]);
      if (result.kind === "changed") continue;
      if (entry.active === active) entry.active = undefined;
      if (result.kind === "error") throw result.error;
      return this.view(entry, result.value);
    }
  }

  private async pauseForRuling(entry: SessionEntry, consult: ConsultRequest): Promise<PrincipalAttestation | undefined> {
    if (entry.pending) throw new RuntimeSessionApiError(409, "nested_ruling", "a second ruling was requested before the first resolved");
    if (!this.principalAuthorization(entry.user, consult.principal)) {
      return undefined;
    }
    const snapshot = entry.session!.snapshot();
    const pendingEvent = [...snapshot.ledger.events].reverse().find((event) =>
      event.etype === "PendingPrincipalDecision" && event.subject === consult.principal);
    if (!pendingEvent || pendingEvent.corr !== pendingEvent.tick) {
      throw new Error("runtime consultation is missing its durable PendingPrincipalDecision receipt");
    }
    const wait = deferred<PrincipalAttestation | undefined>();
    entry.pendingVersion++;
    entry.pending = Object.freeze({
      requestId: randomUUID(),
      principal: consult.principal,
      enumName: consult.enumName,
      variants: Object.freeze([...consult.variants]),
      scores: Object.freeze({ ...consult.scores }),
      margin: consult.margin,
      ...(consult.agent ? { agent: consult.agent } : {}),
      pendingTick: pendingEvent.tick,
      ledgerHead: snapshot.ledger.head(),
      deferred: wait,
    });
    this.notify(entry);
    return wait.promise;
  }

  private signAttester(entry: SessionEntry, ruling: ResolvedRuling): string {
    const payload = Buffer.from(JSON.stringify({
      version: 1,
      sessionId: entry.sessionId,
      sessionLineageId: entry.sessionLineageId,
      conversationId: entry.conversationId,
      projectSubject: entry.projectSubject,
      user: entry.user,
      ...ruling,
    }), "utf8").toString("base64url");
    const signature = createHmac("sha256", this.signingKey).update(payload, "utf8").digest("base64url");
    return `agape-studio-attester.v1.${payload}.${signature}`;
  }

  private async verifyAttester(entry: SessionEntry, request: AttesterRequest): Promise<string | undefined> {
    if (request.binding.driver !== "host") return undefined;
    if (typeof request.attester !== "string") return undefined;
    const parts = request.attester.split(".");
    if (parts.length !== 4 || parts[0] !== "agape-studio-attester" || parts[1] !== "v1") return undefined;
    const payload = parts[2]!;
    const supplied = Buffer.from(parts[3]!, "utf8");
    const expected = Buffer.from(createHmac("sha256", this.signingKey).update(payload, "utf8").digest("base64url"), "utf8");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return undefined;
    let decoded: Record<string, unknown>;
    try {
      decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch {
      return undefined;
    }
    const resolved = entry.resolvedRulings.get(request.corr);
    if (
      !resolved
      || decoded.version !== 1
      || decoded.sessionId !== entry.sessionId
      || decoded.sessionLineageId !== entry.sessionLineageId
      || decoded.conversationId !== entry.conversationId
      || decoded.projectSubject !== entry.projectSubject
      || decoded.requestId !== resolved.requestId
      || decoded.principal !== resolved.principal
      || decoded.decision !== resolved.decision
      || decoded.pendingTick !== resolved.pendingTick
      || request.corr !== resolved.pendingTick
      || request.principal !== resolved.principal
    ) return undefined;
    const encodedUser = eventObject(decoded.user);
    if (encodedUser?.verified !== true || encodedUser.issuer !== entry.user.issuer || encodedUser.subject !== entry.user.subject) return undefined;
    if (!this.principalAuthorization(entry.user, request.principal)) return undefined;
    return request.principal;
  }

  private authenticatedEntry(sessionId: string, accessToken: string): SessionEntry {
    const entry = this.entries.get(sessionId);
    if (!entry || typeof accessToken !== "string" || !tokenMatches(accessToken, entry.accessTokenDigest)) {
      throw new RuntimeSessionApiError(401, "invalid_session_capability", "invalid runtime-session capability");
    }
    return entry;
  }

  private identity(entry: SessionEntry): RuntimeIdentityContext {
    return {
      projectSubject: entry.projectSubject,
      sessionLineageId: entry.sessionLineageId,
      sessionId: entry.sessionId,
      conversationId: entry.conversationId,
      user: entry.user,
    };
  }

  private notify(entry: SessionEntry): void {
    for (const waiter of entry.waiters) waiter();
    entry.waiters.clear();
  }

  private view(entry: SessionEntry, result?: RunResult): StudioRuntimeSessionView {
    const snapshot = result ?? entry.session!.snapshot();
    return {
      sessionId: entry.sessionId,
      sessionLineageId: entry.sessionLineageId,
      conversationId: entry.conversationId,
      projectSubject: entry.projectSubject,
      sourceRef: entry.sourceRef,
      user: entry.user,
      state: entry.closed ? "closed" : entry.pending ? "pending-ruling" : "ready",
      ...(entry.pending ? { pending: this.publicPending(entry.pending) } : {}),
      ledger: snapshot.ledger.events,
      ledgerHead: snapshot.ledger.head(),
      stdout: snapshot.stdout,
      warnings: snapshot.warnings,
      namedMemoryRecording: snapshot.namedMemoryRecording,
      certificates: validatedEndorsementCertificates(entry.sessionId, snapshot.ledger.events),
    };
  }

  private publicPending(pending: PendingInternal): PendingRuling {
    const { deferred: _deferred, ...view } = pending;
    return view;
  }
}
