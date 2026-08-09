import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, basename, join } from "node:path";

import { snapshotCanonicalPayload } from "./ledger_hash.js";
import type { NamedMemoryRuntimeRecording } from "./named_memory_runtime.js";
import type { JudgmentEvidenceLink } from "./protected_evidence.js";
import type { CognitionContext, Provider, ProviderJudgment, StructuredSchema, Variant } from "./runtime.js";

export type ProviderRecordingOperation =
  | { kind: "judge"; request_hash: string; result: ProviderJudgment }
  | { kind: "structured"; request_hash: string; result: unknown }
  | { kind: "reply"; request_hash: string; result: string };

export interface RuntimeProviderRecording {
  kind: "agape-provider-recording";
  version: 1;
  operations: readonly ProviderRecordingOperation[];
}

export interface RuntimeRecordingIdentity {
  projectSubject: string;
  sessionLineageId: string;
  sessionId: string;
  conversationId: string;
  user?: { issuer: string; subject: string; verified: true };
}

export interface RuntimeRecording {
  kind: "agape-runtime-recording";
  version: 1;
  source_hash: string;
  manifest_hash: string;
  identity: RuntimeRecordingIdentity;
  provider: RuntimeProviderRecording;
  named_memory: NamedMemoryRuntimeRecording;
  protected_evidence?: readonly JudgmentEvidenceLink[];
  ledger_timing: readonly { latency_ms: number; elapsed_ms: number }[];
  head: string;
}

export class RecordingProvider implements Provider {
  readonly #operations: Array<ProviderRecordingOperation | undefined> = [];
  constructor(private readonly delegate: Provider) {}

  async judge(prompt: string, enumName: string, variants: Variant[], context?: CognitionContext): Promise<ProviderJudgment> {
    const requestHash = hashRequest({ kind: "judge", prompt, enumName, variants, context });
    const slot = this.#reserve();
    const result = snapshotCanonicalPayload(await this.delegate.judge(prompt, enumName, variants, context)) as ProviderJudgment;
    this.#operations[slot] = { kind: "judge", request_hash: requestHash, result };
    return result;
  }

  async structured(prompt: string, schema: StructuredSchema, name?: string, context?: CognitionContext): Promise<unknown> {
    if (!this.delegate.structured) throw new Error("provider does not implement structured cognition");
    const requestHash = hashRequest({ kind: "structured", prompt, schema, name: name ?? null, context });
    const slot = this.#reserve();
    const result = snapshotCanonicalPayload(await this.delegate.structured(prompt, schema, name, context));
    this.#operations[slot] = { kind: "structured", request_hash: requestHash, result };
    return result;
  }

  async reply(prompt: string, context?: CognitionContext): Promise<string> {
    const requestHash = hashRequest({ kind: "reply", prompt, context });
    const slot = this.#reserve();
    const result = await this.delegate.reply(prompt, context);
    this.#operations[slot] = { kind: "reply", request_hash: requestHash, result };
    return result;
  }

  snapshot(): RuntimeProviderRecording {
    if (this.#operations.some((operation) => operation === undefined)) throw new Error("provider recording has unresolved operations");
    return snapshotCanonicalPayload({
      kind: "agape-provider-recording",
      version: 1,
      operations: this.#operations,
    }) as unknown as RuntimeProviderRecording;
  }

  #reserve(): number {
    const slot = this.#operations.length;
    this.#operations.push(undefined);
    return slot;
  }
}

export class ReplayProvider implements Provider {
  readonly #operations: readonly ProviderRecordingOperation[];
  #cursor = 0;

  constructor(recording: RuntimeProviderRecording) {
    validateProviderRecording(recording);
    this.#operations = recording.operations;
  }

  async judge(prompt: string, enumName: string, variants: Variant[], context?: CognitionContext): Promise<ProviderJudgment> {
    return this.#take("judge", hashRequest({ kind: "judge", prompt, enumName, variants, context })).result;
  }

  async structured(prompt: string, schema: StructuredSchema, name?: string, context?: CognitionContext): Promise<unknown> {
    return this.#take("structured", hashRequest({ kind: "structured", prompt, schema, name: name ?? null, context })).result;
  }

  async reply(prompt: string, context?: CognitionContext): Promise<string> {
    return this.#take("reply", hashRequest({ kind: "reply", prompt, context })).result;
  }

  assertConsumed(): void {
    if (this.#cursor !== this.#operations.length) throw new Error(`provider replay has ${this.#operations.length - this.#cursor} unconsumed operation(s)`);
  }

  #take<K extends ProviderRecordingOperation["kind"]>(kind: K, requestHash: string): Extract<ProviderRecordingOperation, { kind: K }> {
    const operation = this.#operations[this.#cursor++];
    if (!operation) throw new Error(`provider replay exhausted before ${kind}`);
    if (operation.kind !== kind || operation.request_hash !== requestHash) throw new Error(`provider replay request mismatch for ${kind}`);
    return operation as Extract<ProviderRecordingOperation, { kind: K }>;
  }
}

export async function writeRuntimeRecording(path: string, keyInput: Uint8Array, recordingInput: RuntimeRecording): Promise<void> {
  const key = exactKey(keyInput);
  const recording = validateRuntimeRecording(snapshotCanonicalPayload(recordingInput) as unknown as RuntimeRecording);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from("agape/runtime-recording/v1", "utf8"));
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(stableJson(recording), "utf8")), cipher.final()]);
  const bytes = Buffer.concat([Buffer.from("AGRR1", "ascii"), nonce, cipher.getAuthTag(), ciphertext]);
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temp = join(parent, "." + basename(path) + ".tmp-" + randomBytes(12).toString("hex"));
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try { await rename(temp, path); }
  catch (error) { await rm(temp, { force: true }); throw error; }
}

export async function readRuntimeRecording(path: string, keyInput: Uint8Array): Promise<RuntimeRecording> {
  const key = exactKey(keyInput);
  const bytes = await readFile(path);
  if (bytes.length < 33 || bytes.subarray(0, 5).toString("ascii") !== "AGRR1") throw new Error("runtime recording envelope is invalid");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(5, 17));
    decipher.setAAD(Buffer.from("agape/runtime-recording/v1", "utf8"));
    decipher.setAuthTag(bytes.subarray(17, 33));
    const value = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(33)), decipher.final()]).toString("utf8")) as RuntimeRecording;
    return validateRuntimeRecording(value);
  } catch (error) {
    if ((error as Error).message.includes("runtime recording")) throw error;
    throw new Error("runtime recording authentication failed");
  }
}

export function runtimeRecordingHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

export function decodeRuntimeSecret(value: string | undefined, name: string): Buffer {
  if (!value) throw new Error(`${name} must provide a 32-byte hex or base64 host secret`);
  const trimmed = value.trim();
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) key = Buffer.from(trimmed, "hex");
  else {
    try { key = Buffer.from(trimmed, "base64"); }
    catch { key = Buffer.alloc(0); }
  }
  if (key.length !== 32) throw new Error(`${name} must provide a 32-byte hex or base64 host secret`);
  return key;
}

function validateProviderRecording(recording: RuntimeProviderRecording): RuntimeProviderRecording {
  if (recording?.kind !== "agape-provider-recording" || recording.version !== 1 || !Array.isArray(recording.operations)) throw new Error("provider recording is invalid");
  for (const operation of recording.operations) {
    if (!operation || !["judge", "structured", "reply"].includes(operation.kind) || !/^[0-9a-f]{64}$/.test(operation.request_hash)) {
      throw new Error("provider recording operation is invalid");
    }
    if (operation.kind === "reply" && typeof operation.result !== "string") throw new Error("provider recording reply is invalid");
  }
  return recording;
}

function validateRuntimeRecording(recording: RuntimeRecording): RuntimeRecording {
  if (recording?.kind !== "agape-runtime-recording" || recording.version !== 1) throw new Error("runtime recording is invalid");
  for (const [name, hash] of [["source_hash", recording.source_hash], ["manifest_hash", recording.manifest_hash], ["head", recording.head]] as const) {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`runtime recording ${name} is invalid`);
  }
  for (const field of [recording.identity?.projectSubject, recording.identity?.sessionLineageId, recording.identity?.sessionId, recording.identity?.conversationId]) {
    if (typeof field !== "string" || field.length === 0) throw new Error("runtime recording identity is invalid");
  }
  validateProviderRecording(recording.provider);
  if (recording.named_memory?.kind !== "agape-named-memory-recording" || recording.named_memory.version !== 1) throw new Error("runtime recording named memory is invalid");
  if (recording.protected_evidence !== undefined) {
    if (!Array.isArray(recording.protected_evidence)) throw new Error("runtime recording protected evidence is invalid");
    for (const link of recording.protected_evidence) {
      if (!link || typeof link !== "object"
        || !/^[A-Za-z0-9_-]{43}$/.test(link.evidence_id)
        || !/^[0-9a-f]{64}$/.test(link.evidence_hash)
        || link.evidence_ref !== `protected:evidence:v1:${link.evidence_id}`
        || !link.gate_scores || typeof link.gate_scores !== "object"
        || Object.values(link.gate_scores).some((score) => typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1)) {
        throw new Error("runtime recording protected evidence link is invalid");
      }
    }
  }
  if (!Array.isArray(recording.ledger_timing)) throw new Error("runtime recording ledger timing is invalid");
  let priorElapsed = 0;
  for (const timing of recording.ledger_timing) {
    if (!timing || !Number.isSafeInteger(timing.latency_ms) || timing.latency_ms < 0
      || !Number.isSafeInteger(timing.elapsed_ms) || timing.elapsed_ms < priorElapsed
      || timing.latency_ms !== timing.elapsed_ms - priorElapsed) {
      throw new Error("runtime recording ledger timing is invalid");
    }
    priorElapsed = timing.elapsed_ms;
  }
  return recording;
}

function hashRequest(value: unknown): string {
  return createHash("sha256").update("agape/provider-request/v1\0", "utf8").update(stableJson(value), "utf8").digest("hex");
}

function stableJson(value: unknown): string {
  const canonical = snapshotCanonicalPayload(value);
  if (canonical === null || typeof canonical !== "object") return JSON.stringify(canonical);
  if (Array.isArray(canonical)) return "[" + canonical.map(stableJson).join(",") + "]";
  const record = canonical as Record<string, unknown>;
  return "{" + Object.keys(record).sort().map((key) => JSON.stringify(key) + ":" + stableJson(record[key])).join(",") + "}";
}

function exactKey(value: Uint8Array): Buffer {
  const key = Buffer.from(value);
  if (key.length !== 32) throw new Error("runtime recording key must contain exactly 32 bytes");
  return key;
}
