export const LANGUAGE_SPEC_VERSION = "v1.0.0-alpha.2026.7.11.1";

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
  [key: string]: number;
}

export interface ReplayResult {
  ok: boolean;
  head: number;
  headHash: string;
  events: LedgerEvent[];
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
  replay(recording: unknown): Promise<ReplayResult>;
  oracleStats(): Promise<OracleStats>;
  canonicalHash(events: LedgerEvent[]): Promise<string>;
}
