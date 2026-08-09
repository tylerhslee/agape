import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { link as createLink, mkdir, open, readFile, readdir, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";

import { snapshotCanonicalPayload } from "./ledger_hash.js";

export type ProtectedEvidenceOperation = "inspect" | "export" | "delete";

export interface JudgmentEvidenceToken {
  token: string;
  logprob: number;
  bytes: number[] | null;
}

export interface JudgmentEvidenceCandidate {
  content: string;
  variant: string | null;
  tokens: JudgmentEvidenceToken[];
  aggregate_logprob: number;
  aggregate_score: number;
  finish_reason: string | null;
}

/** Exact provider evidence retained by an advertised calibration profile. */
export interface JudgmentEvidence {
  version: 1;
  method: "bounded-complete-sequence-logprobs";
  connector: string;
  enum_name: string;
  enum_variants: string[];
  candidate_bound: number;
  candidates: JudgmentEvidenceCandidate[];
  mapping_version: "exact-enum-v1";
  normalization_version: "matched-sequence-mass-v1";
  gate_scores: Record<string, number>;
}

export interface JudgmentEvidenceLink {
  evidence_id: string;
  evidence_hash: string;
  evidence_ref: string;
  gate_scores: Record<string, number>;
}

export interface JudgmentEvidenceDecisionBinding {
  decision_id: number;
  winner: string;
  runner_up: string | null;
  threshold: number;
  required_margin: number;
  floor: number;
  actual_margin: number;
  passed: boolean;
}

interface EvidenceRecord {
  kind: "agape-protected-judgment-evidence";
  version: 1;
  owner_principal: string;
  scope: string;
  retention: "durable-until-explicit-delete";
  link: JudgmentEvidenceLink;
  evidence: JudgmentEvidence;
}

interface BindingRecord {
  kind: "agape-protected-judgment-binding";
  version: 1;
  evidence_ref: string;
  binding: JudgmentEvidenceDecisionBinding;
}

interface DeletionRecord {
  kind: "agape-protected-judgment-deletion";
  version: 1;
  owner_principal: string;
  evidence_ref: string;
  decision_id: number;
}

interface AuthorizationClaims {
  kind: "agape-protected-evidence-authorization";
  version: 1;
  requester: string;
  operation: ProtectedEvidenceOperation;
  evidence_ref: string;
  decision_id: number;
  expires_at: number;
  nonce: string;
}

export interface ProtectedEvidenceRequest {
  requester: string;
  authorization: string;
  evidence_ref: string;
  decision_id: number;
}

export interface ProtectedEvidenceInspection extends JudgmentEvidence, JudgmentEvidenceDecisionBinding {
  evidence_id: string;
  evidence_hash: string;
  evidence_ref: string;
  retention: "durable-until-explicit-delete";
}

export interface ProtectedEvidenceExport {
  kind: "agape-protected-evidence-export";
  version: 1;
  requester: string;
  evidence: ProtectedEvidenceInspection;
  proof: string;
}

export class ProtectedEvidenceError extends Error {
  constructor(readonly code: "Forbidden" | "EvidenceMismatch" | "EvidenceUnavailable", message: string) {
    super(message);
    this.name = code;
  }
}

export interface FileProtectedEvidenceStoreOptions {
  root: string;
  /** 32-byte host secret; never source or manifest data. */
  key: Uint8Array;
  /** Principal already authenticated by the host transport/session. */
  authenticatedPrincipal: string;
  now?: () => number;
  /** Test/host fault seam after the durable deletion marker commits. */
  afterDeletionMarker?: () => void | Promise<void>;
  /** Test/host scheduling seam immediately before an inspection linearizes. */
  beforeInspectionFinalCheck?: () => void | Promise<void>;
}

const REF_PREFIX = "protected:evidence:v1:";
const AUTH_TTL_MS = 5 * 60_000;

export class FileProtectedEvidenceStore {
  readonly #root: string;
  readonly #encryptionKey: Buffer;
  readonly #referenceKey: Buffer;
  readonly #authorizationKey: Buffer;
  readonly #exportKey: Buffer;
  readonly #principal: string;
  readonly #now: () => number;
  readonly #afterDeletionMarker: (() => void | Promise<void>) | undefined;
  readonly #beforeInspectionFinalCheck: (() => void | Promise<void>) | undefined;
  #closed = false;

  private constructor(options: FileProtectedEvidenceStoreOptions) {
    const rootKey = Buffer.from(options.key);
    if (rootKey.length !== 32) throw new TypeError("protected evidence key must contain exactly 32 bytes");
    this.#principal = requiredText(options.authenticatedPrincipal, "authenticatedPrincipal");
    const namespace = createHmac("sha256", derive(rootKey, "namespace"))
      .update("agape/protected-evidence/principal/v1\0", "utf8")
      .update(this.#principal, "utf8")
      .digest("base64url");
    this.#root = join(options.root, "principal-" + namespace);
    this.#encryptionKey = derive(rootKey, "encryption");
    this.#referenceKey = derive(rootKey, "reference");
    this.#authorizationKey = derive(rootKey, "authorization");
    this.#exportKey = derive(rootKey, "export");
    this.#now = options.now ?? Date.now;
    this.#afterDeletionMarker = options.afterDeletionMarker;
    this.#beforeInspectionFinalCheck = options.beforeInspectionFinalCheck;
  }

  static async open(options: FileProtectedEvidenceStoreOptions): Promise<FileProtectedEvidenceStore> {
    const store = new FileProtectedEvidenceStore(options);
    await mkdir(store.#root, { recursive: true, mode: 0o700 });
    const rootStat = await stat(store.#root);
    if (!rootStat.isDirectory()) throw new Error("protected evidence root must be a directory");
    await store.#reconcileDeletions();
    return store;
  }

  async retain(input: {
    evidence: JudgmentEvidence;
    ownerPrincipal: string;
    scope: string;
    replay?: boolean;
  }): Promise<JudgmentEvidenceLink> {
    this.#assertOpen();
    const ownerPrincipal = requiredText(input.ownerPrincipal, "ownerPrincipal");
    if (ownerPrincipal !== this.#principal) throw new ProtectedEvidenceError("Forbidden", "evidence owner is not the authenticated principal");
    const scope = requiredText(input.scope, "scope");
    const evidence = validateEvidence(input.evidence);
    const evidenceHash = sha256(stableJson(evidence));
    const id = createHmac("sha256", this.#referenceKey)
      .update("agape/protected-evidence/ref/v1\0", "utf8")
      .update(ownerPrincipal, "utf8")
      .update("\0", "utf8")
      .update(scope, "utf8")
      .update("\0", "utf8")
      .update(evidenceHash, "utf8")
      .digest("base64url");
    const link: JudgmentEvidenceLink = Object.freeze({
      evidence_id: id,
      evidence_hash: evidenceHash,
      evidence_ref: REF_PREFIX + id,
      gate_scores: evidence.gate_scores,
    });
    await this.#assertNotDeleted(link.evidence_ref);
    const record: EvidenceRecord = {
      kind: "agape-protected-judgment-evidence",
      version: 1,
      owner_principal: ownerPrincipal,
      scope,
      retention: "durable-until-explicit-delete",
      link,
      evidence,
    };
    const path = this.#evidencePath(link.evidence_ref);
    const existing = await this.#readOptional<EvidenceRecord>(path, "evidence");
    if (existing) {
      if (!constantJsonEqual(existing, record)) throw new ProtectedEvidenceError("EvidenceMismatch", "protected evidence reference collides with different content");
    } else {
      if (input.replay) throw new ProtectedEvidenceError("EvidenceUnavailable", "replay cannot create missing protected evidence");
      await this.#atomicCreate(path, record, "evidence");
    }
    await this.#finalDeletionCheck(link.evidence_ref, true);
    return link;
  }

  async bindDecision(evidenceRef: string, bindingInput: JudgmentEvidenceDecisionBinding, replay = false): Promise<void> {
    this.#assertOpen();
    await this.#assertNotDeleted(evidenceRef);
    const evidence = await this.#loadEvidence(evidenceRef);
    this.#assertOwner(evidence);
    const binding = validateBinding(bindingInput, evidence.evidence);
    const record: BindingRecord = {
      kind: "agape-protected-judgment-binding",
      version: 1,
      evidence_ref: evidenceRef,
      binding,
    };
    const path = this.#bindingPath(evidenceRef);
    const existing = await this.#readOptional<BindingRecord>(path, "binding");
    if (existing) {
      if (!constantJsonEqual(existing, record)) throw new ProtectedEvidenceError("EvidenceMismatch", "evidence is already bound to a different decision");
    } else {
      if (replay) throw new ProtectedEvidenceError("EvidenceUnavailable", "replay cannot create a missing evidence decision binding");
      await this.#atomicCreate(path, record, "binding");
    }
    await this.#finalDeletionCheck(evidenceRef, true);
  }

  issueAuthorization(input: {
    requester: string;
    operation: ProtectedEvidenceOperation;
    evidence_ref: string;
    decision_id: number;
    expires_at?: number;
  }): string {
    this.#assertOpen();
    const requester = requiredText(input.requester, "requester");
    if (requester !== this.#principal) throw new ProtectedEvidenceError("Forbidden", "requester is not the authenticated principal");
    const claims: AuthorizationClaims = {
      kind: "agape-protected-evidence-authorization",
      version: 1,
      requester,
      operation: input.operation,
      evidence_ref: parseRef(input.evidence_ref).ref,
      decision_id: safeNonnegativeInteger(input.decision_id, "decision_id"),
      expires_at: input.expires_at ?? this.#now() + AUTH_TTL_MS,
      nonce: randomBytes(16).toString("base64url"),
    };
    if (!Number.isSafeInteger(claims.expires_at) || claims.expires_at <= this.#now()) {
      throw new TypeError("authorization expires_at must be a future safe-integer epoch millisecond");
    }
    const body = Buffer.from(stableJson(claims), "utf8").toString("base64url");
    return body + "." + mac(this.#authorizationKey, "authorization", body);
  }

  async authorize(input: {
    requester: string;
    operation: ProtectedEvidenceOperation;
    evidence_ref: string;
    decision_id: number;
    expires_at?: number;
  }): Promise<string> {
    this.#assertOpen();
    const requester = requiredText(input.requester, "requester");
    if (requester !== this.#principal) {
      throw new ProtectedEvidenceError("Forbidden", "requester is not the authenticated principal");
    }
    await this.#assertNotDeleted(input.evidence_ref);
    const evidence = await this.#loadEvidence(input.evidence_ref);
    this.#assertOwner(evidence);
    const binding = await this.#loadBinding(input.evidence_ref, evidence.evidence);
    if (binding.binding.decision_id !== input.decision_id) {
      throw new ProtectedEvidenceError("EvidenceMismatch", "evidence reference is not bound to the requested decision");
    }
    const authorization = this.issueAuthorization(input);
    await this.#finalDeletionCheck(input.evidence_ref);
    return authorization;
  }

  async inspect(request: ProtectedEvidenceRequest): Promise<ProtectedEvidenceInspection> {
    this.#authorize(request, "inspect");
    const evidence = await this.#inspectAuthorized(request);
    await this.#beforeInspectionFinalCheck?.();
    await this.#finalDeletionCheck(request.evidence_ref);
    return evidence;
  }

  async export(request: ProtectedEvidenceRequest): Promise<ProtectedEvidenceExport> {
    this.#authorize(request, "export");
    const evidence = await this.#inspectAuthorized(request);
    const body = {
      kind: "agape-protected-evidence-export" as const,
      version: 1 as const,
      requester: request.requester,
      evidence,
    };
    const exported = { ...body, proof: mac(this.#exportKey, "export", stableJson(body)) };
    await this.#finalDeletionCheck(request.evidence_ref);
    return exported;
  }

  verifyExport(value: ProtectedEvidenceExport): boolean {
    try {
      if (value.kind !== "agape-protected-evidence-export" || value.version !== 1
        || value.requester !== this.#principal || typeof value.proof !== "string") return false;
      const { proof, ...body } = value;
      return safeEqualHex(proof, mac(this.#exportKey, "export", stableJson(body)));
    } catch {
      return false;
    }
  }

  async delete(request: ProtectedEvidenceRequest): Promise<void> {
    this.#authorize(request, "delete");
    await this.#inspectAuthorized(request);
    const deletion: DeletionRecord = {
      kind: "agape-protected-judgment-deletion",
      version: 1,
      owner_principal: this.#principal,
      evidence_ref: request.evidence_ref,
      decision_id: request.decision_id,
    };
    try {
      await this.#atomicCreate(this.#deletionPath(request.evidence_ref), deletion, "deletion");
    } catch (error) {
      if (await this.#isDeleted(request.evidence_ref)) {
        throw new ProtectedEvidenceError("EvidenceUnavailable", "protected evidence has been deleted");
      }
      throw error;
    }
    await this.#afterDeletionMarker?.();
    await this.#cleanupDeleted(request.evidence_ref);
  }

  /** Exact-address lookup for diagnostics/tests; this surface cannot enumerate other refs. */
  artifactPaths(evidenceRef: string): { evidence: string; binding: string; deletion: string } {
    parseRef(evidenceRef);
    return {
      evidence: this.#evidencePath(evidenceRef), binding: this.#bindingPath(evidenceRef),
      deletion: this.#deletionPath(evidenceRef),
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#encryptionKey.fill(0);
    this.#referenceKey.fill(0);
    this.#authorizationKey.fill(0);
    this.#exportKey.fill(0);
  }

  async #inspectAuthorized(request: ProtectedEvidenceRequest): Promise<ProtectedEvidenceInspection> {
    this.#assertOpen();
    await this.#assertNotDeleted(request.evidence_ref);
    const evidence = await this.#loadEvidence(request.evidence_ref);
    this.#assertOwner(evidence);
    const binding = await this.#loadBinding(request.evidence_ref, evidence.evidence);
    if (binding.binding.decision_id !== request.decision_id) {
      throw new ProtectedEvidenceError("EvidenceMismatch", "evidence reference is not bound to the requested decision");
    }
    return snapshotCanonicalPayload({
      ...evidence.evidence,
      evidence_id: evidence.link.evidence_id,
      evidence_hash: evidence.link.evidence_hash,
      evidence_ref: evidence.link.evidence_ref,
      retention: evidence.retention,
      ...binding.binding,
    }) as ProtectedEvidenceInspection;
  }

  #authorize(request: ProtectedEvidenceRequest, operation: ProtectedEvidenceOperation): void {
    const requester = requiredText(request.requester, "requester");
    if (requester !== this.#principal) throw new ProtectedEvidenceError("Forbidden", "requester is not the authenticated principal");
    const [body, signature, extra] = request.authorization.split(".");
    if (!body || !signature || extra !== undefined || !safeEqualHex(signature, mac(this.#authorizationKey, "authorization", body))) {
      throw new ProtectedEvidenceError("Forbidden", "authorization authentication failed");
    }
    let claims: AuthorizationClaims;
    try {
      claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as AuthorizationClaims;
    } catch {
      throw new ProtectedEvidenceError("Forbidden", "authorization payload is invalid");
    }
    const exact: AuthorizationClaims = {
      kind: "agape-protected-evidence-authorization",
      version: 1,
      requester,
      operation,
      evidence_ref: requiredText(request.evidence_ref, "evidence_ref"),
      decision_id: safeNonnegativeInteger(request.decision_id, "decision_id"),
      expires_at: claims.expires_at,
      nonce: claims.nonce,
    };
    if (!constantJsonEqual(claims, exact) || !Number.isSafeInteger(claims.expires_at) || claims.expires_at <= this.#now()) {
      throw new ProtectedEvidenceError("Forbidden", "authorization does not cover this request");
    }
  }

  #assertOwner(record: EvidenceRecord): void {
    if (record.owner_principal !== this.#principal) throw new ProtectedEvidenceError("Forbidden", "protected evidence is not visible to the authenticated principal");
  }

  async #loadEvidence(ref: string): Promise<EvidenceRecord> {
    const value = await this.#readOptional<EvidenceRecord>(this.#evidencePath(ref), "evidence");
    if (!value) throw new ProtectedEvidenceError("EvidenceUnavailable", "protected evidence is unavailable");
    if (value.kind !== "agape-protected-judgment-evidence" || value.version !== 1 || value.link.evidence_ref !== ref) {
      throw new ProtectedEvidenceError("EvidenceMismatch", "protected evidence envelope is invalid");
    }
    validateEvidence(value.evidence);
    const hash = sha256(stableJson(value.evidence));
    if (hash !== value.link.evidence_hash) throw new ProtectedEvidenceError("EvidenceMismatch", "protected evidence commitment does not match its contents");
    return value;
  }

  async #loadBinding(ref: string, evidence?: JudgmentEvidence): Promise<BindingRecord> {
    const value = await this.#readOptional<BindingRecord>(this.#bindingPath(ref), "binding");
    if (!value) throw new ProtectedEvidenceError("EvidenceUnavailable", "protected evidence has no decision binding");
    if (value.kind !== "agape-protected-judgment-binding" || value.version !== 1 || value.evidence_ref !== ref) {
      throw new ProtectedEvidenceError("EvidenceMismatch", "protected evidence decision binding is invalid");
    }
    validateBinding(value.binding, evidence);
    return value;
  }

  #evidencePath(ref: string): string {
    return join(this.#root, parseRef(ref).id + ".evidence");
  }

  #bindingPath(ref: string): string {
    return join(this.#root, parseRef(ref).id + ".binding");
  }

  #deletionPath(ref: string): string {
    return join(this.#root, parseRef(ref).id + ".deleted");
  }

  async #isDeleted(ref: string): Promise<boolean> {
    const record = await this.#readOptional<DeletionRecord>(this.#deletionPath(ref), "deletion");
    if (!record) return false;
    if (record.kind !== "agape-protected-judgment-deletion" || record.version !== 1
      || record.owner_principal !== this.#principal || record.evidence_ref !== ref
      || !Number.isSafeInteger(record.decision_id) || record.decision_id < 0) {
      throw new ProtectedEvidenceError("EvidenceMismatch", "protected evidence deletion marker is invalid");
    }
    return true;
  }

  async #finalDeletionCheck(ref: string, cleanupRacedMutation = false): Promise<void> {
    if (!await this.#isDeleted(ref)) return;
    if (cleanupRacedMutation) await this.#cleanupDeleted(ref);
    throw new ProtectedEvidenceError("EvidenceUnavailable", "protected evidence has been deleted");
  }

  async #assertNotDeleted(ref: string): Promise<void> {
    if (await this.#isDeleted(ref)) {
      throw new ProtectedEvidenceError("EvidenceUnavailable", "protected evidence has been deleted");
    }
  }

  async #cleanupDeleted(ref: string): Promise<void> {
    await rm(this.#evidencePath(ref), { force: true });
    await rm(this.#bindingPath(ref), { force: true });
    await this.#syncDirectory();
  }

  async #reconcileDeletions(): Promise<void> {
    const entries = await readdir(this.#root);
    for (const entry of entries.sort()) {
      if (!/^[A-Za-z0-9_-]{43}\.deleted$/.test(entry)) continue;
      const id = entry.slice(0, -".deleted".length);
      const ref = REF_PREFIX + id;
      const record = await this.#readOptional<DeletionRecord>(this.#deletionPath(ref), "deletion");
      if (!record || record.kind !== "agape-protected-judgment-deletion" || record.version !== 1
        || record.owner_principal !== this.#principal || record.evidence_ref !== ref
        || !Number.isSafeInteger(record.decision_id) || record.decision_id < 0) {
        throw new ProtectedEvidenceError(
          "EvidenceMismatch",
          "protected evidence deletion marker is invalid",
        );
      }
      await this.#cleanupDeleted(ref);
    }
  }

  async #syncDirectory(): Promise<void> {
    const directory = await open(this.#root, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }

  async #readOptional<T>(path: string, domain: string): Promise<T | undefined> {
    let bytes: Buffer;
    try { bytes = await readFile(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    return decrypt<T>(this.#encryptionKey, domain + ":" + basename(path), bytes);
  }

  async #atomicCreate(path: string, value: unknown, domain: string): Promise<void> {
    const bytes = encrypt(this.#encryptionKey, domain + ":" + basename(path), Buffer.from(stableJson(value), "utf8"));
    const temp = join(this.#root, ".tmp-" + randomBytes(16).toString("hex"));
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await createLink(temp, path);
      await rm(temp, { force: true });
      await this.#syncDirectory();
    } catch (error) {
      await rm(temp, { force: true });
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new ProtectedEvidenceError("EvidenceMismatch", "protected evidence artifact already exists");
      }
      throw error;
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("protected evidence store is closed");
  }
}

function validateEvidence(input: JudgmentEvidence): JudgmentEvidence {
  const evidence = snapshotCanonicalPayload(input) as JudgmentEvidence;
  if (evidence.version !== 1 || evidence.method !== "bounded-complete-sequence-logprobs") throw new TypeError("unsupported JudgmentEvidence version or method");
  requiredText(evidence.connector, "connector");
  requiredText(evidence.enum_name, "enum_name");
  if (!Array.isArray(evidence.enum_variants) || evidence.enum_variants.length === 0) {
    throw new TypeError("enum_variants must be a nonempty ordered variant set");
  }
  const declaredVariants = new Set<string>();
  for (const [index, variant] of evidence.enum_variants.entries()) {
    requiredText(variant, `enum_variants[${index}]`);
    if (declaredVariants.has(variant)) throw new TypeError("enum_variants must not contain duplicates");
    declaredVariants.add(variant);
  }
  safePositiveInteger(evidence.candidate_bound, "candidate_bound");
  if (evidence.candidate_bound > 16) throw new TypeError("candidate_bound exceeds the advertised profile bound");
  if (!Array.isArray(evidence.candidates) || evidence.candidates.length !== evidence.candidate_bound) {
    throw new TypeError("candidate_bound must equal the number of complete candidates");
  }
  if (evidence.mapping_version !== "exact-enum-v1" || evidence.normalization_version !== "matched-sequence-mass-v1") {
    throw new TypeError("unsupported JudgmentEvidence mapping or normalization version");
  }
  const massByVariant = new Map<string, number>();
  for (const variant of evidence.enum_variants) massByVariant.set(variant, 0);
  for (const [candidateIndex, candidate] of evidence.candidates.entries()) {
    requiredText(candidate.content, `candidates[${candidateIndex}].content`);
    if (!Array.isArray(candidate.tokens) || candidate.tokens.length === 0) throw new TypeError(`candidates[${candidateIndex}].tokens must be complete and nonempty`);
    if (candidate.tokens.length > 128) throw new TypeError(`candidates[${candidateIndex}].tokens exceeds the advertised profile bound`);
    let aggregate = 0;
    let reconstructed = "";
    for (const [tokenIndex, token] of candidate.tokens.entries()) {
      requiredText(token.token, `candidates[${candidateIndex}].tokens[${tokenIndex}].token`);
      finite(token.logprob, `candidates[${candidateIndex}].tokens[${tokenIndex}].logprob`);
      if (token.logprob > 0) throw new TypeError("token logprob cannot be positive");
      if (token.bytes !== null && (!Array.isArray(token.bytes) || token.bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255))) {
        throw new TypeError("token bytes must be null or byte values");
      }
      aggregate += token.logprob;
      reconstructed += token.token;
    }
    if (reconstructed !== candidate.content) throw new TypeError(`candidates[${candidateIndex}] token sequence does not reconstruct content`);
    if (!near(candidate.aggregate_logprob, aggregate)) throw new TypeError(`candidates[${candidateIndex}].aggregate_logprob does not equal the complete token sequence`);
    if (!near(candidate.aggregate_score, Math.exp(aggregate))) throw new TypeError(`candidates[${candidateIndex}].aggregate_score does not equal exp(aggregate_logprob)`);
    if (candidate.variant !== null) {
      requiredText(candidate.variant, `candidates[${candidateIndex}].variant`);
      if (!declaredVariants.has(candidate.variant)) throw new TypeError("candidate variant is not in enum_variants");
      if (exactStructuredVariant(candidate.content) !== candidate.variant) throw new TypeError("exact-enum-v1 variant mapping does not match candidate content");
      massByVariant.set(candidate.variant, (massByVariant.get(candidate.variant) ?? 0) + candidate.aggregate_score);
    }
  }
  const matchedMass = [...massByVariant.values()].reduce((sum, value) => sum + value, 0);
  if (!(matchedMass > 0)) throw new TypeError("JudgmentEvidence has no matched candidate mass");
  const scoreKeys = Object.keys(evidence.gate_scores);
  if (scoreKeys.length !== evidence.enum_variants.length
    || scoreKeys.some((variant) => !declaredVariants.has(variant))) {
    throw new TypeError("gate_scores keys must exactly equal enum_variants");
  }
  let scoreTotal = 0;
  for (const variant of evidence.enum_variants) {
    const score = evidence.gate_scores[variant]!;
    finite(score, `gate_scores.${variant}`);
    if (score < 0 || score > 1) throw new TypeError("gate_scores must be probabilities");
    if (!near(score, (massByVariant.get(variant) ?? 0) / matchedMass)) throw new TypeError("gate_scores do not match matched-sequence-mass-v1 normalization");
    scoreTotal += score;
  }
  if (!near(scoreTotal, 1)) throw new TypeError("gate_scores must sum to one");
  return evidence;
}

export function validateJudgmentEvidenceLink(
  evidenceInput: JudgmentEvidence,
  linkInput: JudgmentEvidenceLink,
): JudgmentEvidenceLink {
  const evidence = validateEvidence(evidenceInput);
  const link = snapshotCanonicalPayload(linkInput) as JudgmentEvidenceLink;
  if (!/^[A-Za-z0-9_-]{43}$/.test(link.evidence_id)
    || link.evidence_ref !== REF_PREFIX + link.evidence_id
    || !/^[0-9a-f]{64}$/.test(link.evidence_hash)
    || link.evidence_hash !== sha256(stableJson(evidence))
    || !constantJsonEqual(link.gate_scores, evidence.gate_scores)) {
    throw new ProtectedEvidenceError(
      "EvidenceMismatch",
      "authenticated replay evidence linkage does not match the recorded provider evidence",
    );
  }
  return link;
}

function validateBinding(input: JudgmentEvidenceDecisionBinding, evidence?: JudgmentEvidence): JudgmentEvidenceDecisionBinding {
  const binding = snapshotCanonicalPayload(input) as JudgmentEvidenceDecisionBinding;
  safeNonnegativeInteger(binding.decision_id, "decision_id");
  requiredText(binding.winner, "winner");
  if (binding.runner_up !== null) requiredText(binding.runner_up, "runner_up");
  finite(binding.threshold, "threshold");
  finite(binding.required_margin, "required_margin");
  finite(binding.floor, "floor");
  finite(binding.actual_margin, "actual_margin");
  for (const [name, value] of [["threshold", binding.threshold], ["required_margin", binding.required_margin], ["floor", binding.floor], ["actual_margin", binding.actual_margin]] as const) {
    if (value < 0 || value > 1) throw new TypeError(`${name} must be in 0..1`);
  }
  if (typeof binding.passed !== "boolean") throw new TypeError("passed must be boolean");
  if (evidence) {
    const scores = evidence.gate_scores;
    const ordered = evidence.enum_variants;
    const winner = ordered.reduce((best, variant) => scores[variant]! > scores[best]! ? variant : best);
    const winnerScore = scores[winner]!;
    if (binding.winner !== winner) {
      throw new TypeError("binding winner does not match the evidence gate scores");
    }
    const remaining = ordered.filter((variant) => variant !== winner);
    const runnerUp = remaining.length === 0
      ? null
      : remaining.reduce((best, variant) => scores[variant]! > scores[best]! ? variant : best);
    if (binding.runner_up !== runnerUp) {
      throw new TypeError("binding runner_up does not match the evidence gate scores");
    }
    const runnerUpScore = runnerUp === null ? 0 : scores[runnerUp]!;
    const actualMargin = winnerScore - runnerUpScore;
    const passed = winnerScore >= binding.threshold && actualMargin >= binding.required_margin;
    if (!near(binding.actual_margin, actualMargin) || binding.passed !== passed) {
      throw new TypeError("binding arithmetic does not match the evidence gate scores");
    }
  }
  return binding;
}

function exactStructuredVariant(content: string): string | null {
  const exact = content.trim();
  try {
    const decoded = JSON.parse(exact) as unknown;
    if (typeof decoded === "string") return decoded;
    if (decoded !== null && typeof decoded === "object" && !Array.isArray(decoded)) {
      const value = (decoded as Record<string, unknown>).value;
      if (typeof value === "string") return value;
    }
  } catch { /* bare exact enum value */ }
  return exact || null;
}

function encrypt(key: Buffer, aad: string, plaintext: Buffer): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from("AGPE1", "ascii"), nonce, tag, ciphertext]);
}

function decrypt<T>(key: Buffer, aad: string, bytes: Buffer): T {
  if (bytes.length < 33 || bytes.subarray(0, 5).toString("ascii") !== "AGPE1") throw new ProtectedEvidenceError("EvidenceMismatch", "protected evidence envelope is invalid");
  try {
    const nonce = bytes.subarray(5, 17);
    const tag = bytes.subarray(17, 33);
    const ciphertext = bytes.subarray(33);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8")) as T;
  } catch {
    throw new ProtectedEvidenceError("EvidenceMismatch", "protected evidence authentication failed");
  }
}

function stableJson(value: unknown): string {
  const canonical = snapshotCanonicalPayload(value);
  return encode(canonical);
}

function encode(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(encode).join(",") + "]";
  const record = value as Record<string, unknown>;
  return "{" + Object.keys(record).sort().map((key) => JSON.stringify(key) + ":" + encode(record[key])).join(",") + "}";
}

function parseRef(ref: string): { ref: string; id: string } {
  if (!ref.startsWith(REF_PREFIX)) throw new ProtectedEvidenceError("EvidenceUnavailable", "protected evidence reference is invalid");
  const id = ref.slice(REF_PREFIX.length);
  if (!/^[A-Za-z0-9_-]{43}$/.test(id)) throw new ProtectedEvidenceError("EvidenceUnavailable", "protected evidence reference is invalid");
  return { ref, id };
}

function derive(root: Buffer, domain: string): Buffer {
  return createHmac("sha256", root).update("agape/protected-evidence/key/v1\0" + domain, "utf8").digest();
}

function mac(key: Buffer, domain: string, value: string): string {
  return createHmac("sha256", key).update("agape/protected-evidence/" + domain + "/v1\0", "utf8").update(value, "utf8").digest("hex");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeEqualHex(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(left) || !/^[0-9a-f]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function constantJsonEqual(left: unknown, right: unknown): boolean {
  const a = Buffer.from(stableJson(left), "utf8");
  const b = Buffer.from(stableJson(right), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || /[\0\r\n]/.test(value)) throw new TypeError(`${name} must be nonblank text without control lines`);
  return value;
}

function safePositiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new TypeError(`${name} must be a positive safe integer`);
  return value as number;
}

function safeNonnegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`${name} must be a nonnegative safe integer`);
  return value as number;
}

function finite(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
  return value;
}

function near(left: number, right: number): boolean {
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= 1e-12 * Math.max(1, Math.abs(left), Math.abs(right));
}
