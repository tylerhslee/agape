import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { check } from "../src/check.js";
import { buildGraph } from "../src/graph.js";
import { parse } from "../src/parser.js";
import { LocalMemoryDriver } from "../src/memory.js";
import type { RuntimeIdentityContext } from "../src/interp.js";
import {
  DurableTransactionalNamedMemoryDriver,
  LocalTransactionalNamedMemoryJournal,
} from "../src/named_memory_local.js";
import type {
  CognitionContext,
  Provider,
  ProviderJudgment,
  StructuredSchema,
  Variant,
} from "../src/runtime.js";
import { run } from "./runtime_harness.js";

const source = readFileSync(new URL("../examples/fact_checker.ag", import.meta.url), "utf8");
const program = parse(source);
const manifest = {
  provider: { backend: "mock" },
  tools: { search: { driver: "host" } },
  actions: { Search: { tool: "search", result_event: "SearchEvidence" } },
} as const;

type Status = "Pending" | "Certified" | "Qualified" | "Rejected" | "Abstained" | "NoVerifiableClaims";
type Learning = "Learn" | "Skip";
type Extraction = "UseClaims" | "RejectDraft" | "abstained";
type SearchDisposition = "SearchClaim" | "WithholdClaim" | "abstained";
type ClaimDisposition = "Supported" | "QualifiedSupport" | "Unsupported";

interface ProviderOptions {
  claims: Array<{ claim_id: string; statement: string }>;
  response?: string;
  status?: Status;
  learning?: Learning;
  extraction?: Extraction;
  claimDisposition?: ClaimDisposition;
  forgedRequest?: string;
  searchDisposition?: SearchDisposition;
  forgedLearningStatus?: Status;
}

class ProofProvider implements Provider {
  readonly structuredCalls: Array<{ prompt: string; name?: string; fields: string[] }> = [];
  readonly judgments: Array<{ prompt: string; enumName: string; winner: string }> = [];

  constructor(readonly options: ProviderOptions) {}

  async structured(
    prompt: string,
    schema: StructuredSchema,
    name?: string,
    _context?: CognitionContext,
  ): Promise<unknown> {
    if (schema.type !== "object") throw new Error("unexpected non-object proof-app schema");
    const fields = Object.keys(schema.properties);
    this.structuredCalls.push({ prompt, name, fields });
    if (fields.length === 1 && fields[0] === "response") {
      return {
        response: this.options.response ?? "Alpha is one. Beta is two.",
      };
    }
    if (fields.includes("request") && fields.includes("response")) {
      return {
        request: this.options.forgedRequest ?? "Tell me about the markers",
        response: this.options.response ?? "Alpha is one. Beta is two.",
      };
    }
    if (fields.includes("claims")) return { claims: this.options.claims };
    if (fields.length === 1 && fields[0] === "guidance") {
      return {
        guidance: "Keep claims atomic and preserve evidence boundaries.",
      };
    }
    if (fields.includes("guidance") && fields.includes("source_status")) {
      return {
        guidance: "Keep claims atomic and preserve evidence boundaries.",
        source_status: this.options.forgedLearningStatus ?? "Certified",
      };
    }
    throw new Error("unexpected structured schema: " + fields.join(","));
  }

  async judge(
    prompt: string,
    enumName: string,
    variants: Variant[],
    _context?: CognitionContext,
  ): Promise<ProviderJudgment> {
    const configured =
      enumName === "ExtractionDisposition" ? (this.options.extraction ?? "UseClaims") :
      enumName === "SearchDisposition" ? (this.options.searchDisposition ?? "SearchClaim") :
      enumName === "ClaimDisposition" ? (this.options.claimDisposition ?? "Supported") :
      enumName === "OutcomeStatus" ? (this.options.status ?? "Certified") :
      enumName === "LearningDisposition" ? (this.options.learning ?? "Skip") :
      variants[0]!;
    this.judgments.push({ prompt, enumName, winner: configured });
    if (configured === "abstained") {
      return { scores: Object.fromEntries(variants.map((variant) => [variant, 1 / variants.length])) };
    }
    return {
      scores: Object.fromEntries(
        variants.map((variant) => [
          variant,
          variant === configured ? 0.98 : 0.02 / Math.max(1, variants.length - 1),
        ]),
      ),
    };
  }

  async reply(): Promise<string> {
    throw new Error("proof app should use typed provider calls");
  }
}

const verifiedUser = (subject: string): NonNullable<RuntimeIdentityContext["user"]> => ({
  issuer: "https://issuer.example",
  subject,
  verified: true,
});
const identity = (sessionId: string): RuntimeIdentityContext => ({
  projectSubject: "project://fact-checker-proof",
  sessionLineageId: "fact-checker-proof-lineage",
  sessionId,
  conversationId: "fact-checker-proof-conversation",
  user: verifiedUser("alice"),
});

async function runCase(
  options: ProviderOptions,
  input: {
    journal?: LocalTransactionalNamedMemoryJournal;
    sessionId?: string;
    user?: RuntimeIdentityContext["user"] | null;
    promptValue?: string;
    onDriverCall?: (kind: "read" | "mutation") => void;
  } = {},
) {
  const provider = new ProofProvider(options);
  const searches: string[] = [];
  const journal = input.journal ?? new LocalTransactionalNamedMemoryJournal();
  const driver = new DurableTransactionalNamedMemoryDriver({ journal });
  const runtimeIdentity = identity(input.sessionId ?? "fact-checker-proof-session");
  if (Object.prototype.hasOwnProperty.call(input, "user")) {
    runtimeIdentity.user = input.user ?? undefined;
  }
  const result = await run(program, {
    identity: runtimeIdentity,
    provider,
    manifest,
    memory: new LocalMemoryDriver(),
    namedMemory: {
      driver,
    },
      ...(input.onDriverCall ? { onDriverCall: input.onDriverCall } : {}),
    promptInputs: [{ name: "question", value: input.promptValue ?? "Tell me about the markers" }],
    toolHandlers: {
      search: async ({ args }) => {
        const query = args[0]?.kind === "text" ? args[0].v : "";
        searches.push(query);
        return "evidence:" + query;
      },
    },
  });
  const memorySnapshot = await driver.snapshot();
  return { result, provider, searches, journal, memorySnapshot };
}

const events = (
  result: Awaited<ReturnType<typeof runCase>>["result"],
  etype: string,
) => result.ledger.events.filter((event) => event.etype === etype);

const payloadText = (value: unknown) => JSON.stringify(value);
const instanceIdForAlias = (
  result: Awaited<ReturnType<typeof runCase>>["result"],
  alias: string,
) => {
  const spawned = events(result, "Spawned").find(
    (event) => (event.payload as Record<string, unknown>).alias === alias,
  );
  expect(spawned).toBeTruthy();
  return String((spawned!.payload as Record<string, unknown>).instance_id);
};
const expectProtected = (value: unknown, expected: number) => {
  expect(Array.isArray(value)).toBe(true);
  const entries = value as Array<Record<string, unknown>>;
  expect(entries).toHaveLength(expected);
  for (const entry of entries) {
    expect(Object.keys(entry).sort()).toEqual([
      "content_hash",
      "protected_ref",
      "redaction_policy_hash",
    ]);
    expect(entry.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.protected_ref).toMatch(/^blob:sha256:[0-9a-f]{64}$/);
    expect(entry.redaction_policy_hash).toMatch(/^[0-9a-f]{64}$/);
  }
};
const memoryRegionText = (
  snapshot: Awaited<ReturnType<typeof runCase>>["memorySnapshot"],
  name: string,
) => payloadText(snapshot.regions.find((region) => region.descriptor.name === name));


describe("fact-checker proof app", () => {
  it("statically exposes two authored agents, explicit memory, claim fanout, and a gated neutral sink", () => {
    expect(() => check(program, manifest)).not.toThrow();
    const graph = buildGraph(program, "examples/fact_checker.ag");
    const agents = graph.nodes.filter((node) => node.kind === "agent");
    expect(agents.map((node) => node.label).sort()).toEqual([
      "chatbot: Chatbot",
      "verifier: Verifier",
    ]);
    expect(graph.nodes.some((node) => node.kind === "fn" && node.label.includes("verifyClaim"))).toBe(true);
    expect(graph.edges.some((edge) => edge.kind === "call" && edge.label === "|> verifyClaim")).toBe(true);
    expect(graph.edges.filter((edge) => edge.kind === "store").length).toBeGreaterThanOrEqual(4);
    expect(graph.edges.filter((edge) => edge.kind === "recall")).toHaveLength(3);
    expect(graph.nodes.some((node) =>
      node.kind === "sink"
      && node.meta?.action === "Search"
      && node.meta?.resultBound === true
      && node.context?.kind === "fn"
      && node.context?.name === "verifyClaim"
    )).toBe(true);
    expect(graph.nodes.some((node) =>
      node.kind === "sink" && node.meta?.action === "PublishResponseWithCertificate"
    )).toBe(true);
    expect(source).not.toContain("summarize any grounding evidence you can recall");
  });

  it("represents every branch-specific endorsement and exact proof-app event edge", () => {
    const graph = buildGraph(program, "examples/fact_checker.ag");
    const gate = (enumName: string) => graph.nodes.find(
      (node) => node.kind === "gate" && node.meta?.enum === enumName,
    )!;
    const endorsements = (enumName: string) =>
      gate(enumName).meta?.endorsements as Array<{ subject: string; variant?: string; line: number }>;

    expect(endorsements("ExtractionDisposition")).toEqual(expect.arrayContaining([
      expect.objectContaining({ subject: "plan", variant: "UseClaims" }),
      expect.objectContaining({ subject: "no_claims", variant: "UseClaims" }),
      expect.objectContaining({ subject: "extraction_rejected", variant: "RejectDraft" }),
    ]));
    expect(gate("ExtractionDisposition").meta?.endorses).toBeUndefined();
    expect(endorsements("OutcomeStatus")).toEqual(expect.arrayContaining([
      expect.objectContaining({ subject: "certified", variant: "Certified" }),
      expect.objectContaining({ subject: "qualified", variant: "Qualified" }),
      expect.objectContaining({ subject: "rejected", variant: "Rejected" }),
      expect.objectContaining({ subject: "abstained_response", variant: "Abstained" }),
    ]));
    expect(endorsements("SearchDisposition")).toEqual([
      expect.objectContaining({ subject: "claim.statement", variant: "SearchClaim" }),
    ]);
    expect(gate("SearchDisposition").meta?.endorses).toBe("claim.statement");

    const candidateSite = graph.nodes.find(
      (node) => node.kind === "emit" && node.meta?.event === "CandidateDrafted",
    )!;
    const candidateHandlers = graph.nodes.filter(
      (node) => node.kind === "handler" && node.meta?.etype === "CandidateDrafted",
    );
    expect(candidateHandlers).toHaveLength(1);
    expect(graph.edges).toContainEqual(expect.objectContaining({
      from: candidateSite.id,
      to: candidateHandlers[0]!.id,
      kind: "event",
      label: "CandidateDrafted",
    }));

    const outcomeSites = graph.nodes.filter(
      (node) => node.kind === "emit" && node.meta?.event === "OutcomeRecorded",
    );
    const outcomeHandlers = graph.nodes.filter(
      (node) => node.kind === "handler" && node.meta?.etype === "OutcomeRecorded",
    );
    expect(outcomeSites.length).toBeGreaterThanOrEqual(7);
    expect(outcomeHandlers).toHaveLength(2);
    for (const site of outcomeSites) {
      for (const handler of outcomeHandlers) {
        expect(graph.edges).toContainEqual(expect.objectContaining({
          from: site.id,
          to: handler.id,
          kind: "event",
          label: "OutcomeRecorded",
        }));
      }
    }

    const searchSink = graph.nodes.find(
      (node) => node.kind === "sink"
        && node.meta?.action === "Search"
        && node.context?.name === "verifyClaim",
    )!;
    expect(graph.edges).toContainEqual(expect.objectContaining({
      from: gate("SearchDisposition").id,
      to: searchSink.id,
      kind: "sink",
      variant: "SearchClaim",
    }));
  });


  it("represents a result-bound perform inside a helper as a generic action sink", () => {
    const helperProgram = parse(`
      action Lookup(text query);
      event LookupResult(text result);
      event Trigger(text query);
      text lookup(text query) {
        text result = perform Lookup(query) expires 5;
        return result;
      }
      agent Worker grants { perform Lookup } {
        when (Trigger trigger) {
          text result = lookup(trigger.query);
        }
      }
      spawn Worker worker;
    `);
    const graph = buildGraph(helperProgram, "helper-perform.ag");
    const lookup = graph.nodes.find((node) =>
      node.kind === "sink" && node.meta?.action === "Lookup"
    );
    expect(lookup?.meta?.resultBound).toBe(true);
    expect(lookup?.meta?.binding).toBe("result");
    expect(lookup?.context).toEqual({
      id: "fn:worker/lookup", kind: "fn", name: "lookup", agent: "worker",
    });
  });
  it("hands the exact chatbot candidate to Verifier and short-circuits an empty plan", async () => {
    const response = "Hello! How can I help you today?";
    const { result, provider, searches, memorySnapshot } = await runCase({
      claims: [],
      response,
      learning: "Skip",
    });

    expect(searches).toEqual([]);
    expect(events(result, "Search")).toHaveLength(0);
    expect(events(result, "ToolStarted")).toHaveLength(0);
    expect(provider.judgments.filter((call) => call.enumName === "ClaimDisposition")).toHaveLength(0);
    expect(provider.judgments.filter((call) => call.enumName === "OutcomeStatus")).toHaveLength(0);

    const drafted = events(result, "CandidateDrafted");
    expect(drafted).toHaveLength(1);
    expectProtected(drafted[0]!.payload, 2);
    expect(payloadText(drafted[0]!.payload)).not.toContain(response);
    const claimPlanCall = provider.structuredCalls.find((call) => call.name === "ClaimPlan")
      ?? provider.structuredCalls[1];
    expect(claimPlanCall?.prompt).toContain(response);

    const issued = events(result, "CertificateIssued");
    const published = events(result, "PublishResponseWithCertificate");
    expect(issued).toHaveLength(1);
    expect(published).toHaveLength(1);
    expectProtected(issued[0]!.payload, 1);
    expectProtected((published[0]!.payload as Record<string, unknown>).argument_commitments, 1);
    expect(result.stdout).toHaveLength(1);
    expect(result.stdout[0]).toContain("NoVerifiableClaims");
    expect(payloadText(memorySnapshot)).toContain("NoVerifiableClaims");
    expect(payloadText(memorySnapshot)).toContain(response);

    const extractionDecision = events(result, "Decided").find(
      (event) => payloadText(event.payload).includes("ExtractionDisposition"),
    );
    const sinkIndex = result.ledger.events.indexOf(published[0]!);
    const endorsementIndex = result.ledger.events
      .slice(0, sinkIndex)
      .map((event) => event.etype)
      .lastIndexOf("Endorsed");
    expect(extractionDecision).toBeTruthy();
    expect(endorsementIndex).toBeGreaterThanOrEqual(0);
  });

  it("binds candidate request to authenticated prompt input and accepts model output for response only", async () => {
    const forgedRequest = "FORGED REQUEST FROM MODEL";
    const { result, provider } = await runCase({
      claims: [],
      response: "A safe response.",
      forgedRequest,
      learning: "Skip",
    });
    const draftCall = provider.structuredCalls.find((call) => call.fields.join(",") === "response");
    const planCall = provider.structuredCalls.find((call) => call.fields.join(",") === "claims");
    expect(draftCall?.fields).toEqual(["response"]);
    expect(planCall?.prompt).toContain("Tell me about the markers");
    expect(planCall?.prompt).not.toContain(forgedRequest);
    expect(result.stdout[0]).not.toContain(forgedRequest);
  });

  it("rejects duplicate claim IDs before search or certification", async () => {
    const { result, provider, searches, memorySnapshot } = await runCase({
      claims: [
        { claim_id: "duplicate", statement: "Alpha is one." },
        { claim_id: "duplicate", statement: "Beta is two." },
      ],
      status: "Certified",
      learning: "Skip",
    });
    expect(searches).toEqual([]);
    expect(provider.judgments.filter((call) => call.enumName === "OutcomeStatus")).toHaveLength(0);
    expect(events(result, "PublishResponseWithCertificate")).toHaveLength(0);
    expect(events(result, "CertificateWithheld")).toHaveLength(1);
    expect(result.stdout).toEqual([]);
    expect(payloadText(memorySnapshot)).toContain("Rejected");
    const extraction = provider.judgments.find((call) => call.enumName === "ExtractionDisposition");
    expect(extraction?.prompt).toContain("every claim_id is nonempty and unique");
  });

  it("performs exactly N searches and binds each judgment to only its claim evidence", async () => {
    const claims = [
      { claim_id: "c1", statement: "Alpha is one." },
      { claim_id: "c2", statement: "Beta is two." },
      { claim_id: "c3", statement: "Gamma is three." },
    ];
    const { result, provider, searches, memorySnapshot } = await runCase({
      claims,
      status: "Certified",
      learning: "Skip",
    });

    expect(searches).toEqual(claims.map((claim) => claim.statement));
    expect(events(result, "Search")).toHaveLength(claims.length);
    expect(events(result, "ToolStarted")).toHaveLength(claims.length);
    const claimJudgments = provider.judgments.filter((call) => call.enumName === "ClaimDisposition");
    const searchJudgments = provider.judgments.filter((call) => call.enumName === "SearchDisposition");
    expect(searchJudgments).toHaveLength(claims.length);
    expect(searchJudgments.every((call) => call.winner === "SearchClaim")).toBe(true);
    expect(claimJudgments).toHaveLength(claims.length);
    for (const claim of claims) {
      const call = claimJudgments.find((entry) => entry.prompt.includes("Claim id: " + claim.claim_id));
      expect(call?.prompt).toContain("Claim: " + claim.statement);
      expect(call?.prompt).toContain("Evidence: evidence:" + claim.statement);
      for (const other of claims.filter((candidate) => candidate !== claim)) {
        expect(call?.prompt).not.toContain("evidence:" + other.statement);
      }
    }
    expect(provider.judgments.filter((call) => call.enumName === "OutcomeStatus")).toHaveLength(1);
    const published = events(result, "PublishResponseWithCertificate");
    expect(published).toHaveLength(1);
    expectProtected((published[0]!.payload as Record<string, unknown>).argument_commitments, 1);
    expect(result.stdout).toHaveLength(1);
    expect(result.stdout[0]).toContain("Certified");
    const verifierMemory = memoryRegionText(memorySnapshot, "outcomes");
    expect(verifierMemory).toContain("Certified");
    for (const claim of claims) {
      expect(verifierMemory).toContain(claim.claim_id);
      expect(verifierMemory).toContain("evidence:" + claim.statement);
    }
  });


  it("withholds a Certified outcome when any audited claim is Unsupported", async () => {
    const { result, provider, memorySnapshot } = await runCase({
      claims: [{ claim_id: "c1", statement: "Alpha is one." }],
      claimDisposition: "Unsupported",
      status: "Certified",
      learning: "Skip",
    });
    expect(provider.judgments.find((call) => call.enumName === "ClaimDisposition")?.winner)
      .toBe("Unsupported");
    expect(provider.judgments.find((call) => call.enumName === "OutcomeStatus")?.winner)
      .toBe("Certified");
    expect(events(result, "PublishResponseWithCertificate")).toHaveLength(0);
    expect(events(result, "CertificateWithheld")).toHaveLength(1);
    expect(result.stdout).toEqual([]);
    expect(payloadText(memorySnapshot)).toContain("Rejected");
  });
  it.each(["Certified", "Qualified", "Rejected", "Abstained"] as const)(
    "publishes a truthful %s certificate through an endorsement",
    async (status) => {
      const { result, provider, memorySnapshot } = await runCase({
        claims: [{ claim_id: "c1", statement: "Alpha is one." }],
        status,
        learning: "Skip",
      });
      const published = events(result, "PublishResponseWithCertificate");
      expect(published).toHaveLength(1);
      expectProtected((published[0]!.payload as Record<string, unknown>).argument_commitments, 1);
      expect(result.stdout).toHaveLength(1);
      expect(result.stdout[0]).toContain(status);
      const outcomeJudgments = provider.judgments.filter((call) => call.enumName === "OutcomeStatus");
      expect(outcomeJudgments).toHaveLength(1);
      expect(outcomeJudgments[0]!.winner).toBe(status);
      expect(payloadText(memorySnapshot)).toContain(status);
      const sinkIndex = result.ledger.events.indexOf(published[0]!);
      expect(result.ledger.events.slice(0, sinkIndex).some((event) => event.etype === "Endorsed")).toBe(true);
    },
  );

  it("withholds publication when extraction itself abstains", async () => {
    const { result, searches } = await runCase({
      claims: [{ claim_id: "c1", statement: "Alpha is one." }],
      extraction: "abstained",
      learning: "Skip",
    });
    expect(searches).toEqual([]);
    expect(events(result, "PublishResponseWithCertificate")).toHaveLength(0);
    expect(events(result, "CertificateWithheld")).toHaveLength(1);
    expect(result.stdout).toEqual([]);
  });

  it("stores Pending plus final labels in Chatbot memory and the final label in Verifier memory", async () => {
    const { result, memorySnapshot } = await runCase({
      claims: [{ claim_id: "c1", statement: "Alpha is one." }],
      status: "Rejected",
      learning: "Skip",
    });
    const stores = events(result, "Internalized");
    const drafts = stores.filter((event) => (event.payload as Record<string, unknown>).region === "drafts");
    const outcomes = stores.filter((event) => (event.payload as Record<string, unknown>).region === "outcomes");
    const learned = stores.filter((event) => (event.payload as Record<string, unknown>).region === "learned_guidance");
    expect(drafts).toHaveLength(2);
    expect(outcomes).toHaveLength(1);
    expect(learned).toHaveLength(0);
    const chatbotId = instanceIdForAlias(result, "chatbot");
    const verifierId = instanceIdForAlias(result, "verifier");
    expect(drafts.every((event) => event.agent === chatbotId)).toBe(true);
    expect(outcomes.every((event) => event.agent === verifierId)).toBe(true);
    const recorded = events(result, "OutcomeRecorded");
    expect(recorded).toHaveLength(1);
    expectProtected(recorded[0]!.payload, 3);
    expect(payloadText(memorySnapshot)).toContain("Pending");
    expect(payloadText(memorySnapshot)).toContain("Rejected");
  });

  it("stores semantic guidance only after an explicit committed Learn decision", async () => {
    const skipped = await runCase({
      claims: [{ claim_id: "c1", statement: "Alpha is one." }],
      status: "Certified",
      learning: "Skip",
    });
    const learned = await runCase({
      claims: [{ claim_id: "c1", statement: "Alpha is one." }],
      status: "Certified",
      learning: "Learn",
    });
    const count = (runResult: typeof skipped.result) =>
      events(runResult, "Internalized").filter(
        (event) => (event.payload as Record<string, unknown>).region === "learned_guidance",
      ).length;
    expect(count(skipped.result)).toBe(0);
    expect(count(learned.result)).toBe(1);
    const learningDecision = events(learned.result, "Decided").find(
      (event) => payloadText(event.payload).includes("LearningDisposition"),
    );
    expect(learningDecision).toBeTruthy();
  });


  it("recalls endorsed semantic guidance after restart as tainted verification context", async () => {
    const journal = new LocalTransactionalNamedMemoryJournal();
    const learned = await runCase({
      claims: [{ claim_id: "c1", statement: "Alpha is one." }],
      status: "Certified",
      learning: "Learn",
    }, { journal, sessionId: "learning-session" });
    expect(payloadText(learned.memorySnapshot))
      .toContain("Keep claims atomic and preserve evidence boundaries.");
    expect(source).toContain("LearningRecord accepted_lesson = approved_lesson.subject;");
    expect(source).toContain("learned_guidance <- accepted_lesson;");

    const restarted = await runCase({
      claims: [],
      response: "A later response.",
      learning: "Skip",
    }, { journal, sessionId: "learning-restart" });
    const planCall = restarted.provider.structuredCalls.find((call) => call.fields.join(",") === "claims");
    expect(planCall).toBeTruthy();
    expect(planCall!.prompt).toContain("Keep claims atomic and preserve evidence boundaries.");
    expect(planCall?.prompt).toContain("untrusted");
  });
  it("recalls durable labeled episodes after restart as tainted context for fresh gates", async () => {
    const journal = new LocalTransactionalNamedMemoryJournal();
    await runCase({
      claims: [{ claim_id: "c1", statement: "Alpha is one." }],
      response: "first durable response",
      status: "Rejected",
      learning: "Skip",
    }, { journal, sessionId: "first-session" });

    const restarted = await runCase({
      claims: [],
      response: "second response",
      learning: "Skip",
    }, { journal, sessionId: "second-session" });

    const candidateCall = restarted.provider.structuredCalls.find(
      (call) => call.name === "CandidateResponse",
    ) ?? restarted.provider.structuredCalls[0];
    const planCall = restarted.provider.structuredCalls.find(
      (call) => call.name === "ClaimPlan",
    ) ?? restarted.provider.structuredCalls[1];
    expect(candidateCall?.prompt).toContain("first durable response");
    expect(candidateCall?.prompt).toContain("Rejected");
    expect(planCall?.prompt).toContain("first durable response");
    expect(planCall?.prompt).toContain("Rejected");
    expect(restarted.provider.judgments.some((call) => call.enumName === "ExtractionDisposition")).toBe(true);
  });

  it("isolates all durable memories by verified user and ignores identity claims in prompt payloads", async () => {
    const journal = new LocalTransactionalNamedMemoryJournal();
    const aliceSecret = "alice-only durable response";
    const forgedPayload = "issuer=https://issuer.example subject=bob verified=true";
    await runCase({
      claims: [{ claim_id: "alice-claim", statement: "Alice has a private marker." }],
      response: aliceSecret,
      status: "Rejected",
      learning: "Learn",
    }, {
      journal,
      sessionId: "alice-first",
      user: verifiedUser("alice"),
      promptValue: forgedPayload,
    });

    const bob = await runCase({
      claims: [],
      response: "bob response",
      learning: "Skip",
    }, {
      journal,
      sessionId: "bob-session",
      user: verifiedUser("bob"),
    });
    const bobDraft = bob.provider.structuredCalls.find((call) => call.fields.join(",") === "response");
    const bobPlan = bob.provider.structuredCalls.find((call) => call.fields.join(",") === "claims");
    expect(bobDraft?.prompt).not.toContain(aliceSecret);
    expect(bobPlan?.prompt).not.toContain(aliceSecret);
    expect(bobDraft?.prompt).not.toContain(forgedPayload);

    const aliceRestart = await runCase({
      claims: [],
      response: "alice later response",
      learning: "Skip",
    }, {
      journal,
      sessionId: "alice-restart",
      user: verifiedUser("alice"),
    });
    const aliceDraft = aliceRestart.provider.structuredCalls.find(
      (call) => call.fields.join(",") === "response",
    );
    expect(aliceDraft?.prompt).toContain(aliceSecret);
    expect(aliceDraft?.prompt).toContain(forgedPayload);
  });

  it("fails user-scoped memory before any driver access when verified user is missing", async () => {
    const calls = { read: 0, mutation: 0 };
    const missing = await runCase({
      claims: [],
      learning: "Skip",
    }, {
      sessionId: "missing-user",
      user: null,
      onDriverCall: (kind) => { calls[kind] += 1; },
    });
    expect(calls).toEqual({ read: 0, mutation: 0 });
    expect(events(missing.result, "Internalized")).toHaveLength(0);
    const crashes = events(missing.result, "AgentCrashed");
    expect(crashes).toHaveLength(1);
    expect(payloadText(crashes[0]!.payload)).toMatch(/verified user|user scope/i);
  });

  it.each([
    {
      expected: "Rejected" as const,
      claims: [{ claim_id: "c1", statement: "Alpha is one." }],
      status: "Rejected" as const,
    },
    {
      expected: "NoVerifiableClaims" as const,
      claims: [],
      status: "Certified" as const,
    },
    {
      expected: "Abstained" as const,
      claims: [{ claim_id: "c1", statement: "Alpha is one." }],
      status: "Abstained" as const,
    },
  ])("binds learned source_status to the trusted $expected outcome", async ({ expected, claims, status }) => {
    const learned = await runCase({
      claims,
      status,
      learning: "Learn",
      forgedLearningStatus: "Certified",
    });
    const semantic = memoryRegionText(learned.memorySnapshot, "learned_guidance");
    const proposal = learned.provider.structuredCalls.find(
      (call) => call.fields.join(",") === "guidance",
    );
    expect(proposal?.fields).toEqual(["guidance"]);
    expect(semantic).toContain(expected);
    if (expected !== "Certified") expect(semantic).not.toContain('"variant":"Certified"');
  });

  it("stores verifier-specific audits with evidence and re-gates deeply tainted recall after restart", async () => {
    const journal = new LocalTransactionalNamedMemoryJournal();
    const statement = "Alpha is one.";
    const first = await runCase({
      claims: [{ claim_id: "c1", statement }],
      response: "Alpha is one.",
      claimDisposition: "Unsupported",
      status: "Rejected",
      learning: "Skip",
    }, { journal, sessionId: "evidence-first" });
    const outcomes = memoryRegionText(first.memorySnapshot, "outcomes");
    expect(outcomes).toContain("VerificationOutcome");
    expect(outcomes).toContain("Unsupported");
    expect(outcomes).toContain("evidence:" + statement);

    const restarted = await runCase({
      claims: [{ claim_id: "c2", statement: "Beta is two." }],
      response: "Beta is two.",
      status: "Rejected",
      learning: "Skip",
    }, { journal, sessionId: "evidence-restart" });
    const plan = restarted.provider.structuredCalls.find((call) => call.fields.join(",") === "claims");
    expect(plan?.prompt).toContain("Unsupported");
    expect(plan?.prompt).toContain("evidence:" + statement);
    expect(plan?.prompt).toContain("untrusted");
    expect(restarted.provider.judgments.some((call) => call.enumName === "ExtractionDisposition")).toBe(true);
    expect(restarted.provider.judgments.some((call) => call.enumName === "SearchDisposition")).toBe(true);
    expect(restarted.provider.judgments.some((call) => call.enumName === "ClaimDisposition")).toBe(true);
    expect(payloadText(events(restarted.result, "MemoryConsulted"))).not.toContain("evidence:" + statement);
  });

  it.each(["WithholdClaim", "abstained"] as const)(
    "per-claim %s performs no Search and cannot publish Certified",
    async (searchDisposition) => {
      const { result, provider, searches, memorySnapshot } = await runCase({
        claims: [{ claim_id: "c1", statement: "Alpha is one." }],
        searchDisposition,
        status: "Certified",
        learning: "Skip",
      });
      expect(searches).toEqual([]);
      expect(events(result, "Search")).toHaveLength(0);
      expect(events(result, "PublishResponseWithCertificate")).toHaveLength(0);
      expect(events(result, "CertificateIssued")).toHaveLength(0);
      expect(result.stdout).toEqual([]);
      expect(provider.judgments.find((call) => call.enumName === "SearchDisposition")?.winner)
        .toBe(searchDisposition);
      expect(memoryRegionText(memorySnapshot, "outcomes")).toContain("Rejected");
    },
  );

  it.each(["Pending", "NoVerifiableClaims"] as const)(
    "withholds invalid nonempty-audit outcome %s",
    async (status) => {
      const { result, provider } = await runCase({
        claims: [{ claim_id: "c1", statement: "Alpha is one." }],
        status,
        learning: "Skip",
      });
      expect(provider.judgments.find((call) => call.enumName === "OutcomeStatus")?.winner).toBe(status);
      expect(events(result, "PublishResponseWithCertificate")).toHaveLength(0);
      expect(events(result, "CertificateIssued")).toHaveLength(0);
      expect(events(result, "CertificateWithheld")).toHaveLength(1);
      expect(result.stdout).toEqual([]);
    },
  );

  it("rejects a blank claim ID before Search or OutcomeStatus", async () => {
    const { result, provider, searches } = await runCase({
      claims: [{ claim_id: "", statement: "Alpha is one." }],
      status: "Certified",
      learning: "Skip",
    });
    expect(searches).toEqual([]);
    expect(provider.judgments.filter((call) => call.enumName === "OutcomeStatus")).toHaveLength(0);
    expect(events(result, "CertificateWithheld")).toHaveLength(1);
    expect(events(result, "PublishResponseWithCertificate")).toHaveLength(0);
  });

  it("blocks Certified publication for QualifiedSupport", async () => {
    const { result, provider, memorySnapshot } = await runCase({
      claims: [{ claim_id: "c1", statement: "Alpha is one." }],
      claimDisposition: "QualifiedSupport",
      status: "Certified",
      learning: "Skip",
    });
    expect(provider.judgments.find((call) => call.enumName === "ClaimDisposition")?.winner)
      .toBe("QualifiedSupport");
    expect(events(result, "PublishResponseWithCertificate")).toHaveLength(0);
    expect(events(result, "CertificateIssued")).toHaveLength(0);
    expect(events(result, "CertificateWithheld")).toHaveLength(1);
    expect(memoryRegionText(memorySnapshot, "outcomes")).toContain("Rejected");
  });
});
