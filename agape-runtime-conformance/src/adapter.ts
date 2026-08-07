export const LANGUAGE_SPEC_VERSION = "v1.0.0-beta.2026.8.6.0";

export type RuntimeKind = "rust-local" | "studio-local" | "cloud" | "soma" | string;

export interface AgentRef {
  template: string;
  instanceId: string;
  generation?: number;
}

export interface LedgerEvent {
  tick: number;
  etype: string;
  subject: string;
  payload?: unknown;
  corr?: string | null;
  agent: string;
  ts?: number;
  [key: string]: unknown;
}

export interface HealthResult {
  runtimeId: string;
  runtimeKind: RuntimeKind;
  implementationVersion: string;
  languageSpecVersion: string;
  conformanceSuiteVersion?: string;
  memorySchemaVersion?: string;
  canonicalLedgerVersion?: string;
  ledgerHead: number;
  provider: { status: string; [key: string]: unknown };
}

export interface Diagnostic {
  category: string;
  message?: string;
  location?: unknown;
}

export interface CheckResult {
  ok: boolean;
  diagnostics: Diagnostic[];
}

export interface RunResult {
  ok: boolean;
  head: number;
  headHash: string;
  events: LedgerEvent[];
  recording?: unknown;
  error?: Diagnostic;
}

export interface LedgerReadQuery {
  agent?: string;
  etype?: string;
  subject?: string;
  fromTick?: number;
  toTick?: number;
}

export interface AgentRespondInput {
  agent: AgentRef;
  task: string;
  stimulus: { kind: string; text: string };
  testMode?: Record<string, unknown>;
}

export interface MemoryPacket {
  consulted: boolean;
  empty?: boolean;
  summaries?: unknown[];
  chunks?: unknown[];
  facts?: unknown[];
  triples?: unknown[];
  vectors?: unknown[];
  lessons?: unknown[];
  corrections?: unknown[];
  text?: string;
  [key: string]: unknown;
}

export interface AgentTurnResult {
  ok: boolean;
  events: LedgerEvent[];
  memoryPacket: MemoryPacket;
  output?: unknown;
}

export interface ExperienceFact {
  key: string;
  value: string;
}

export interface ExperienceTriple {
  s: string;
  p: string;
  o: string;
}

export interface DecomposedExperience {
  originTick: number;
  raw: string;
  summary: string;
  facts: ExperienceFact[];
  triples: ExperienceTriple[];
  vectorTexts: string[];
}

export interface ImplementationLearningLoopInput {
  agent: AgentRef;
  task: string;
  firstCandidateSource: string;
  expectedFirstFailure: string;
  revisionRequest: string;
  revisedMustContain: string[];
  revisedMustNotContain?: string[];
}

export interface ImplementationLearningLoopResult {
  firstTurn: AgentTurnResult;
  firstSource: string;
  firstCheck: CheckResult;
  failureExperience: DecomposedExperience;
  failureMemory: MemoryPacket;
  secondTurn: AgentTurnResult;
  revisedSource: string;
  revisedCheck: CheckResult;
  successExperience: DecomposedExperience;
  finalMemory: MemoryPacket;
  events: LedgerEvent[];
}

export interface ArtifactInput {
  kind: string;
  uri: string;
  title: string;
  text: string;
}

export interface MemoryIngestInput {
  agent: AgentRef;
  artifact: ArtifactInput;
}

export interface MemoryIngestResult {
  created: boolean;
  sourceHash: string;
  summary: string;
  chunkCount: number;
  factCount: number;
  tripleCount: number;
  vectorCount: number;
  events: LedgerEvent[];
}

export interface MemoryContextInput {
  agent: AgentRef;
  task: string;
}

export interface MemoryCell {
  originTick: number;
  taint: "settled" | "graded" | "raw" | string;
  basisHead?: number;
  validThrough?: number;
  dependencyScope?: unknown;
  sourceHash?: string;
  [key: string]: unknown;
}

export interface MemoryInspectResult {
  agent: AgentRef;
  counts: {
    summaries: number;
    chunks: number;
    facts: number;
    triples: number;
    vectors: number;
    [key: string]: number;
  };
  summaries: MemoryCell[];
  chunks: MemoryCell[];
  facts: MemoryCell[];
  triples: MemoryCell[];
  vectors: MemoryCell[];
  recentEvents: LedgerEvent[];
}

export interface ExperienceInput {
  agent: AgentRef;
  kind: "check" | "test" | "run" | "tool" | "provider" | "code" | string;
  subject: string;
  ok: boolean;
  text: string;
}

export interface UserCorrectionInput {
  agent: AgentRef;
  subject: string;
  text: string;
  supersedes?: string;
}

export interface OracleStats {
  providerCalls: number;
  toolCalls: number;
  decompositionCalls: number;
  embeddingCalls: number;
  /** Required when named-memory scenarios are supported (SPEC 16.5). */
  memoryDriverCalls?: number;
  /** Mutating prepare/finalize/abort calls; replay must not increase this (SPEC 16.5). */
  memoryMutationCalls?: number;
  [key: string]: number | undefined;
}

export interface RuntimeIdentityContext {
  projectSubject: string;
  sessionLineageId: string;
  sessionId: string;
  conversationId: string;
  user?: { issuer: string; subject: string; verified: true };
}

export type PersistedSchema =
  | { kind: "scalar"; scalar: "int" | "float" | "bool" | "text" | "null" }
  | { kind: "enum"; name: string; variants: string[] }
  | { kind: "array"; items: PersistedSchema }
  | { kind: "struct"; name: string; fields: Record<string, PersistedSchema> };

export interface NamedMemoryDescriptor {
  name: string;
  schema: PersistedSchema;
  modality: "opaque" | "episodic" | "semantic";
  scopes: Array<"project" | "user">;
  retention: "session" | "durable";
}

export interface NamedMemoryProgram {
  programId: string;
  manifestId: string;
  agentTemplate: string;
  agentAliases: string[];
  descriptor: NamedMemoryDescriptor;
}

export interface NamedMemoryAgentInstance {
  alias: string;
  template: string;
  stableInstanceId: string;
  spawnTick: number;
}

export interface NamedMemorySession {
  sessionHandle: string;
  runtimeInstanceId: string;
  agents: Record<string, NamedMemoryAgentInstance>;
  descriptorHash: string;
  schemaHash: string;
}

export interface ScriptedRecallCandidate {
  storeOperationId: string;
  score: number;
}

export interface NamedMemoryTestMode {
  recallCandidates?: Record<string, ScriptedRecallCandidate[]>;
  loseFinalizeAckAfterLedger?: string[];
}

export interface NamedMemoryOpenInput {
  name: string;
  driverNamespace: string;
  driver: { kind: "local" | "markdown"; topK?: number };
  program: NamedMemoryProgram;
  identity: RuntimeIdentityContext;
  identityCapabilities: Array<"project" | "user">;
  record?: boolean;
  testMode?: NamedMemoryTestMode;
}

export interface NamedMemorySessionStartResult {
  ok: boolean;
  session?: NamedMemorySession;
  error?: Diagnostic;
}

export type NamedMemoryOperation =
  | { id: string; site: string; operation: "store"; value: unknown }
  | { id: string; site: string; operation: "recall"; query: string; cap?: number }
  | { id: string; site: string; operation: "forget" };

export interface ExactMemoryEnvelope {
  value: unknown;
  schema: PersistedSchema;
  schemaHash: string;
  descriptorHash: string;
  cellId: string;
  score: number;
  originRef: string;
  generation: number;
  taint: "raw";
}

export interface NamedMemoryMutationAck {
  operationId: string;
  operation: "store" | "forget";
  generation: number;
  effects: Record<string, number | boolean | string>;
  refs: string[];
}

export interface NamedMemoryOperationResult {
  id: string;
  ok: boolean;
  resultType?: string;
  values?: ExactMemoryEnvelope[];
  generation?: number;
  operationId?: string;
  receipt?: LedgerEvent;
  mutationAck?: NamedMemoryMutationAck;
}

export interface NamedMemoryInvocationFault {
  code: "MissingScopeSubject" | "MemoryDriverFailure" | "TypeMismatch" | string;
  scope?: "project" | "user";
  message?: string;
}

export interface NamedMemoryTraceEntry {
  /** Monotonic within the opened/resumed runtime session, across invocations. */
  sequence: number;
  phase: "prepare" | "ledger-commit" | "finalize" | "reconcile" | "recall" | "close" | "resume";
  operationId?: string;
  operationResultId?: string;
  etype?: string;
}

export interface NamedMemoryInvocationResult {
  ok: boolean;
  invocationId: string;
  agentInstanceId: string;
  operations: NamedMemoryOperationResult[];
  fault?: NamedMemoryInvocationFault;
  events: LedgerEvent[];
  trace: NamedMemoryTraceEntry[];
}

export interface NamedMemoryCloseResult {
  ok: boolean;
  destroyed: boolean;
  closedSessionHandle: string;
  closedRuntimeInstanceId: string;
  agentInstanceIds: Record<string, string>;
  headHash: string;
  snapshot: unknown;
  recording?: unknown;
  invocations: NamedMemoryInvocationResult[];
  mutationAcks: NamedMemoryMutationAck[];
}

export interface NamedMemoryResumeInput {
  name: string;
  driverNamespace: string;
  driver: { kind: "markdown"; topK?: number };
  program: NamedMemoryProgram;
  identity: RuntimeIdentityContext;
  identityCapabilities: Array<"project" | "user">;
  snapshot: unknown;
  record?: boolean;
  testMode?: NamedMemoryTestMode;
}

export interface NamedMemoryResumeFault {
  code: "SnapshotBindingMismatch" | "SnapshotAuthenticationFailed" | string;
  binding?: "programId" | "manifestId" | "ledgerHead" | "sessionLineageId" | "projectSubject";
  message?: string;
}

export interface NamedMemoryResumeResult extends NamedMemorySessionStartResult {
  fault?: NamedMemoryResumeFault;
}

export interface NamedMemoryReplayResult {
  invocations: NamedMemoryInvocationResult[];
  mutationAcks: NamedMemoryMutationAck[];
}

export interface ReplayResult {
  ok: boolean;
  head: number;
  headHash: string;
  events: LedgerEvent[];
  namedMemory?: NamedMemoryReplayResult;
}

export interface TraceValidationResult {
  ok: boolean;
  diagnostics: Diagnostic[];
  events: LedgerEvent[];
}

export interface ExternalSourceResult {
  beforeArrival: RunResult;
  afterArrival: RunResult;
  liveBeforeArrival: boolean;
  quiescentAfterArrival: boolean;
}

export interface ProjectionCell {
  key: string;
  value: unknown;
  originTick: number;
  taint: "settled" | "graded" | "raw" | string;
  basisHead: number;
  validThrough: number;
  dependencyScope: string[] | "global";
  stale: boolean;
  sourceEvent?: LedgerEvent;
}

export interface Conflict {
  subject: string;
  invariant: string;
  facts: unknown[];
  detectedAt: number;
  status: "open" | "resolved" | "ignored";
}

export interface GateProfile {
  id: string;
  gateSite: string;
  provider: string;
  model: string;
  schemaHash: string;
  promptTemplateHash: string;
  policyId: string;
  scoreFunction: string;
  calibrationPool: string;
  status: "active" | "stale" | "retired";
  calibrationHead: number;
  basis: "Conformal" | "Calibrated" | string;
}

export interface ProjectionInspectResult {
  cells: ProjectionCell[];
  conflicts: Conflict[];
  gateProfiles: GateProfile[];
}

export interface ProjectionScenarioInput {
  name: string;
  facts: Array<{ subject: string; key: string; value: unknown; taint: "settled" | "graded" | "raw"; singleValued?: boolean }>;
  mutation?: { subject: string; key: string; value: unknown; taint: "settled" | "graded" | "raw" };
}

export interface CalibrationScenarioInput {
  gateSite: string;
  enumVariants: string[];
  provider: { backend: string; model: string; exposesLogprobs?: boolean };
  policy: { basis: "conformal" | "threshold" | "calibrated"; alpha?: number; threshold?: number; margin?: number; readiness?: number; floor?: number };
  labels: Array<{ scores: Record<string, number>; label: string }>;
  judgment: { scores?: Record<string, number>; samples?: string[] };
  drift?: Partial<{ provider: string; model: string; schemaHash: string; promptTemplateHash: string; policyId: string; scoreFunction: string; calibrationPool: string }>;
}

export interface CalibrationScenarioResult {
  decision: {
    committed: string | "abstained";
    basis: "Threshold" | "Conformal" | "Calibrated" | "Principal" | string;
    margin: number;
    predictionSet?: string[];
    usedProfileId?: string;
  };
  profile: GateProfile;
  fallbackDraws: number;
  diagnostics: Diagnostic[];
  events: LedgerEvent[];
}

export interface ConfigResolutionInput {
  specDefaults?: Record<string, unknown>;
  globalConfig?: Record<string, unknown>;
  projectManifest?: Record<string, unknown>;
  env?: Record<string, string>;
}

export interface ConfigResolutionResult {
  resolved: Record<string, unknown>;
  sources: Record<string, "spec" | "global" | "project" | "env" | "derived">;
  diagnostics: Diagnostic[];
}

export interface MultiRunScenarioInput {
  source: string;
  runs: number;
  observation: "ledger-head" | "committed-outcome" | "custom";
  testMode?: Record<string, unknown>;
}

export interface MultiRunScenarioResult {
  runs: RunResult[];
  observations: string[];
  nonEquivalentPairs: number;
  violationRate: number;
  betaBound?: number;
}

export interface IdempotencyScenarioInput {
  source: string;
  repeatedInput: unknown;
  repetitions: number;
  testMode?: Record<string, unknown>;
}

export interface IdempotencyScenarioResult {
  events: LedgerEvent[];
  deduped: boolean;
  committedOutcomes: string[];
  sideEffectCount: number;
}

export interface RuntimeConformanceAdapter {
  reset(): Promise<void>;
  health(): Promise<HealthResult>;
  run(input: { source: string; record?: boolean; testMode?: Record<string, unknown> }): Promise<RunResult>;
  check(input: { source: string; manifest?: Record<string, unknown> }): Promise<CheckResult>;
  ledgerRead(query?: LedgerReadQuery): Promise<LedgerEvent[]>;
  agentRespond(input: AgentRespondInput): Promise<AgentTurnResult>;
  memoryIngest(input: MemoryIngestInput): Promise<MemoryIngestResult>;
  memoryContext(input: MemoryContextInput): Promise<MemoryPacket>;
  memoryInspect(input: { agent: AgentRef }): Promise<MemoryInspectResult>;
  configRead(): Promise<Record<string, unknown>>;
  configWrite(patch: Record<string, unknown>): Promise<void>;
  recordExperience(input: ExperienceInput): Promise<void>;
  recordUserCorrection(input: UserCorrectionInput): Promise<void>;
  implementationLearningLoop(input: ImplementationLearningLoopInput): Promise<ImplementationLearningLoopResult>;
  triggerExternalSource(input: { source: string; sourceName: string; arrival: unknown; testMode?: Record<string, unknown> }): Promise<ExternalSourceResult>;
  validateLedgerTrace(events: LedgerEvent[]): Promise<TraceValidationResult>;
  rebuildMemoryFromRecording(recording: unknown): Promise<Record<string, MemoryInspectResult>>;
  seedProjection(input: ProjectionScenarioInput): Promise<ProjectionInspectResult>;
  projectionInspect(input?: { agent?: AgentRef; subject?: string }): Promise<ProjectionInspectResult>;
  calibrationScenario(input: CalibrationScenarioInput): Promise<CalibrationScenarioResult>;
  resolveConfig(input: ConfigResolutionInput): Promise<ConfigResolutionResult>;
  multiRunScenario(input: MultiRunScenarioInput): Promise<MultiRunScenarioResult>;
  idempotencyScenario(input: IdempotencyScenarioInput): Promise<IdempotencyScenarioResult>;
  openNamedMemorySession(input: NamedMemoryOpenInput): Promise<NamedMemorySessionStartResult>;
  invokeNamedMemory(input: {
    sessionHandle: string;
    agentInstanceId: string;
    invocationId: string;
    operations: NamedMemoryOperation[];
  }): Promise<NamedMemoryInvocationResult>;
  closeNamedMemorySession(input: { sessionHandle: string }): Promise<NamedMemoryCloseResult>;
  resumeNamedMemorySession(input: NamedMemoryResumeInput): Promise<NamedMemoryResumeResult>;
  replay(recording: unknown): Promise<ReplayResult>;
  oracleStats(): Promise<OracleStats>;
  canonicalHash(events: LedgerEvent[]): Promise<string>;
}
