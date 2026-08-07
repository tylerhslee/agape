import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { describe, it, expect, afterAll } from "vitest";
import { parse } from "../src/parser.js";
import { run as runtimeRun } from "../src/interp.js";
import { MockProvider, type StructuredSchema } from "../src/runtime.js";

import { LocalMemoryDriver } from "../src/memory.js";
const TEST_MEMORY_ROOT = mkdtempSync(join(tmpdir(), "agape-schema-suite-"));
afterAll(async () => {
  await rm(TEST_MEMORY_ROOT, { recursive: true, force: true });
});
function run(program: Parameters<typeof runtimeRun>[0], opts: Parameters<typeof runtimeRun>[1] = {}) {
  return runtimeRun(program, { memoryRoot: TEST_MEMORY_ROOT, ...opts, memory: opts.memory ?? new LocalMemoryDriver() });
}

// Records every schema the runtime compiles and hands to the provider seam, while returning a
// schema-conforming value (via MockProvider's own generator) so the run completes.
class SchemaRecordingProvider extends MockProvider {
  readonly schemas: { name?: string; schema: StructuredSchema }[] = [];
  override async structured(prompt: string, schema: StructuredSchema, name?: string): Promise<unknown> {
    this.schemas.push({ name, schema });
    return super.structured(prompt, schema, name);
  }
}

// Assert the strict constrained-decoding invariants (§8) hold recursively: every object sets
// additionalProperties:false and lists EVERY property in required[], and only the supported keyword
// subset appears. This is exactly what OpenAI `json_schema` strict:true / Gemini response schemas require.
function assertStrict(schema: StructuredSchema, path: string): void {
  const okTypes = ["object", "array", "string", "integer", "number", "boolean", "null"];
  expect(okTypes, `${path}: unsupported type '${(schema as { type: string }).type}'`).toContain((schema as { type: string }).type);
  if (schema.type === "object") {
    expect(schema.additionalProperties, `${path}: object must set additionalProperties:false`).toBe(false);
    const props = Object.keys(schema.properties);
    for (const p of props) {
      expect(schema.required, `${path}: property '${p}' must appear in required[]`).toContain(p);
      assertStrict(schema.properties[p]!, `${path}.${p}`);
    }
    // required must not name a property that does not exist
    for (const r of schema.required) expect(props, `${path}: required names unknown property '${r}'`).toContain(r);
  } else if (schema.type === "array") {
    assertStrict(schema.items, `${path}[]`);
  }
}

// The fact-checker's real structured types (mirrored inline so the kernel suite stays self-contained):
// nested structs, arrays of structs, and enums — the shapes a real program actually sends.
const FACT_CHECKER_TYPES = `
enum ClaimKind { Factual, Opinionated }
enum FactVerdict { Supported, WeaklySupported, Unsupported, Contradicted, NotCheckable }

struct ResearchQuery { query_id: text, query: text, purpose: text }
struct ResearchPlan  { subject: text, queries: ResearchQuery[] }

struct AtomicClaim { claim_id: text, statement: text, kind: ClaimKind, role: text }
struct ClaimBundle { subject: text, claims: AtomicClaim[] }

struct Verification {
  claim_id: text, claim: text, verification_question: text,
  claim_kind: ClaimKind, verdict: FactVerdict,
  support_evidence: text, challenge_evidence: text, criteria: text, note: text
}
struct VerificationAudit { subject: text, claims: Verification[] }
struct PublishedAnswer   { prose: text, verification: VerificationAudit }

agent Sender {
  on awake {
    ResearchPlan     plan  = self <- "plan";
    ClaimBundle      bundle = self <- "claims";
    VerificationAudit audit = self <- "audit";
    PublishedAnswer  answer = self <- "answer";
    say(plan.subject);
  }
}
spawn Sender s;
awake s;
`;

describe("structured schema generator (strict-mode conformance, §8)", () => {
  it("emits strict-conformant schemas for the fact-checker's real nested types", async () => {
    const provider = new SchemaRecordingProvider();
    const r = await run(parse(FACT_CHECKER_TYPES), { provider });
    // no schema was rejected and no mismatch occurred
    expect(r.ledger.events.find((e) => e.etype === "TypeMismatch")).toBeUndefined();
    expect(r.ledger.events.map((e) => e.etype)).not.toContain("AgentCrashed");
    expect(provider.schemas.length).toBe(4);
    for (const { name, schema } of provider.schemas) assertStrict(schema, name ?? "reply");
  });

  it("renders enums as string enums and recurses into arrays of structs", async () => {
    const provider = new SchemaRecordingProvider();
    await run(parse(FACT_CHECKER_TYPES), { provider });
    // the seam name is the binding variable (plan, audit), not the type name
    const plan = provider.schemas.find((s) => s.name === "plan")?.schema as any;
    expect(plan.type).toBe("object");
    expect(plan.required).toEqual(["subject", "queries"]);
    expect(plan.additionalProperties).toBe(false);
    expect(plan.properties.queries.type).toBe("array");
    // the array item is itself a strict object with every field required
    expect(plan.properties.queries.items).toMatchObject({
      type: "object",
      required: ["query_id", "query", "purpose"],
      additionalProperties: false,
    });
    // enum fields become string enums
    const audit = provider.schemas.find((s) => s.name === "audit")?.schema as any;
    const row = audit.properties.claims.items;
    expect(row.properties.claim_kind).toEqual({ type: "string", enum: ["Factual", "Opinionated"] });
    expect(row.properties.verdict).toEqual({
      type: "string",
      enum: ["Supported", "WeaklySupported", "Unsupported", "Contradicted", "NotCheckable"],
    });
  });
});

// A provider whose structured() REJECTS the request — a connector error (HTTP 4xx, network, refusal).
class RejectingProvider extends MockProvider {
  calls = 0;
  constructor(private readonly status?: number, private readonly detail = "boom") { super(); }
  override async structured(): Promise<unknown> {
    this.calls++;
    const err: any = new Error(this.detail);
    if (this.status !== undefined) err.status = this.status;
    throw err;
  }
}

// A provider that RETURNS a value that parses but violates the declared type (a schema-violating reply).
class WrongShapeProvider extends MockProvider {
  calls = 0;
  override async structured(): Promise<unknown> {
    this.calls++;
    return { not: "a research plan" }; // missing required fields → valueFromStructured throws
  }
}

const SEND_PLAN = `
struct ResearchQuery { query_id: text, query: text, purpose: text }
struct ResearchPlan  { subject: text, queries: ResearchQuery[] }
agent Sender {
  on awake {
    ResearchPlan plan = self <- "plan";
    say(plan.subject);
  }
}
spawn Sender s;
awake s;
`;

const SEND_PLAN_RETRY = `
struct ResearchQuery { query_id: text, query: text, purpose: text }
struct ResearchPlan  { subject: text, queries: ResearchQuery[] }
agent Sender {
  on awake {
    { ResearchPlan plan = self <- "plan"; say(plan.subject); } retry(2)
  }
}
spawn Sender s;
awake s;
`;

describe("provider/connector error vs reply-schema mismatch taxonomy (§16.4/§16.6)", () => {
  it("a connector rejection crashes (does not record TypeMismatch) and names the provider status", async () => {
    const provider = new RejectingProvider(400, "invalid request");
    const r = await run(parse(SEND_PLAN), { provider });
    const types = r.ledger.events.map((e) => e.etype);
    // it is a CRASH, not a schema mismatch
    expect(types).toContain("AgentCrashed");
    expect(types).not.toContain("TypeMismatch");
    const crashed = r.ledger.events.find((e) => e.etype === "AgentCrashed");
    const reason = (crashed?.payload as any)?.reason as string;
    expect(reason).toContain("provider seam failed");
    expect(reason).toContain("HTTP 400");
    expect(reason).toContain("invalid request");
    // a deterministic 4xx says re-asking cannot succeed
    expect(reason).toContain("re-asking cannot succeed");
    // no null entered the binding — the downstream say() never ran
    expect(r.stdout).toEqual([]);
  });

  it("a connector error is NOT retried by a retry N block (unretried crash)", async () => {
    const provider = new RejectingProvider(400, "invalid request");
    const r = await run(parse(SEND_PLAN_RETRY), { provider });
    // retry catches only TypeMismatch — the connector error propagates on the FIRST attempt
    expect(provider.calls).toBe(1);
    expect(r.ledger.events.map((e) => e.etype)).not.toContain("RetryExhausted");
    expect(r.ledger.events.map((e) => e.etype)).toContain("AgentCrashed");
  });

  it("a schema-violating REPLY records TypeMismatch and is retried by retry N", async () => {
    const provider = new WrongShapeProvider();
    const r = await run(parse(SEND_PLAN_RETRY), { provider });
    const types = r.ledger.events.map((e) => e.etype);
    expect(types).toContain("TypeMismatch");
    // retry re-asked for all N attempts, then exhausted and faulted
    expect(provider.calls).toBe(2);
    expect(types).toContain("RetryExhausted");
    expect(types).toContain("AgentCrashed");
    const mismatch = r.ledger.events.find((e) => e.etype === "TypeMismatch");
    expect((mismatch?.payload as any)?.error).toContain("extra field");
  });
});
