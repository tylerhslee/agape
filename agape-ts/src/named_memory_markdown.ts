import { createHash, randomBytes } from "node:crypto";
import {
  link, lstat, mkdir, open as openFile, readFile, readdir, realpath, rename, unlink,
  type FileHandle,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Value } from "./runtime.js";
import {
  decodeExactValue, encodeExactValue, type ExactValueEnvelope,
  type MemoryRegionKeyInput, type ResolvedMemoryDescriptor,
} from "./named_memory.js";
import {
  DurableTransactionalNamedMemoryDriver, LocalTransactionalNamedMemoryDriver,
  LocalTransactionalNamedMemoryJournal, type LedgerCommitBinding,
  type NamedMemoryEffects, type NamedMemoryMutationContext,
  type RegionDerivation,
  type NamedMemoryMutationReceipt, type NamedMemoryOperationStatus,
  type NamedMemoryRecall, type PreparedNamedMemoryMutation,
  type TransactionalNamedMemorySnapshot,
} from "./named_memory_local.js";

export interface MarkdownNamedMemoryEffects extends NamedMemoryEffects {
  blobs: { archived: number; deleted: number };
}

export interface MarkdownPreparedNamedMemoryMutation
  extends Omit<PreparedNamedMemoryMutation, "effects"> {
  effects: MarkdownNamedMemoryEffects;
}

export interface MarkdownNamedMemoryMutationReceipt
  extends Omit<NamedMemoryMutationReceipt, "effects"> {
  effects: MarkdownNamedMemoryEffects;
}

export type MarkdownFilesystemPhase =
  | "lease-temp-synced" | "lease-published"
  | "claim-temp-synced" | "claim-published"
  | "state-temp-opened" | "state-before-rename" | "state-after-rename"
  | "state-before-directory-sync" | "state-after-directory-sync"
  | "projection-before-rename"
  | "close-before-lease-unlink";

export interface MarkdownFilesystemTestHooks {
  onFilesystemPhase?: (phase: MarkdownFilesystemPhase, path: string) => void | Promise<void>;
}

export interface MarkdownTransactionalNamedMemoryDriverOptions {
  root: string;
  entrypoint?: string;
  archiveOnForget?: boolean;
  pathTemplate?: string;
  testHooks?: MarkdownFilesystemTestHooks;
}

interface StoredMutationContext {
  descriptor: ResolvedMemoryDescriptor;
  region: Omit<MemoryRegionKeyInput, "descriptor">;
  site: string;
  origin: NamedMemoryMutationContext["origin"];
}

interface StoredPendingMutation {
  kind: "store" | "forget";
  context: StoredMutationContext;
  envelope?: ExactValueEnvelope;
  stage: MarkdownPreparedNamedMemoryMutation;
}

interface StoredFinalizedMetadata {
  effects: MarkdownNamedMemoryEffects;
  refs: Readonly<Record<string, string>>;
  priorRegion?: TransactionalNamedMemorySnapshot["regions"][number];
}

interface CanonicalPayload {
  version: 1;
  revision: number;
  snapshot: TransactionalNamedMemorySnapshot;
  pending: readonly StoredPendingMutation[];
  finalized: Readonly<Record<string, StoredFinalizedMetadata>>;
  projection: { entrypoint: string; archiveOnForget: boolean; pathTemplate: string | null };
}

interface CanonicalDocument { version: 1; checksum: string; payload: CanonicalPayload }
interface WriterLeaseDocument {
  version: 1;
  token: string;
  pid: number;
  processStart: string | null;
}
interface AcquiredLease { handle: FileHandle; token: string }

type StoreRequest = NamedMemoryMutationContext & { value: Value; operationId?: string };
type ForgetRequest = NamedMemoryMutationContext & { operationId?: string };

const EMPTY_SNAPSHOT: TransactionalNamedMemorySnapshot = Object.freeze({
  version: 1,
  regions: Object.freeze([]),
  operations: Object.freeze([]),
  evaluations: Object.freeze([]),
});

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical memory state rejects non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort((left, right) =>
      Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new Error(`canonical memory state rejects ${typeof value}`);
}

function checksum(payload: CanonicalPayload): string {
  return createHash("sha256").update("agape.markdown-memory-state.v1", "utf8")
    .update("\0", "utf8").update(canonicalJson(payload), "utf8").digest("hex");
}

function exactKeys(value: object, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (actual.length !== canonical.length || actual.some((key, index) => key !== canonical[index])) {
    throw new Error(`${label} has unexpected fields`);
  }
}

async function processStartMarker(pid: number): Promise<string | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0) return null;
    const fieldsAfterCommand = stat.slice(close + 2).trim().split(/\s+/);
    return fieldsAfterCommand[19] ?? null;
  } catch {
    return null;
  }
}

async function leaseOwnerAlive(lease: WriterLeaseDocument): Promise<boolean> {
  try {
    process.kill(lease.pid, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
  if (lease.processStart === null) return true;
  const current = await processStartMarker(lease.pid);
  return current === null || current === lease.processStart;
}

async function readLease(path: string): Promise<WriterLeaseDocument> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Markdown memory writer lease must be a regular file");
  const parsed = JSON.parse(await readFile(path, "utf8")) as WriterLeaseDocument;
  if (parsed === null || typeof parsed !== "object") throw new Error("Markdown memory writer lease is malformed");
  exactKeys(parsed, ["pid", "processStart", "token", "version"], "Markdown memory writer lease");
  if (parsed.version !== 1 || !Number.isSafeInteger(parsed.pid) || parsed.pid < 1
    || typeof parsed.token !== "string" || !/^[0-9a-f]{64}$/.test(parsed.token)
    || (parsed.processStart !== null && typeof parsed.processStart !== "string")) {
    throw new Error("Markdown memory writer lease is malformed");
  }
  return parsed;
}

async function filesystemPhase(
  hooks: MarkdownFilesystemTestHooks | undefined,
  phase: MarkdownFilesystemPhase,
  path: string,
): Promise<void> {
  await hooks?.onFilesystemPhase?.(phase, path);
}

async function createLease(
  path: string,
  document: WriterLeaseDocument,
  hooks: MarkdownFilesystemTestHooks | undefined,
  kind: "lease" | "claim" = "lease",
): Promise<FileHandle> {
  const temporary = join(dirname(path),
    `.lease-temp-${document.pid}-${document.token}-${randomBytes(12).toString("hex")}.tmp`);
  const handle = await openFile(temporary, "wx", 0o600);
  let published = false;
  try {
    await handle.writeFile(`${canonicalJson(document)}\n`, "utf8");
    await handle.sync();
    await filesystemPhase(hooks, `${kind}-temp-synced`, temporary);
    await link(temporary, path);
    published = true;
    await unlink(temporary);
    await filesystemPhase(hooks, `${kind}-published`, path);
    return handle;
  } catch (error) {
    if (!published) await handle.truncate(0).catch(() => undefined);
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    if (published) await unlink(path).catch(() => undefined);
    throw error;
  }
}

async function cleanupOrphanLeaseTemps(internal: string): Promise<void> {
  for (const name of await readdir(internal)) {
    const match = /^\.lease-temp-([1-9][0-9]*)-[0-9a-f]{64}-[0-9a-f]{24}[.]tmp$/.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    let alive = true;
    try { process.kill(pid, 0); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") alive = false;
      else if (code !== "EPERM") throw error;
    }
    if (!alive) await unlink(join(internal, name)).catch(() => undefined);
  }
}

async function acquireLease(
  internal: string,
  hooks?: MarkdownFilesystemTestHooks,
): Promise<AcquiredLease> {
  await cleanupOrphanLeaseTemps(internal);
  const leasePath = join(internal, "writer.lock");
  const token = randomBytes(32).toString("hex");
  const document: WriterLeaseDocument = {
    version: 1,
    token,
    pid: process.pid,
    processStart: await processStartMarker(process.pid),
  };
  try {
    return { handle: await createLease(leasePath, document, hooks), token };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  const stale = await readLease(leasePath);
  if (await leaseOwnerAlive(stale)) throw new Error("Markdown memory already has an active writer lease");
  const generation = opaqueSegment("stale-lease", stale.token);
  const claimName = `takeover-${generation}-${token}.claim`;
  const claimPath = join(internal, claimName);
  const claim = await createLease(claimPath, document, hooks, "claim");
  await claim.close();
  try {
    await new Promise((resolve) => setTimeout(resolve, 40));
    const current = await readLease(leasePath);
    if (current.token !== stale.token) throw new Error("another writer acquired the Markdown memory lease");
    const candidates = (await readdir(internal))
      .filter((name) => name.startsWith(`takeover-${generation}-`)).sort();
    const contenders: string[] = [];
    for (const candidate of candidates) {
      const candidatePath = join(internal, candidate);
      const owner = await readLease(candidatePath);
      if (await leaseOwnerAlive(owner)) contenders.push(candidate);
      else await unlink(candidatePath).catch(() => undefined);
    }
    if (contenders[0] !== claimName) {
      throw new Error("another writer won the Markdown memory lease takeover");
    }
    await unlink(leasePath);
    try {
      return { handle: await createLease(leasePath, document, hooks), token };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error("another writer acquired the Markdown memory lease");
      }
      throw error;
    }
  } finally {
    await unlink(claimPath).catch(() => undefined);
  }
}

function opaqueSegment(domain: string, value: string): string {
  return createHash("sha256").update(`agape.markdown-memory-path.${domain}.v1`, "utf8")
    .update("\0", "utf8").update(value, "utf8").digest("hex");
}

function freezeDeep<T>(value: T, seen = new Set<object>()): T {
  if (value !== null && typeof value === "object") {
    const object = value as object;
    if (seen.has(object)) throw new Error("named-memory values must not contain cycles");
    seen.add(object);
    if (Array.isArray(value)) for (const item of value) freezeDeep(item, seen);
    else for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child, seen);
    seen.delete(object);
    Object.freeze(object);
  }
  return value;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function unsafeWindowsSegment(segment: string): boolean {
  const base = segment.split(".", 1)[0]!.trimEnd().toUpperCase();
  return /[\u0000-\u001f<>:"|?*]/.test(segment)
    || /[. ]$/.test(segment)
    || ["CON", "PRN", "AUX", "NUL"].includes(base)
    || /^(?:COM|LPT)(?:[1-9]|[¹²³])$/.test(base);
}

function assertTrustedDirectory(
  stat: { isDirectory(): boolean; isSymbolicLink(): boolean; uid: number; mode: number },
  label: string,
): void {
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory`);
  }
  if (process.platform !== "win32") {
    const uid = process.getuid?.();
    if (uid === undefined || stat.uid !== uid || (stat.mode & 0o022) !== 0) {
      throw new Error(`${label} must be owned by the runtime user and not group/world writable`);
    }
  }
}

async function cleanupOrphanWriteTemps(directory: string): Promise<void> {
  const stat = await lstat(directory);
  assertTrustedDirectory(stat, "Markdown memory temporary directory");
  for (const name of await readdir(directory)) {
    const match = /^\.tmp-([1-9][0-9]*)-([0-9]+|unknown)-[0-9a-f]{48}$/.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    const expectedStart = match[2] === "unknown" ? null : match[2]!;
    let alive = true;
    try { process.kill(pid, 0) } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") alive = false;
      else if (code !== "EPERM") throw error;
    }
    if (alive && expectedStart !== null) {
      const current = await processStartMarker(pid);
      if (current !== null && current !== expectedStart) alive = false;
    }
    if (!alive) await unlink(join(directory, name)).catch(() => undefined);
  }
}

function validateEntrypoint(input: string | undefined): string {
  const candidate = input ?? "MEMORY.md";
  if (candidate.trim().length === 0 || candidate === "." || candidate === ".."
    || candidate.includes("/") || candidate.includes("\\") || candidate.includes("\0")
    || unsafeWindowsSegment(candidate)) {
    throw new Error("Markdown memory entrypoint must be a plain file name");
  }
  return candidate.toLowerCase().endsWith(".md") ? candidate : `${candidate}.md`;
}

const PATH_PLACEHOLDERS = new Set([
  "project", "lineage", "agent", "mem", "user", "generation",
]);

function validatePathTemplate(input: string | undefined): string | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new Error("Markdown memory path template must be nonblank");
  }
  if (isAbsolute(input) || /^[A-Za-z]:[/\\]/.test(input) || input.startsWith("\\\\")) {
    throw new Error("Markdown memory path template must be relative");
  }
  const segments = input.split(/[/\\]/);
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error("Markdown memory path template contains an unsafe segment");
  }
  if (!/^\{[^{}]+\}$/.test(segments[0]!)) {
    throw new Error("Markdown memory path template must begin with a placeholder segment");
  }
  for (const segment of segments) {
    const match = /^\{([^{}]+)\}$/.exec(segment);
    if (match) {
      if (!PATH_PLACEHOLDERS.has(match[1]!)) {
        throw new Error(`Markdown memory path template contains unsupported placeholder {${match[1]}}`);
      }
    } else if (segment.includes("{") || segment.includes("}") || /[\0-\x1f]/.test(segment)
      || unsafeWindowsSegment(segment)) {
      throw new Error("Markdown memory path template contains an invalid static segment");
    }
  }
  return segments.join("/");
}

function memoryIdentityDimension(domain: string, value: unknown): string {
  return createHash("sha256").update(`agape.memory-region.${domain}.v1`, "utf8")
    .update("\0", "utf8").update(canonicalJson(value), "utf8").digest("hex");
}

function pathContext(input: StoredMutationContext): RegionDerivation {
  const dimensions: Record<string, string> = {
    lineage: memoryIdentityDimension("lineage", input.region.sessionLineageId),
    agent: memoryIdentityDimension("agent-instance", input.region.stableAgentInstanceId),
  };
  if (input.descriptor.retention === "session") {
    dimensions.session = memoryIdentityDimension("session", input.region.sessionId);
  }
  if (input.descriptor.scopes.includes("project")) {
    if (input.region.projectSubject === undefined) throw new Error("project path placeholder requires project-scoped memory");
    dimensions.project = memoryIdentityDimension("project", input.region.projectSubject);
  }
  if (input.descriptor.scopes.includes("user")) {
    if (!input.region.user?.verified) throw new Error("user path placeholder requires user-scoped memory");
    dimensions.user = memoryIdentityDimension("user", {
      issuer: memoryIdentityDimension("user-issuer", input.region.user.issuer),
      subject: memoryIdentityDimension("user-subject", input.region.user.subject),
    });
  }
  return freezeDeep({ descriptor: input.descriptor, dimensions });
}

function requestContext(request: NamedMemoryMutationContext): StoredMutationContext {
  return { descriptor: request.descriptor, region: request.region, site: request.site, origin: request.origin };
}

function exactRequest(pending: StoredPendingMutation): StoreRequest | ForgetRequest {
  if (pending.kind === "forget") return pending.context;
  if (pending.envelope === undefined) throw new Error("durable store stage is missing its exact envelope");
  return { ...pending.context, value: decodeExactValue(pending.envelope, pending.context.descriptor.schema) };
}

function initialPayload(entrypoint: string, archiveOnForget: boolean, pathTemplate?: string): CanonicalPayload {
  return {
    version: 1, revision: 0, snapshot: EMPTY_SNAPSHOT, pending: [], finalized: {},
    projection: { entrypoint, archiveOnForget, pathTemplate: pathTemplate ?? null },
  };
}

/** Filesystem-backed standard driver for `[memory].driver = "markdown"`. */
export class MarkdownTransactionalNamedMemoryDriver {
  static async open(options: MarkdownTransactionalNamedMemoryDriverOptions): Promise<MarkdownTransactionalNamedMemoryDriver> {
    if (typeof options.root !== "string" || options.root.trim().length === 0) {
      throw new Error("Markdown memory root must be nonblank");
    }
    const entrypoint = validateEntrypoint(options.entrypoint);
    const pathTemplate = validatePathTemplate(options.pathTemplate);
    const configuredRoot = resolve(options.root);
    await mkdir(configuredRoot, { recursive: true, mode: 0o700 });
    const root = await realpath(configuredRoot);
    assertTrustedDirectory(await lstat(root), "Markdown memory root");
    const internal = join(root, ".agape-memory-v1");
    await mkdir(internal, { recursive: true, mode: 0o700 });
    const internalStat = await lstat(internal);
    assertTrustedDirectory(internalStat, "Markdown memory internal path");
    await cleanupOrphanWriteTemps(internal);
    const leasePath = join(internal, "writer.lock");
    const acquired = await acquireLease(internal, options.testHooks);
    try {
      const driver = new MarkdownTransactionalNamedMemoryDriver({
        root, internal, leasePath, lease: acquired.handle, leaseToken: acquired.token, entrypoint,
        archiveOnForget: options.archiveOnForget ?? true, pathTemplate,
        testHooks: options.testHooks,
      });
      await driver.initialize();
      await driver.cleanupKnownProjectionTemps();
      return driver;
    } catch (error) {
      await acquired.handle.close().catch(() => undefined);
      await unlink(leasePath).catch(() => undefined);
      throw error;
    }
  }

  readonly capabilities = freezeDeep({
    version: 1 as const,
    modalities: ["opaque", "episodic", "semantic"] as const,
    retentions: ["session", "durable"] as const,
    scopes: ["project", "user"] as const,
    exactEncoding: true as const,
    idempotentReconciliation: true as const,
  });

  readonly #root: string;
  readonly #statePath: string;
  readonly #leasePath: string;
  readonly #lease: FileHandle;
  readonly #leaseToken: string;
  readonly #entrypoint: string;
  readonly #archiveOnForget: boolean;
  readonly #pathTemplate?: string;
  readonly #testHooks?: MarkdownFilesystemTestHooks;
  #payload: CanonicalPayload;
  #expectedChecksum?: string;
  #fenced = false;
  #durable = new DurableTransactionalNamedMemoryDriver();
  #session = new LocalTransactionalNamedMemoryDriver();
  #operationTier = new Map<string, "session" | "durable">();
  #sessionStages = new Map<string, MarkdownPreparedNamedMemoryMutation>();
  #tail: Promise<void> = Promise.resolve();
  #closed = false;
  #leaseReleased = false;

  private constructor(input: {
    root: string; internal: string; leasePath: string; lease: FileHandle;
    leaseToken: string; entrypoint: string; archiveOnForget: boolean;
    pathTemplate?: string; testHooks?: MarkdownFilesystemTestHooks;
  }) {
    this.#root = input.root;
    this.#statePath = join(input.internal, "state.json");
    this.#leasePath = input.leasePath;
    this.#lease = input.lease;
    this.#leaseToken = input.leaseToken;
    this.#entrypoint = input.entrypoint;
    this.#archiveOnForget = input.archiveOnForget;
    this.#pathTemplate = input.pathTemplate;
    this.#payload = initialPayload(input.entrypoint, input.archiveOnForget, input.pathTemplate);
    this.#testHooks = input.testHooks;
  }

  private async initialize(): Promise<void> {
    try {
      const stat = await lstat(this.#statePath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Markdown memory state must be a regular file");
      const document = JSON.parse(await readFile(this.#statePath, "utf8")) as CanonicalDocument;
      exactKeys(document, ["checksum", "payload", "version"], "Markdown memory canonical document");
      exactKeys(document.payload, ["finalized", "pending", "projection", "revision", "snapshot", "version"], "Markdown memory canonical payload");
      exactKeys(document.payload.projection, ["archiveOnForget", "entrypoint", "pathTemplate"], "Markdown memory projection identity");
      if (document.version !== 1 || document.payload?.version !== 1
        || document.checksum !== checksum(document.payload)
        || !Number.isSafeInteger(document.payload.revision) || document.payload.revision < 0
        || !Array.isArray(document.payload.pending)
        || typeof document.payload.finalized !== "object" || document.payload.finalized === null
        || document.payload.projection.entrypoint !== this.#entrypoint
        || document.payload.projection.archiveOnForget !== this.#archiveOnForget
        || document.payload.projection.pathTemplate !== (this.#pathTemplate ?? null)) {
        throw new Error("Markdown memory canonical state is malformed or has an invalid checksum");
      }
      this.#payload = freezeDeep(document.payload);
      this.#expectedChecksum = document.checksum;
      this.rebuildDurable();
    } catch (error) {
      if (!isMissing(error)) throw error;
      await this.persistNext(this.#payload);
    }
  }

  async prepareStore(request: StoreRequest): Promise<MarkdownPreparedNamedMemoryMutation> {
    return await this.exclusive(async () => {
      this.assertOpen();
      const projectionContext = this.preflightPathContext(request);
      if (request.descriptor.retention === "session") {
        const stage = this.#session.prepareStore(request);
        this.#operationTier.set(stage.operationId, "session");
        const decorated = this.decorate(stage, { archived: 0, deleted: 0 }, projectionContext);
        this.#sessionStages.set(stage.operationId, decorated);
        return decorated;
      }
      const base = this.#durable.prepareStore(request);
      const existing = this.pending(base.operationId);
      if (existing) return existing.stage;
      const status = this.#durable.status(base.operationId);
      if (status.status === "finalized") return this.finalizedStage(status.receipt);
      const stage = this.decorate(base, { archived: 0, deleted: 0 }, projectionContext);
      const next: CanonicalPayload = {
        ...this.#payload,
        pending: [...this.#payload.pending, {
          kind: "store", context: requestContext(request),
          envelope: encodeExactValue(request.value, request.descriptor.schema), stage,
        }],
      };
      this.#operationTier.set(stage.operationId, "durable");
      try {
        await this.persistNext(next);
      } catch (error) {
        this.rebuildDurable();
        throw error;
      }
      return stage;
    });
  }

  async prepareForget(request: ForgetRequest): Promise<MarkdownPreparedNamedMemoryMutation> {
    return await this.exclusive(async () => {
      this.assertOpen();
      const projectionContext = this.preflightPathContext(request);
      if (request.descriptor.retention === "session") {
        const stage = this.#session.prepareForget(request);
        this.#operationTier.set(stage.operationId, "session");
        const decorated = this.decorate(stage, { archived: 0, deleted: 0 }, projectionContext);
        this.#sessionStages.set(stage.operationId, decorated);
        return decorated;
      }
      const base = this.#durable.prepareForget(request);
      const existing = this.pending(base.operationId);
      if (existing) return existing.stage;
      const status = this.#durable.status(base.operationId);
      if (status.status === "finalized") return this.finalizedStage(status.receipt);
      const prior = this.regionProjection(base.regionKey);
      const changed = base.effects.cells.tombstoned > 0 && prior !== undefined;
      const blobs = {
        archived: changed && this.#archiveOnForget ? 1 : 0,
        deleted: changed && !this.#archiveOnForget ? 1 : 0,
      };
      const stage = this.decorate(base, blobs, projectionContext);
      const next: CanonicalPayload = {
        ...this.#payload,
        pending: [...this.#payload.pending, {
          kind: "forget", context: requestContext(request), stage,
        }],
      };
      this.#operationTier.set(stage.operationId, "durable");
      try {
        await this.persistNext(next);
      } catch (error) {
        this.rebuildDurable();
        throw error;
      }
      return stage;
    });
  }

  async finalize(operationId: string, binding: LedgerCommitBinding): Promise<NamedMemoryMutationReceipt> {
    return await this.exclusive(async () => {
      this.assertOpen();
      if (this.tier(operationId) === "session") {
        return this.decorateSessionReceipt(this.#session.finalize(operationId, binding));
      }
      const status = this.#durable.status(operationId);
      if (status.status === "finalized") {
        if (status.receipt.ledger.tick !== binding.tick || status.receipt.ledger.head !== binding.head) {
          throw new Error("named-memory operation was finalized against a different ledger commit");
        }
        await this.ensureProjection(operationId);
        return this.decorateReceipt(status.receipt);
      }
      return await this.finalizeUnlocked(operationId, binding);
    });
  }

  async abort(operationId: string): Promise<NamedMemoryOperationStatus> {
    return await this.exclusive(async () => {
      this.assertOpen();
      if (this.tier(operationId) === "session") {
        const status = this.#session.abort(operationId);
        if (status.status === "aborted") this.#sessionStages.delete(operationId);
        return status;
      }
      const pending = this.pending(operationId);
      if (!pending) return this.decorateStatus(this.#durable.abort(operationId));
      const next = { ...this.#payload, pending: this.#payload.pending.filter((entry) => entry.stage.operationId !== operationId) };
      await this.persistNext(next);
      this.rebuildDurable();
      return freezeDeep({ status: "aborted" as const });
    });
  }

  async status(operationId: string): Promise<NamedMemoryOperationStatus> {
    return await this.exclusive(async () => {
      this.assertOpen();
      if (this.tier(operationId) === "session") return this.decorateSessionStatus(this.#session.status(operationId));
      const status = this.decorateStatus(this.#durable.status(operationId));
      if (status.status === "finalized") await this.ensureProjection(operationId);
      return status;
    });
  }

  async reconcile(operationId: string, binding?: LedgerCommitBinding): Promise<NamedMemoryOperationStatus> {
    return await this.exclusive(async () => {
      this.assertOpen();
      if (this.tier(operationId) === "session") {
        return this.decorateSessionStatus(this.#session.reconcile(operationId, binding));
      }
      const status = this.#durable.status(operationId);
      if (status.status === "prepared") {
        if (binding === undefined) return this.decorateStatus(status);
        return freezeDeep({ status: "finalized" as const, receipt: await this.finalizeUnlocked(operationId, binding) });
      }
      if (status.status === "finalized") await this.ensureProjection(operationId);
      return this.decorateStatus(status);
    });
  }

  async recall(input: {
    descriptor: ResolvedMemoryDescriptor;
    region: Omit<MemoryRegionKeyInput, "descriptor">;
  }): Promise<NamedMemoryRecall> {
    return await this.exclusive(async () => {
      this.assertOpen();
      return input.descriptor.retention === "session" ? this.#session.recall(input) : this.#durable.recall(input);
    });
  }

  async snapshot(): Promise<TransactionalNamedMemorySnapshot> {
    return await this.exclusive(async () => {
      this.assertOpen();
      if (this.#payload.pending.length !== 0) throw new Error("cannot snapshot Markdown memory with a prepared mutation");
      return freezeDeep(JSON.parse(canonicalJson(this.#payload.snapshot)) as TransactionalNamedMemorySnapshot);
    });
  }

  async close(): Promise<void> {
    await this.exclusive(async () => {
      if (this.#closed) return;
      if (!this.#leaseReleased) {
        const lease = await readLease(this.#leasePath);
        if (lease.token !== this.#leaseToken || lease.pid !== process.pid) {
          throw new Error("Markdown memory writer lease was lost before close");
        }
        await filesystemPhase(this.#testHooks, "close-before-lease-unlink", this.#leasePath);
        await unlink(this.#leasePath);
        this.#leaseReleased = true;
      }
      await this.#lease.close();
      this.#session = new LocalTransactionalNamedMemoryDriver();
      this.#sessionStages.clear();
      this.#closed = true;
    });
  }

  private async finalizeUnlocked(operationId: string, binding: LedgerCommitBinding): Promise<MarkdownNamedMemoryMutationReceipt> {
    const pending = this.pending(operationId);
    if (!pending) throw new Error(`unknown durable memory operation ${operationId}`);
    const committed = new DurableTransactionalNamedMemoryDriver({
      journal: new LocalTransactionalNamedMemoryJournal(this.#payload.snapshot),
    });
    const request = exactRequest(pending);
    const prepared = pending.kind === "store"
      ? committed.prepareStore(request as StoreRequest)
      : committed.prepareForget(request as ForgetRequest);
    if (prepared.operationId !== operationId) throw new Error("durable memory operation identity changed");
    const receipt = committed.finalize(operationId, binding);
    const next = {
      ...this.#payload,
      snapshot: committed.snapshot(),
      pending: this.#payload.pending.filter((entry) => entry.stage.operationId !== operationId),
      finalized: {
        ...this.#payload.finalized,
        [operationId]: {
          effects: pending.stage.effects,
          refs: pending.stage.refs,
          ...(pending.kind === "forget" && pending.stage.effects.cells.tombstoned > 0
            ? { priorRegion: this.priorRegion(pending.stage.regionKey) }
            : {}),
        },
      },
    };
    try {
      await this.persistNext(next);
      this.rebuildDurable();
    } catch (error) {
      this.rebuildDurable();
      throw error;
    }
    await this.ensureProjection(operationId);
    return this.decorateReceipt(receipt);
  }

  private rebuildDurable(): void {
    const durable = new DurableTransactionalNamedMemoryDriver({
      journal: new LocalTransactionalNamedMemoryJournal(this.#payload.snapshot),
    });
    this.#operationTier = new Map(
      [...this.#operationTier].filter(([, tier]) => tier === "session"),
    );
    const finalizedIds = new Set(this.#payload.snapshot.operations.map((entry) => entry.operationId));
    if (Object.keys(this.#payload.finalized).length !== finalizedIds.size
      || Object.keys(this.#payload.finalized).some((operationId) => !finalizedIds.has(operationId))) {
      throw new Error("durable finalized metadata does not match canonical operations");
    }
    for (const entry of this.#payload.snapshot.operations) {
      const metadata = this.#payload.finalized[entry.operationId];
      if (!metadata) throw new Error("durable finalized operation is missing metadata");
      exactKeys(metadata, ["effects", "refs", ...(metadata.priorRegion === undefined ? [] : ["priorRegion"])],
        "durable finalized metadata");
      const changed = entry.stage.kind === "forget"
        && entry.stage.effects.cells.tombstoned > 0
        && metadata.priorRegion !== undefined;
      const blobs = {
        archived: changed && this.#archiveOnForget ? 1 : 0,
        deleted: changed && !this.#archiveOnForget ? 1 : 0,
      };
      const expected = this.decorate(entry.stage, blobs, entry.derivation.region);
      if (metadata.priorRegion !== undefined) this.validatePriorRegion(entry.stage, metadata.priorRegion);
      if (canonicalJson(metadata.effects) !== canonicalJson(expected.effects)
        || canonicalJson(metadata.refs) !== canonicalJson(expected.refs)
        || (entry.stage.kind === "store" && metadata.priorRegion !== undefined)
        || (entry.stage.kind === "forget" && entry.stage.effects.cells.tombstoned > 0
          && metadata.priorRegion === undefined)) {
        throw new Error("durable finalized metadata conflicts with canonical operation");
      }
      this.#operationTier.set(entry.operationId, "durable");
    }
    for (const pending of this.#payload.pending) {
      exactKeys(pending, ["context", "kind", "stage",
        ...(pending.envelope === undefined ? [] : ["envelope"])],
        "durable prepared mutation");
      exactKeys(pending.context, ["descriptor", "origin", "region", "site"], "durable prepared context");
      exactKeys(pending.context.origin, ["evaluationOrdinal", "invocationCorrelation"], "durable prepared origin");
      const request = exactRequest(pending);
      const stage = pending.kind === "store"
        ? durable.prepareStore(request as StoreRequest)
        : durable.prepareForget(request as ForgetRequest);
      const prior = pending.kind === "forget" ? this.regionProjection(stage.regionKey) : undefined;
      const changed = pending.kind === "forget" && stage.effects.cells.tombstoned > 0
        && prior !== undefined;
      const expected = this.decorate(stage, {
        archived: changed && this.#archiveOnForget ? 1 : 0,
        deleted: changed && !this.#archiveOnForget ? 1 : 0,
      }, pathContext(pending.context));
      if (canonicalJson(expected) !== canonicalJson(pending.stage)) {
        throw new Error("durable prepared mutation does not match canonical stage");
      }
      this.#operationTier.set(stage.operationId, "durable");
    }
    this.#durable = durable;
  }

  private decorate(
    stage: PreparedNamedMemoryMutation,
    blobs: MarkdownNamedMemoryEffects["blobs"],
    context: RegionDerivation,
  ): MarkdownPreparedNamedMemoryMutation {
    return freezeDeep({
      ...stage,
      effects: { cells: { ...stage.effects.cells }, blobs: { ...blobs } },
      refs: {
        ...stage.refs,
        canonical: "substrate:.agape-memory-v1/state.json",
        projection: `substrate:${this.projectionRelative(stage.regionKey, stage.generation, context)}`,
        ...(stage.kind === "forget" && blobs.archived > 0
          ? { archive: `substrate:${this.archiveRelative(stage.regionKey, stage.operationId, stage.generation, context)}` }
          : {}),
      },
    });
  }

  private decorateReceipt(receipt: NamedMemoryMutationReceipt): MarkdownNamedMemoryMutationReceipt {
    const metadata = this.#payload.finalized[receipt.operationId];
    if (!metadata) throw new Error("durable finalized mutation is missing projection metadata");
    return freezeDeep({ ...receipt, effects: metadata.effects, refs: metadata.refs });
  }

  private decorateSessionReceipt(receipt: NamedMemoryMutationReceipt): MarkdownNamedMemoryMutationReceipt {
    const stage = this.#sessionStages.get(receipt.operationId);
    if (!stage) throw new Error("session mutation is missing its prepared stage metadata");
    return freezeDeep({ ...receipt, effects: stage.effects, refs: stage.refs });
  }

  private decorateSessionStatus(status: NamedMemoryOperationStatus): NamedMemoryOperationStatus {
    if (status.status === "prepared") {
      const stage = this.#sessionStages.get(status.stage.operationId);
      if (!stage) throw new Error("session mutation is missing its prepared stage metadata");
      return freezeDeep({ status: "prepared" as const, stage });
    }
    if (status.status === "finalized") {
      return freezeDeep({ status: "finalized" as const, receipt: this.decorateSessionReceipt(status.receipt) });
    }
    return status;
  }

  private preflightPathContext(request: NamedMemoryMutationContext): RegionDerivation {
    const context = pathContext(requestContext(request));
    this.renderPathTemplate(context, 0);
    return context;
  }

  private finalizedStage(receipt: NamedMemoryMutationReceipt): MarkdownPreparedNamedMemoryMutation {
    const decorated = this.decorateReceipt(receipt);
    const { ledger: _ledger, ...stage } = decorated;
    return freezeDeep(stage);
  }

  private decorateStatus(status: NamedMemoryOperationStatus): NamedMemoryOperationStatus {
    if (status.status === "prepared") {
      return freezeDeep({ status: "prepared" as const, stage: this.pending(status.stage.operationId)?.stage ?? status.stage });
    }
    if (status.status === "finalized") {
      return freezeDeep({ status: "finalized" as const, receipt: this.decorateReceipt(status.receipt) });
    }
    return status;
  }

  private pending(operationId: string): StoredPendingMutation | undefined {
    return this.#payload.pending.find((entry) => entry.stage.operationId === operationId);
  }

  private tier(operationId: string): "session" | "durable" | undefined { return this.#operationTier.get(operationId) }

  private regionProjection(regionKey: string): string | undefined {
    const region = this.#payload.snapshot.regions.find((entry) => entry.regionKey === regionKey);
    return region === undefined ? undefined : this.renderProjection(region);
  }

  private renderProjection(region: TransactionalNamedMemorySnapshot["regions"][number]): string {
    const lines = [
      "<!-- Derived Agape memory projection. Editing this file does not edit canonical memory. -->",
      `# ${region.descriptor.name}`, "", `- generation: ${region.generation}`,
      `- state: ${region.state}`, `- cells: ${region.cells.length}`, "",
    ];
    for (const cell of region.cells) lines.push(`## ${cell.cellId}`, "", "```json", canonicalJson(cell.value), "```", "");
    return `${lines.join("\n")}\n`;
  }

  private async ensureProjection(operationId: string): Promise<void> {
    const operation = this.#payload.snapshot.operations.find((entry) => entry.operationId === operationId);
    const metadata = this.#payload.finalized[operationId];
    if (!operation || !metadata) throw new Error("finalized durable operation is missing canonical metadata");
    if (operation.stage.kind === "forget" && metadata.effects.blobs.archived > 0) {
      if (metadata.priorRegion === undefined) throw new Error("archived forget is missing its canonical prior region");
      const archive = this.absoluteFromRelative(this.archiveRelative(
        operation.stage.regionKey, operationId, operation.stage.generation, operation.derivation.region,
      ));
      await this.atomicWrite(archive, this.renderProjection(metadata.priorRegion));
    }
    const region = this.#payload.snapshot.regions.find((entry) => entry.regionKey === operation.stage.regionKey);
    if (!region) throw new Error("finalized durable operation refers to a missing region");
    await this.atomicWrite(
      this.absoluteFromRelative(this.projectionRelative(region.regionKey, region.generation, operation.derivation.region)),
      this.renderProjection(region),
    );
  }

  private priorRegion(regionKey: string): TransactionalNamedMemorySnapshot["regions"][number] {
    const region = this.#payload.snapshot.regions.find((entry) => entry.regionKey === regionKey);
    if (!region) throw new Error("forget mutation is missing its canonical prior region");
    return freezeDeep(JSON.parse(canonicalJson(region)) as TransactionalNamedMemorySnapshot["regions"][number]);
  }

  private validatePriorRegion(
    stage: PreparedNamedMemoryMutation,
    prior: TransactionalNamedMemorySnapshot["regions"][number],
  ): void {
    if (prior.regionKey !== stage.regionKey || prior.generation !== stage.generation
      || prior.state !== "open" || prior.cells.length !== stage.effects.cells.tombstoned) {
      throw new Error("canonical prior region conflicts with finalized forget effects");
    }
    const operations = new Map(this.#payload.snapshot.operations.map((entry) => [entry.operationId, entry]));
    const forgetTick = operations.get(stage.operationId)?.receipt.ledger.tick ?? Number.MAX_SAFE_INTEGER;
    for (const cell of prior.cells) {
      decodeExactValue(cell.value, prior.descriptor.schema);
      const operation = operations.get(cell.operationId);
      if (!operation || operation.stage.kind !== "store"
        || operation.stage.regionKey !== prior.regionKey
        || operation.stage.generation !== prior.generation
        || operation.stage.cellId !== cell.cellId
        || operation.stage.originId !== cell.originId
        || operation.stage.valueHash !== cell.value.valueHash
        || operation.receipt.ledger.tick >= forgetTick) {
        throw new Error("canonical prior region contains a cell inconsistent with operation history");
      }
    }
  }

  private renderPathTemplate(context: RegionDerivation, generation: number): string | undefined {
    if (this.#pathTemplate === undefined) return undefined;
    const values: Record<string, string | undefined> = {
      project: context.dimensions.project === undefined
        ? undefined : opaqueSegment("template-project", context.dimensions.project),
      lineage: opaqueSegment("template-lineage", context.dimensions.lineage!),
      agent: opaqueSegment("template-agent", context.dimensions.agent!),
      mem: opaqueSegment("template-mem", context.descriptor.name),
      user: context.dimensions.user === undefined
        ? undefined : opaqueSegment("template-user", context.dimensions.user),
      generation: opaqueSegment("template-generation", String(generation)),
    };
    return this.#pathTemplate.split("/").map((segment) => {
      const match = /^\{([^{}]+)\}$/.exec(segment);
      if (!match) return segment;
      const value = values[match[1]!];
      if (value === undefined) {
        throw new Error(`Markdown memory path placeholder ${segment} is unavailable for this descriptor`);
      }
      return value;
    }).join(sep);
  }

  private projectionRelative(regionKey: string, generation: number, context: RegionDerivation): string {
    const prefix = this.renderPathTemplate(context, generation);
    return join(...(prefix === undefined ? [] : [prefix]),
      "regions", opaqueSegment("region", regionKey), `generation-${generation}`, this.#entrypoint);
  }

  private archiveRelative(
    regionKey: string,
    operationId: string,
    generation: number,
    context: RegionDerivation,
  ): string {
    const prefix = this.renderPathTemplate(context, generation);
    return join(...(prefix === undefined ? [] : [prefix]),
      "regions", opaqueSegment("region", regionKey), ".archive", `${opaqueSegment("operation", operationId)}.md`);
  }

  private absoluteFromRelative(child: string): string {
    const absolute = resolve(this.#root, child);
    const rel = relative(this.#root, absolute);
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error("Markdown memory path escaped its configured root");
    }
    return absolute;
  }

  private async persistNext(next: CanonicalPayload): Promise<void> {
    await this.assertLeaseOwnership();
    try {
      const document = JSON.parse(await readFile(this.#statePath, "utf8")) as CanonicalDocument;
      exactKeys(document, ["checksum", "payload", "version"], "Markdown memory canonical document");
      if (document.checksum !== checksum(document.payload)
        || document.payload.revision !== this.#payload.revision
        || document.checksum !== this.#expectedChecksum) {
        throw new Error("Markdown memory revision changed under its active writer");
      }
    } catch (error) {
      if (!isMissing(error) || this.#payload.revision !== 0) throw error;
    }
    const payload: CanonicalPayload = { ...next, revision: this.#payload.revision + 1 };
    const document: CanonicalDocument = { version: 1, checksum: checksum(payload), payload };
    const encoded = `${canonicalJson(document)}\n`;
    try {
      await this.atomicWrite(this.#statePath, encoded);
    } catch (error) {
      try {
        const observed = await readFile(this.#statePath, "utf8");
        if (observed === encoded) {
          this.#payload = freezeDeep(payload);
          this.#expectedChecksum = document.checksum;
          return;
        }
      } catch {
        // The intended revision is not observably committed.
      }
      this.#fenced = true;
      throw new Error("Markdown memory state write failed and the writer is fenced", { cause: error });
    }
    this.#payload = freezeDeep(payload);
    this.#expectedChecksum = document.checksum;
  }

  private async assertLeaseOwnership(): Promise<void> {
    const lease = await readLease(this.#leasePath);
    if (lease.token !== this.#leaseToken || lease.pid !== process.pid
      || lease.processStart !== await processStartMarker(process.pid)) {
      throw new Error("Markdown memory writer lease was lost");
    }
  }

  private async cleanupKnownProjectionTemps(): Promise<void> {
    const directories = new Set<string>();
    const refs = [
      ...this.#payload.pending.map((entry) => entry.stage.refs),
      ...Object.values(this.#payload.finalized).map((entry) => entry.refs),
    ];
    for (const references of refs) {
      for (const key of ["projection", "archive"] as const) {
        const reference = references[key];
        if (reference === undefined || !reference.startsWith("substrate:")) continue;
        const absolute = this.absoluteFromRelative(reference.slice("substrate:".length));
        directories.add(dirname(absolute));
      }
    }
    for (const directory of directories) {
      try {
        await cleanupOrphanWriteTemps(directory);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
  }

  private async atomicWrite(path: string, contents: string): Promise<void> {
    const parent = dirname(path);
    this.absoluteFromRelative(relative(this.#root, path));
    await this.ensureOwnedDirectory(parent);
    const parentBefore = await lstat(parent);
    const parentReal = await realpath(parent);
    try {
      const existing = await lstat(path);
      if (existing.isSymbolicLink() || !existing.isFile()) throw new Error("Markdown memory target must be a regular file");
    } catch (error) { if (!isMissing(error)) throw error }
    const processStart = await processStartMarker(process.pid);
    const temporary = join(parent,
      `.tmp-${process.pid}-${processStart ?? "unknown"}-${randomBytes(24).toString("hex")}`);
    const handle = await openFile(temporary, "wx", 0o600);
    let closed = false;
    let renamed = false;
    try {
      if (path === this.#statePath) await filesystemPhase(this.#testHooks, "state-temp-opened", temporary);
      await this.verifyTemporaryPlacement(parent, parentReal, parentBefore, temporary);
      await handle.writeFile(contents, "utf8");
      await handle.sync();
      if (path === this.#statePath) {
        await filesystemPhase(this.#testHooks, "state-before-rename", temporary);
      } else {
        await filesystemPhase(this.#testHooks, "projection-before-rename", temporary);
      }
      await this.verifyTemporaryPlacement(parent, parentReal, parentBefore, temporary);
      await handle.close();
      closed = true;
      // Node exposes no renameat/dirfd primitive. The owned, non-group/world-writable
      // directory above is the cross-process trust boundary; a same-principal actor
      // can still mutate it after this last check and is outside this driver's threat model.
      await this.verifyTemporaryPlacement(parent, parentReal, parentBefore, temporary);
      await rename(temporary, path);
      renamed = true;
      if (path === this.#statePath) await filesystemPhase(this.#testHooks, "state-after-rename", path);
      try {
        if (path === this.#statePath) {
          await filesystemPhase(this.#testHooks, "state-before-directory-sync", parent);
        }
        const directory = await openFile(parent, "r");
        try { await directory.sync() } finally { await directory.close() }
        if (path === this.#statePath) {
          await filesystemPhase(this.#testHooks, "state-after-directory-sync", parent);
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (!["EACCES", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"].includes(String(code))) {
          throw error;
        }
      }
    } catch (error) {
      if (!renamed) {
        if (!closed) await handle.truncate(0).catch(() => undefined);
        await handle.close().catch(() => undefined);
        await unlink(temporary).catch(() => undefined);
      }
      throw error;
    }
  }

  private async verifyTemporaryPlacement(
    parent: string,
    expectedReal: string,
    expectedStat: { dev: number | bigint; ino: number | bigint },
    temporary: string,
  ): Promise<void> {
    const current = await lstat(parent);
    if (!current.isDirectory() || current.isSymbolicLink()
      || String(current.dev) !== String(expectedStat.dev)
      || String(current.ino) !== String(expectedStat.ino)
      || await realpath(parent) !== expectedReal) {
      throw new Error("Markdown memory parent directory identity changed");
    }
    const temporaryReal = await realpath(temporary);
    if (dirname(temporaryReal) !== expectedReal) {
      throw new Error("Markdown memory temporary path escaped its verified parent");
    }
  }

  private async ensureOwnedDirectory(path: string): Promise<void> {
    this.absoluteFromRelative(relative(this.#root, path));
    let current = this.#root;
    for (const part of relative(this.#root, path).split(sep).filter(Boolean)) {
      current = join(current, part);
      try {
        const existing = await lstat(current);
        assertTrustedDirectory(existing, "Markdown memory path");
        continue;
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      await mkdir(current, { mode: 0o700 });
      const stat = await lstat(current);
      assertTrustedDirectory(stat, "Markdown memory path");
    }
  }

  private assertOpen(): void {
    if (this.#closed) throw new Error("Markdown memory driver is closed");
    if (this.#leaseReleased) throw new Error("Markdown memory driver is closing");
    if (this.#fenced) throw new Error("Markdown memory writer is fenced");
  }

  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(work);
    this.#tail = run.then(() => undefined, () => undefined);
    return await run;
  }
}
