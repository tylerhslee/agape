import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterAll } from "vitest";
import { parse } from "../src/parser.js";
import { run as runtimeRun } from "./runtime_harness.js";
import { MockProvider, type StructuredSchema } from "../src/runtime.js";
import { parseManifestDirective } from "../src/config.js";
import { LocalMemoryDriver } from "../src/memory.js";
const TEST_MEMORY_ROOT = mkdtempSync(join(tmpdir(), "agape-kernel-suite-"));
afterAll(async () => {
  await rm(TEST_MEMORY_ROOT, { recursive: true, force: true });
});

function run(program: Parameters<typeof runtimeRun>[0], opts: Parameters<typeof runtimeRun>[1] = {}) {
  return runtimeRun(program, { memoryRoot: TEST_MEMORY_ROOT, ...opts, memory: opts.memory ?? new LocalMemoryDriver() });
}
const HELLO = `
enum Verdict { Publish, Revise }
action Announce(text body);
event  Revised(text note);

agent Greeter grants { perform Announce } {
  on awake {
    text draft = "hello, world";
    Credence<Verdict> v = self <- f"is this safe to publish: \${draft}";
    Decision<Verdict> d = decide v by confidence 0.8;
    if (d.committed == Publish) {
      Endorsement<text> e = endorse draft by d;
      perform Announce(e);
    }
    else if (d.committed == Revise) { emit Revised("held"); }
    else { emit Revised("uncertain"); }
  }
}
spawn Greeter g;
awake g;
`;

// the runtime is async (cognition is a model call through the provider seam), so every run is awaited
// — even on the mock, which resolves on a microtask so tests exercise the same async path as live.
function runWith(scores: Record<string, number>) {
  const provider = new MockProvider(() => scores);
  return run(parse(HELLO), { provider });
}
type Result = Awaited<ReturnType<typeof runWith>>;
const etypes = (r: Result) => r.ledger.events.map((e) => e.etype);

class RecordingStructuredProvider extends MockProvider {
  readonly calls: { prompt: string; schema: StructuredSchema; name?: string }[] = [];
  constructor(private readonly answer: unknown) { super(); }
  override async structured(prompt: string, schema: StructuredSchema, name?: string): Promise<unknown> {
    this.calls.push({ prompt, schema, name });
    return this.answer;
  }
}


describe("markdown prompt syntax", () => {
  it("dedents indented prompt blocks by the common leading whitespace", async () => {
    const provider = new RecordingStructuredProvider("done");
    const prog = `
      agent A {
        on awake {
          text who = "Ada";
          if (true) {
            text answer = self <- prompt {
              # Task

              Greet \${who}.

              - keep it short
                - nested item survives relative indent
            };
            say(answer);
          }
        }
      }
      spawn A a; awake a;
    `;
    const r = await run(parse(prog), { provider });
    expect(provider.calls[0]?.prompt).toBe(
      "# Task\n\nGreet Ada.\n\n- keep it short\n  - nested item survives relative indent",
    );
    expect(r.stdout).toEqual(["done"]);
  });

  it("uses ${expr} interpolation and leaves plain braces literal in f-strings", async () => {
    const prog = `
      agent A {
        on awake {
          text name = "Ada";
          text line = f"literal {braces}; hello \${name}";
          say(line);
        }
      }
      spawn A a; awake a;
    `;
    const r = await run(parse(prog));
    expect(r.stdout).toEqual(["literal {braces}; hello Ada"]);
  });

  it("imports markdown as raw external input and interpolates it inside quote-free prompt blocks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agape-md-prompt-"));
    try {
      const promptDir = join(dir, "prompts");
      await mkdir(promptDir, { recursive: true });
      const guidePath = join(promptDir, "guide.md");
      await writeFile(guidePath, "# Guide\n\nPrefer atomic claims.");
      const provider = new RecordingStructuredProvider("done");
      const prog = `
        agent A {
          on awake {
            text topic = f"EU AI Act \${1}";
            text guide = md "prompts/guide.md";
            text answer = self <- prompt {
# Task
Use this markdown guide:

\${guide}

Topic: \${topic}

Literal JSON braces stay literal:
{ "ok": true }
            };
            say(answer);
          }
        }
        spawn A a; awake a;
      `;
      const r = await run(parse(prog), { provider, projectRoot: dir });
      expect(provider.calls[0]?.prompt).toContain("# Guide\n\nPrefer atomic claims.");
      expect(provider.calls[0]?.prompt).toContain("Topic: EU AI Act 1");
      expect(provider.calls[0]?.prompt).toContain('{ "ok": true }');
      expect(r.stdout).toEqual(["done"]);
      expect(r.warnings).toContainEqual(expect.objectContaining({
        kind: "tainted_ingress_to_provider",
        ingress: "external_unscreened",
      }));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("can deny markdown-imported prompt content before it reaches the provider", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agape-md-deny-"));
    try {
      const promptDir = join(dir, "prompts");
      await mkdir(promptDir, { recursive: true });
      const guidePath = join(promptDir, "guide.md");
      await writeFile(guidePath, "external instructions");
      const prog = `
        agent A {
          on awake {
            text guide = md "prompts/guide.md";
            text answer = self <- prompt {
\${guide}
            };
            say(answer);
          }
        }
        spawn A a; awake a;
      `;
      await expect(run(parse(prog), {
        provider: new RecordingStructuredProvider("unreachable"),
        manifest: { provider: { backend: "mock" }, security: { tainted_ingress_to_provider: "deny" } },
        projectRoot: dir,
      })).rejects.toThrow(/external unscreened ingress/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects markdown imports outside the project root", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agape-md-escape-"));
    try {
      const prog = [
        "agent A {",
        "  on awake {",
        "    text guide = md \"../outside.md\";",
        "    say(guide);",
        "  }",
        "}",
        "spawn A a; awake a;",
      ].join("\n");
      await expect(run(parse(prog), { projectRoot: dir })).rejects.toThrow(/project markdown/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the trusted kernel — gate chain", () => {
  it("commits to Publish and reaches the Announce sink with the endorsed subject", async () => {
    const r = await runWith({ Publish: 0.95, Revise: 0.05 });
    expect(etypes(r)).toContain("Endorsed");
    const announce = r.ledger.events.find((e) => e.etype === "Announce");
    expect(announce).toBeDefined();
    expect(announce!.payload).toMatchObject({ arguments: ["hello, world"] }); // Endorsement<text> coerced to its subject
    expect(etypes(r)).not.toContain("Revised");
  });

  it("records additive per-event latency metadata outside the canonical hash", async () => {
    const r = await runWith({ Publish: 0.95, Revise: 0.05 });
    expect(r.ledger.events.length).toBeGreaterThan(0);
    const sum = r.ledger.events.reduce((acc, e) => acc + e.latency_ms, 0);
    const last = r.ledger.events[r.ledger.events.length - 1]!;
    for (const e of r.ledger.events) {
      expect(Number.isFinite(e.latency_ms)).toBe(true);
      expect(Number.isFinite(e.elapsed_ms)).toBe(true);
      expect(e.latency_ms).toBeGreaterThanOrEqual(0);
      expect(e.elapsed_ms).toBeGreaterThanOrEqual(0);
    }
    expect(sum).toBe(last.elapsed_ms);
  });

  it("commits to Revise → the Announce sink does NOT fire", async () => {
    const r = await runWith({ Publish: 0.05, Revise: 0.95 });
    expect(etypes(r)).not.toContain("Announce");
    const rev = r.ledger.events.find((e) => e.etype === "Revised");
    expect(rev!.payload).toEqual(["held"]);
  });

  it("abstains below threshold → no commit, no sink, else branch runs", async () => {
    const r = await runWith({ Publish: 0.5, Revise: 0.5 }); // top 0.5 < 0.8 → abstained
    expect(etypes(r)).toContain("Decided");
    expect(etypes(r)).not.toContain("Endorsed");
    expect(etypes(r)).not.toContain("Announce");
    const rev = r.ledger.events.find((e) => e.etype === "Revised");
    expect(rev!.payload).toEqual(["uncertain"]);
  });
});

describe("structured provider replies", () => {
  const TEXT_REPLY = `
    agent A {
      on awake {
        text claim = self <- "summarize the incoming claim";
        say(claim);
      }
    }
    spawn A a; awake a;
  `;

  it("accepts a scalar text structured reply instead of substituting null", async () => {
    const provider = new RecordingStructuredProvider("claim summary");
    const r = await run(parse(TEXT_REPLY), { provider });
    expect(provider.calls[0]?.schema).toEqual({ type: "string" });
    expect(r.stdout).toEqual(["claim summary"]);
    expect(r.ledger.events.find((e) => e.etype === "TypeMismatch")).toBeUndefined();
    const resolved = r.ledger.events.find((e) => e.etype === "Resolved" && e.subject === "claim");
    expect((resolved?.payload as any)?.value).toBeUndefined();
    expect((resolved?.payload as any)?.reply?.kind).toBe("text");
    expect((resolved?.payload as any)?.reply?.value).toBe("claim summary");
    expect((resolved?.payload as any)?.reply?.rendered).toBe("claim summary");
    const internalized = r.ledger.events.find((e) => e.etype === "Internalized" && e.subject === "claim");
    expect(internalized).toBeUndefined();
  });

  it("faults the send (no null-fill) when a structured reply fails its schema, recording the raw bad value", async () => {
    const r = await run(parse(TEXT_REPLY), { provider: new RecordingStructuredProvider({ value: "wrapped" }) });
    // §8/§16.6 (owner ruling): a schema-violating typed reply faults AT the send — no null is
    // substituted into `claim`, so the downstream `say(claim)` never runs (stdout is empty).
    expect(r.stdout).toEqual([]);
    const mismatch = r.ledger.events.find((e) => e.etype === "TypeMismatch" && e.subject === "claim");
    expect(mismatch?.payload).toMatchObject({
      schema: { type: "string" },
      raw: { value: "wrapped" },
      error: "structured reply field is not text",
    });
    // the fault crashes the reaction (contained, recoverable via `on crash`).
    expect(r.ledger.events.map((e) => e.etype)).toContain("AgentCrashed");
  });

  it("uses the struct itself as the schema for typed struct replies", async () => {
    const prog = `
      struct Receipt {
        vendor: text,
        total_cents: int,
        needs_review: bool
      }
      agent A {
        on awake {
          Receipt receipt = self <- "extract receipt";
          say(receipt.vendor);
          say(f"total: \${receipt.total_cents}");
          say(f"review: \${receipt.needs_review}");
        }
      }
      spawn A a; awake a;
    `;
    const provider = new RecordingStructuredProvider({
      vendor: "Northwind",
      total_cents: 4125,
      needs_review: false,
    });
    const r = await run(parse(prog), { provider });
    expect(provider.calls[0]?.schema).toEqual({
      type: "object",
      properties: {
        vendor: { type: "string" },
        total_cents: { type: "integer" },
        needs_review: { type: "boolean" },
      },
      required: ["vendor", "total_cents", "needs_review"],
      additionalProperties: false,
    });
    expect(r.stdout).toEqual(["Northwind", "total: 4125", "review: false"]);
    const resolved = r.ledger.events.find((e) => e.etype === "Resolved" && e.subject === "receipt");
    expect((resolved?.payload as any)?.schema?.properties?.vendor).toEqual({ type: "string" });
    expect((resolved?.payload as any)?.value).toBeUndefined();
    expect((resolved?.payload as any)?.reply?.kind).toBe("struct");
    expect((resolved?.payload as any)?.reply?.fields?.vendor).toMatchObject({ kind: "text", value: "Northwind" });
    expect((resolved?.payload as any)?.reply?.fields?.total_cents).toMatchObject({ kind: "int", value: 4125 });
    const internalized = r.ledger.events.find((e) => e.etype === "Internalized" && e.subject === "receipt");
    expect(internalized).toBeUndefined();
  });

  it("rejects legacy event<T> reply syntax", () => {
    const prog = `
      agent A {
        on awake {
          event<text> reply = self <- "hello";
        }
      }
      spawn A a; awake a;
    `;
    expect(() => parse(prog)).toThrow(/event<T>` is no longer a reply type/);
  });

  it("stores memory through <- and returns an Internalized ledger receipt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agape-kernel-memory-"));
    try {
      const prog = `
        agent A {
          mem notes {
            type text;
            modality opaque;
            scope project;
            retention session;
          }
          on awake {
            LedgerEntry<Internalized> receipt = notes <- "durable note";
            say(receipt._meta.etype);
            say(receipt.refs.input);
          }
        }
        spawn A a; awake a;
      `;
      const r = await run(parse(prog), { memoryRoot: dir });
      expect(r.stdout[0]).toBe("Internalized");
      expect(r.stdout[1]).toMatch(/^memory-value-v1:[0-9a-f]{64}$/);
      const internalized = r.ledger.events.find((e) => e.etype === "Internalized" && e.subject === "notes");
      expect((internalized?.payload as any)?.effects?.cells?.upserted).toBe(1);
      expect((internalized?.payload as any)?.operation).toBe("store");
      expect((internalized?.payload as any)?.memory).toBeUndefined();
      expect((internalized?.payload as any)?.value).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the consequential-action rule", () => {
  it("rejects a tainted (graded) value at a sink — TaintViolation", async () => {
    const prog = `
      enum Verdict { Yes, No }
      action Pay(text amt);
      agent A grants { perform Pay } {
        on awake {
          Credence<Verdict> c = self <- "approve?";
          perform Pay(c);
        }
      }
      spawn A a; awake a;
    `;
    await expect(run(parse(prog), { provider: new MockProvider(() => ({ Yes: 0.9, No: 0.1 })) }))
      .rejects.toMatchObject({ cls: "TaintViolation" });
  });

  it("rejects a perform without the grant — AuthorityViolation", async () => {
    const prog = `
      action Pay(text amt);
      agent A {
        on awake { perform Pay("x"); }
      }
      spawn A a; awake a;
    `;
    await expect(run(parse(prog), {})).rejects.toMatchObject({ cls: "AuthorityViolation" });
  });

  it("fails closed before a private endorsed field projection reaches an action", async () => {
    const prog = `
      enum Verdict { Yes, No }
      struct Secret { body: text }
      action Publish(text body);
      agent A grants { perform Publish } {
        mem notes {
          type Secret;
          modality opaque;
          scope project;
          retention session;
        }
        on awake {
          notes <- Secret { body: "private answer" };
          Secret[] hits = notes -> "answer";
          Secret candidate = hits[0];
          Credence<Verdict> c = self <- f"approve \${candidate.body}";
          Decision<Verdict> d = decide c by confidence 0.8;
          if (d.committed == Yes) {
            Endorsement<Secret> e = endorse candidate by d;
            perform Publish(e.body);
          }
          else if (d.committed == No) {
            Endorsement<Secret> e = endorse candidate by d;
            perform Publish(e.body);
          }
        }
      }
      spawn A a; awake a;
    `;
    const result = await run(parse(prog), {
      provider: new MockProvider(() => ({ Yes: 0.9, No: 0.1 })),
    });
    const etypes = result.ledger.events.map((event) => event.etype);
    expect(etypes).toContain("Endorsed");
    expect(etypes).toContain("AgentCrashed");
    expect(etypes).not.toContain("Publish");
    expect(etypes).not.toContain("ActionAuthorized");
  });
});

describe("the identity dependency fails closed (§13)", () => {
  // A principal-prefixed `p decide c by r` reaches the identity dependency when the rule cannot commit.
  // SPEC §13: "A declined or unavailable principal records `FailedPrincipalDecision` and the decision stays
  // `abstained`." An unconfigured / unavailable principal must NEVER fabricate an approval that never happened.
  const RELEASE = `
    enum Approval { Approve, Decline }
    action ReleaseFunds(int amount);
    principal alice;
    agent Clerk grants { perform ReleaseFunds } {
      on awake {
        Credence<Approval> c = self <- "assess this refund request";
        Decision<Approval> d = alice decide c by conformal 0.05;
        if (d.committed == Approve) {
          Endorsement<Credence<Approval>> e = endorse c by d;
          perform ReleaseFunds(10000);
        }
        else if (d.committed == Decline) { emit Event("declined"); }
        else { emit Event("withheld"); }
      }
    }
    spawn Clerk a; awake a;
  `;
  const scores = () => ({ Approve: 0.9, Decline: 0.1 });
  const ledger = (r: Awaited<ReturnType<typeof run>>) => r.ledger.events.map((e) => e.etype);

  it("fails closed (abstain) when no principal directive is configured — no fabricated approval", async () => {
    const r = await run(parse(RELEASE), { provider: new MockProvider(scores) });
    expect(ledger(r)).toContain("FailedPrincipalDecision");
    expect(ledger(r)).toContain("Decided");
    expect(ledger(r)).not.toContain("Endorsed");
    expect(ledger(r)).not.toContain("PrincipalDecision");
    expect(ledger(r)).not.toContain("ReleaseFunds"); // the sink must NOT fire
  });

  it("fails closed (abstain) on an explicit deny", async () => {
    const r = await run(parse(RELEASE), { provider: new MockProvider(scores), principal: "deny" });
    expect(ledger(r)).toContain("FailedPrincipalDecision");
    expect(ledger(r)).not.toContain("ReleaseFunds");
  });

  it("commits only on an explicit grant — the sole approval path", async () => {
    const r = await run(parse(RELEASE), { provider: new MockProvider(scores), principal: "grant" });
    expect(ledger(r)).toContain("PrincipalDecision");
    expect(ledger(r)).toContain("Endorsed");
    expect(ledger(r)).toContain("ReleaseFunds");
  });

  // §13 attestation protocol — deferral appends a durable PendingPrincipalDecision receipt whose tick
  // is the correlation id the subsequent ruling references. §17 attester-match seam — a ruling records
  // a PrincipalDecision only if its verified attester resolves to the deferred principal.
  const evt = (r: Awaited<ReturnType<typeof run>>, etype: string) => r.ledger.events.find((e) => e.etype === etype);

  it("defers with a durable PendingPrincipalDecision receipt correlated to the ruling", async () => {
    const r = await run(parse(RELEASE), { provider: new MockProvider(scores), principal: "grant" });
    const seq = ledger(r);
    expect(seq).toContain("PendingPrincipalDecision");
    expect(seq.indexOf("PendingPrincipalDecision")).toBeLessThan(seq.indexOf("PrincipalDecision"));
    expect(seq.indexOf("PrincipalDecision")).toBeLessThan(seq.indexOf("Decided"));
    const pending = evt(r, "PendingPrincipalDecision")!;
    const ruling = evt(r, "PrincipalDecision")!;
    const decided = evt(r, "Decided")!;
    const endorsed = evt(r, "Endorsed")!;
    const requestHash = (pending.payload as { request_hash?: string }).request_hash;
    expect(requestHash).toMatch(/^[0-9a-f]{64}$/);
    expect((ruling.payload as { request_hash?: string }).request_hash).toBe(requestHash);
    expect((ruling.payload as { ruled_variant?: string }).ruled_variant).toBe("Approve");
    expect((decided.payload as { principal_request?: string }).principal_request).toBe(requestHash);
    expect((endorsed.payload as { principal_request?: string }).principal_request).toBe(requestHash);
    // the PrincipalDecision references the pending receipt's tick as its correlation id
    expect((ruling.payload as { pending?: number }).pending).toBe(pending.tick);
  });

  it("under the default `none` authenticator, records the ruling on trust but marks it unverified", async () => {
    const r = await run(parse(RELEASE), { provider: new MockProvider(scores), principal: "grant" });
    const ruling = evt(r, "PrincipalDecision")!;
    const attestation = (ruling.payload as { attestation?: { attester_verification?: string } }).attestation;
    expect(attestation?.attester_verification).toBe("unverified");
    expect(ledger(r)).toContain("ReleaseFunds");
  });

  it("with a bound host authenticator, a matching attester verifies and resumes to the sink", async () => {
    const manifest = parseManifestDirective("security.attesters.alice.driver=host");
    const r = await run(parse(RELEASE), {
      provider: new MockProvider(scores),
      principal: "grant",
      manifest,
      attesterVerifier: (req) => (req.principal === "alice" ? "alice" : undefined),
    });
    const ruling = evt(r, "PrincipalDecision")!;
    const attestation = (ruling.payload as { attestation?: { attester_verification?: string } }).attestation;
    expect(attestation?.attester_verification).toBe("verified");
    expect(ledger(r)).toContain("Endorsed");
    expect(ledger(r)).toContain("ReleaseFunds");
  });

  it("with a bound host authenticator, a WRONG-principal attester is rejected and fails closed", async () => {
    const manifest = parseManifestDirective("security.attesters.alice.driver=host");
    const r = await run(parse(RELEASE), {
      provider: new MockProvider(scores),
      principal: "grant",
      manifest,
      attesterVerifier: () => "mallory", // the verified identity is NOT the deferred principal
    });
    const seq = ledger(r);
    expect(seq).toContain("PendingPrincipalDecision");
    expect(seq).toContain("FailedPrincipalDecision");
    expect(seq).not.toContain("PrincipalDecision");
    expect(seq).not.toContain("Endorsed");
    expect(seq).not.toContain("ReleaseFunds"); // fail-closed: the sink never fires
    const failed = evt(r, "FailedPrincipalDecision")!;
    expect((failed.payload as { resolved_attester?: string }).resolved_attester).toBe("mallory");
  });

  it("a bound authenticator with NO verifier available rejects the ruling (fail-closed)", async () => {
    const manifest = parseManifestDirective("security.attesters.alice.driver=host");
    const r = await run(parse(RELEASE), { provider: new MockProvider(scores), principal: "grant", manifest });
    expect(ledger(r)).toContain("FailedPrincipalDecision");
    expect(ledger(r)).not.toContain("PrincipalDecision");
    expect(ledger(r)).not.toContain("ReleaseFunds");
  });
});

describe("the prompt sensor opens from its declaration (§5b)", () => {
  it("opens PromptOpened exactly once per declared prompt, even with two subscribers", async () => {
    const prog = `
      prompt text question;
      agent A { when (Prompt p about question) { say("a"); } }
      agent B { when (Prompt p about question) { say("b"); } }
      spawn A a; spawn B b; awake a; awake b;
    `;
    const r = await run(parse(prog), { provider: new MockProvider(() => ({})) });
    const opens = r.ledger.events.filter((e) => e.etype === "PromptOpened");
    expect(opens.length).toBe(1);
    expect(opens[0]!.subject).toBe("question");
  });

  it("opens the sensor for a declared prompt with NO subscriber", async () => {
    const prog = `
      prompt text question;
      agent A { on awake { say("hi"); } }
      spawn A a; awake a;
    `;
    const r = await run(parse(prog), { provider: new MockProvider(() => ({})) });
    expect(r.ledger.events.filter((e) => e.etype === "PromptOpened").length).toBe(1);
  });

  it("dispatches an attested prompt arrival to armed subscribers", async () => {
    const prog = `
      prompt text question;
      agent A {
        when (Prompt p about question) {
          say(p.text);
          say(p.attester);
        }
      }
      spawn A a; awake a;
    `;
    const r = await run(parse(prog), {
      provider: new MockProvider(() => ({})),
      promptInputs: [{ name: "question", value: "hello from the user", attestation: { attester: "local-user" } }],
    });
    expect(r.stdout).toEqual(["hello from the user", "local-user"]);
    const prompt = r.ledger.events.find((e) => e.etype === "Prompt");
    expect(prompt?.subject).toBe("question");
    expect((prompt?.payload as any)?.input).toMatchObject({
      content_hash: expect.any(String),
      protected_ref: expect.stringMatching(/^blob:sha256:/),
    });
    expect((prompt?.payload as any)?.attestation?.attester).toBe("local-user");
    expect((prompt?.payload as any)?.attestation?.payload_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("can route a cold conformal decision through local user attestation to a notification sink", async () => {
    const prog = `
      prompt text request;
      principal reviewer;
      enum Notice { Notify, Ignore }
      action NotifyUser(text body);
      event Held(text reason);
      agent Notifier grants { perform NotifyUser } {
        when (Prompt p about request) {
          text body = p.text;
          Credence<Notice> c = self <- f"should this request notify the user: \${body}";
          Decision<Notice> d = reviewer decide c by conformal 0.1;
          if (d.committed == Notify) {
            Endorsement<text> e = endorse body by d;
            perform NotifyUser(e);
          } else {
            emit Held("held");
          }
        }
      }
      spawn Notifier n; awake n;
    `;
    const r = await run(parse(prog), {
      provider: new MockProvider(() => ({ Notify: 0.91, Ignore: 0.09 })),
      promptInputs: [{ name: "request", value: "send a notification", attestation: { attester: "local-user" } }],
      principalAttestations: [{ principal: "reviewer", approved: true, attester: "local-user" }],
    });
    expect(r.ledger.events.map((e) => e.etype)).toContain("PrincipalDecision");
    const principal = r.ledger.events.find((e) => e.etype === "PrincipalDecision");
    expect((principal?.payload as any)?.decision).toBe("Notify");
    expect((principal?.payload as any)?.attestation?.attester).toBe("local-user");
    const notify = r.ledger.events.find((e) => e.etype === "NotifyUser");
    expect(notify?.payload).toMatchObject({ arguments: ["send a notification"] });
  });
});

describe("manifest-level ingress provenance", () => {
  const PROMPT_TO_PROVIDER = `
    prompt text request;
    enum Verdict { Yes, No }
    agent A {
      when (Prompt p about request) {
        Credence<Verdict> c = self <- f"judge this request: \${p.text}";
        say("judged");
      }
    }
    spawn A a; awake a;
  `;

  it("warns by default when a prompt input is rendered into a provider prompt", async () => {
    const r = await run(parse(PROMPT_TO_PROVIDER), {
      provider: new MockProvider(() => ({ Yes: 0.9, No: 0.1 })),
      promptInputs: [{ name: "request", value: "hello from outside" }],
    });
    expect(r.stdout).toEqual(["judged"]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatchObject({
      kind: "tainted_ingress_to_provider",
      ingress: "external_unscreened",
      subject: "c",
    });
    expect(r.warnings[0]!.prompt).toContain("hello from outside");
    const prompt = r.ledger.events.find((e) => e.etype === "Prompt");
    expect((prompt?.payload as any)?.input).toMatchObject({
      content_hash: expect.any(String),
      protected_ref: expect.stringMatching(/^blob:sha256:/),
    });
  });

  it("denies provider prompts that render unscreened ingress when configured strict", async () => {
    await expect(run(parse(PROMPT_TO_PROVIDER), {
      provider: new MockProvider(() => ({ Yes: 0.9, No: 0.1 })),
      manifest: { provider: { backend: "mock" }, security: { tainted_ingress_to_provider: "deny" } },
      promptInputs: [{ name: "request", value: "deny this" }],
    })).rejects.toMatchObject({ cls: "TaintViolation" });
  });

  it("does not apply the provider-ingress policy to action sinks", async () => {
    const prog = `
      prompt text request;
      action Notify(text body);
      agent A grants { perform Notify } {
        when (Prompt p about request) {
          perform Notify(p.text);
        }
      }
      spawn A a; awake a;
    `;
    const r = await run(parse(prog), {
      manifest: { provider: { backend: "mock" }, security: { tainted_ingress_to_provider: "deny" } },
      promptInputs: [{ name: "request", value: "ship it" }],
    });
    const notify = r.ledger.events.find((e) => e.etype === "Notify");
    expect(notify?.payload).toMatchObject({ arguments: ["ship it"] });
    expect(r.warnings).toEqual([]);
  });

  it("warns when a result-bound perform output is rendered into a provider prompt", async () => {
    const prog = `
      action Search(text q);
      event SearchEvidence(text hits);
      enum Verdict { Grounded, Unsupported }
      agent A grants { perform Search } {
        on awake {
          text hit = perform Search("northwind") expires 5;
          Credence<Verdict> c = self <- f"judge evidence: \${hit}";
        }
      }
      spawn A a; awake a;
    `;
    const r = await run(parse(prog), {
      provider: new MockProvider(() => ({ Grounded: 0.9, Unsupported: 0.1 })),
      manifest: {
        provider: { backend: "mock" },
        actions: { Search: { tool: "search", result_event: "SearchEvidence" } },
      },
    });
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]!.prompt).toContain("tool:search(search|northwind)");
    const resolved = r.ledger.events.find((e) => e.etype === "ToolResolved");
    expect((resolved?.payload as any)?.result).toMatchObject({ trust: "settled", ingress: "external_unscreened" });
    const resultEvent = r.ledger.events.find((e) => e.etype === "SearchEvidence");
    expect((resultEvent?.payload as any)?.hits).toMatchObject({ trust: "settled", ingress: "external_unscreened" });
  });
});

describe("manifest dependency bindings", () => {
  it("parses table-shaped conformance fixture bindings and the old flat shorthand", () => {
    const manifest = parseManifestDirective(
      "identity.alice.driver=local_keyring; prompts.question.driver=stdin; " +
      "tools.search.driver=mcp; tools.search.server=local-search; tools.legacy=mock; " +
      "security.tainted_ingress_to_provider=deny; " +
      "security.ingress.prompts.question.driver=mock-screen; " +
      "security.ingress.events.SearchEvidence.accepted=true",
    );
    expect(manifest.identity?.alice).toMatchObject({ driver: "local_keyring" });
    expect(manifest.prompts?.question).toMatchObject({ driver: "stdin" });
    expect(manifest.tools?.search).toMatchObject({ driver: "mcp", server: "local-search" });
    expect(manifest.tools?.legacy).toMatchObject({ driver: "mock" });
    expect(manifest.security?.tainted_ingress_to_provider).toBe("deny");
    expect(manifest.security?.ingress?.prompts?.question).toMatchObject({ driver: "mock-screen" });
    expect(manifest.security?.ingress?.events?.SearchEvidence).toMatchObject({ accepted: true });
  });

  it("routes a wired perform through the host adapter and lands the reply as the result event", async () => {
    const prog = `
      action Search(text q);
      event SearchEvidence(text hits);
      agent A grants { perform Search } {
        on awake {
          text hit = perform Search("northwind") expires 5;
          say(hit);
        }
      }
      spawn A a; awake a;
    `;
    const calls: string[] = [];
    const r = await run(parse(prog), {
      manifest: {
        provider: { backend: "mock" },
        tools: { search: { driver: "host", provider: "fixture" } },
        actions: { Search: { tool: "search", result_event: "SearchEvidence" } },
      },
      toolHandlers: {
        search: ({ args, binding }) => {
          calls.push(`${binding.provider}:${args[0]?.kind === "text" ? args[0].v : ""}`);
          return "northwind receipt";
        },
      },
    });
    expect(calls).toEqual(["fixture:northwind"]);
    expect(r.stdout).toEqual(["northwind receipt"]);
    const resolved = r.ledger.events.find((e) => e.etype === "ToolResolved");
    expect((resolved?.payload as any)?.binding).toMatchObject({ driver: "host", provider: "fixture" });
    expect((resolved?.payload as any)?.result).toMatchObject({ kind: "text", value: "northwind receipt" });
  });
  it("routes a wired perform through the built-in HTTP tool adapter", async () => {
    const requests: unknown[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        requests.push(JSON.parse(body));
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ result: "http receipt" }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("expected an ephemeral TCP address");
      const prog = `
        action Search(text q);
        event SearchEvidence(text hits);
        agent A grants { perform Search } {
          on awake {
            text hit = perform Search("northwind") expires 5;
            say(hit);
          }
        }
        spawn A a; awake a;
      `;

      const r = await run(parse(prog), {
        manifest: {
          provider: { backend: "mock" },
          tools: { search: { driver: "http", url: `http://127.0.0.1:${address.port}/tool` } },
          actions: { Search: { tool: "search", result_event: "SearchEvidence" } },
        },
      });

      expect(r.stdout).toEqual(["http receipt"]);
      expect(requests[0]).toMatchObject({ tool: "search", args: ["northwind"] });
      const resolved = r.ledger.events.find((e) => e.etype === "ToolResolved");
      expect((resolved?.payload as any)?.binding).toMatchObject({ driver: "http" });
      expect((resolved?.payload as any)?.result).toMatchObject({ kind: "text", value: "http receipt" });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
  });
});

describe("async fan-out", () => {
  it("runs `|>` mapped dependency paths concurrently while preserving the caller agent context", async () => {
    const prog = `
      action Search(text q);
      event SearchEvidence(text hits);
      enum Grounding { Grounded, Unsupported }
      struct Verification {
        claim: text,
        evidence: text,
        verdict: Grounding
      }

      Verification verify(text claim) {
        text evidence = perform Search(claim) expires 5;
        Credence<Grounding> c = self <- f"judge this claim using evidence: \${claim} / \${evidence}";
        Decision<Grounding> d = decide c by confidence 0.5;
        Verification result = Verification {
          claim: claim,
          evidence: evidence,
          verdict: Unsupported
        };
        if (d.committed == Grounded) {
          result = Verification {
            claim: claim,
            evidence: evidence,
            verdict: Grounded
          };
        }
        return result;
      }

      agent A grants { perform Search } {
        on awake {
          text[] claims = ["alpha", "beta", "gamma"];
          Verification[] rows = claims |> verify;
          say(rows);
        }
      }
      spawn A a; awake a;
    `;
    let activeSearches = 0;
    let maxActiveSearches = 0;
    let activeJudges = 0;
    let maxActiveJudges = 0;
    const order: string[] = [];
    class SlowJudgeProvider extends MockProvider {
      override async judge(prompt: string, enumName: string, variants: string[]) {
        activeJudges++;
        maxActiveJudges = Math.max(maxActiveJudges, activeJudges);
        order.push(`judge-start:${prompt}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push(`judge-end:${prompt}`);
        activeJudges--;
        return super.judge(prompt, enumName, variants);
      }
    }

    const r = await run(parse(prog), {
      provider: new SlowJudgeProvider(() => ({ Grounded: 0.9, Unsupported: 0.1 })),
      manifest: {
        provider: { backend: "mock" },
        tools: { search: { driver: "host" } },
        actions: { Search: { tool: "search", result_event: "SearchEvidence" } },
      },
      toolHandlers: {
        search: async ({ args }) => {
          const q = args[0]?.kind === "text" ? args[0].v : "";
          const delay = q === "alpha" ? 30 : q === "beta" ? 5 : 1;
          activeSearches++;
          maxActiveSearches = Math.max(maxActiveSearches, activeSearches);
          order.push(`search-start:${q}`);
          await new Promise((resolve) => setTimeout(resolve, delay));
          order.push(`search-end:${q}`);
          activeSearches--;
          return `evidence:${q}`;
        },
      },
    });

    expect(maxActiveSearches).toBeGreaterThan(1);
    expect(maxActiveJudges).toBeGreaterThan(1);
    expect(order.filter((x) => x.startsWith("search-start:")).length).toBe(3);
    expect(order.filter((x) => x.startsWith("judge-start:")).length).toBe(3);
    expect(r.ledger.events.filter((e) => e.etype === "ToolStarted").length).toBe(3);
    expect(r.ledger.events.filter((e) => e.etype === "Resolved").length).toBe(3);
    expect(r.ledger.events.filter((e) => e.etype === "ToolResolved").map((e) => (e.payload as any).payload))
      .toEqual(["search|alpha", "search|beta", "search|gamma"]);
    expect(r.ledger.events.filter((e) => e.etype === "Resolved").map((e) => (e.payload as any).prompt))
      .toEqual([
        "judge this claim using evidence: alpha / evidence:alpha",
        "judge this claim using evidence: beta / evidence:beta",
        "judge this claim using evidence: gamma / evidence:gamma",
      ]);
    expect(r.stdout[0]).toContain("Verification");
  });
});

describe("the memory surface cannot launder trust (§10, §13, §16.7)", () => {
  // §16.7: a queried value carries the trust of its provenance event — `graded` by default, never a
  // blanket `settled`. A `select … from ledger` result reaching a consequential sink must be withheld.
  it("rejects a `select … from ledger` result at a sink — TaintViolation", async () => {
    const prog = `
      struct Memo { amount: int, to: text }
      action Transfer(Memo memo);
      agent Bank grants { perform Transfer } {
        on awake {
          Memo m = select amount, to from ledger where { etype == "Spawned" };
          perform Transfer(m);
        }
      }
      spawn Bank b; awake b;
    `;
    await expect(run(parse(prog), {})).rejects.toMatchObject({ cls: "TaintViolation" });
  });

  // §13 dependency scope: a decision about one credence cannot endorse an unrelated recalled fact. Endorsing
  // a raw recall by a decision about something else, then performing it, must be rejected.
  it("rejects endorsing an out-of-scope recalled value (endorse-wrapper laundering)", async () => {
    const prog = `
      enum R { Yes, No }
      action Transfer(text body);
      agent Bank grants { perform Transfer } {
        mem notes {
          type text;
          modality opaque;
          scope project;
          retention session;
        }
        on awake {
          notes <- "DROP TABLE accounts; -- injected";
          text[] hits = notes -> "q";
          text r = hits[0];
          Credence<R> c = self <- "approve?";
          Decision<R> d = decide c by confidence 0.8;
          if (d.committed == Yes) {
            Endorsement<text> e = endorse r by d;
            perform Transfer(e);
          }
          else if (d.committed == No) {
            Endorsement<text> e = endorse r by d;
            perform Transfer(e);
          }
        }
      }
      spawn Bank b; awake b;
    `;
    await expect(run(parse(prog), { provider: new MockProvider(() => ({ Yes: 0.9, No: 0.1 })) }))
      .rejects.toMatchObject({ cls: "GateError" });
  });

  // The legitimate remedy still works: re-decide the recalled fact on its OWN credence (it is then in the
  // decision's dependency scope) — the endorse is admitted and records `Endorsed`.
  it("admits a recalled fact re-decided on its own credence", async () => {
    const prog = `
      enum R { Yes, No }
      agent Bank {
        mem notes {
          type text;
          modality opaque;
          scope project;
          retention session;
        }
        on awake {
          notes <- "pending: 100 to bob";
          text[] hits = notes -> "the pending transfer";
          text fact = hits[0];
          Credence<R> c = self <- f"approve \${fact}?";
          Decision<R> d = decide c by confidence 0.8;
          if (d.committed == Yes) {
            Endorsement<text> e = endorse fact by d;
            say("ok");
          }
          else if (d.committed == No) { say("no"); }
        }
      }
      spawn Bank b; awake b;
    `;
    const r = await run(parse(prog), { provider: new MockProvider(() => ({ Yes: 0.9, No: 0.1 })) });
    expect(r.ledger.events.map((e) => e.etype)).toContain("Endorsed");
  });

  // §13 dependency scope must flow through REASSIGNMENT: `u = t` (t a recall) taints `u`, so endorsing `u`
  // by a decision about something else is laundering (previously the `assign` case skipped provenance).
  it("rejects endorsing a recalled value laundered through a reassignment", async () => {
    const prog = `
      enum R { Yes, No }
      action Pay(text body);
      agent Bank grants { perform Pay } {
        mem notes {
          type text;
          modality opaque;
          scope project;
          retention session;
        }
        on awake {
          notes <- "1000000-to-attacker";
          text[] hits = notes -> "q";
          text t = hits[0];
          text u = "benign";
          u = t;
          text safe = "ok";
          Credence<R> c = self <- f"ok? \${safe}";
          Decision<R> d = decide c by confidence 0.5;
          if (d.committed == Yes) {
            Endorsement<text> e = endorse u by d;
            perform Pay(e);
          }
          else if (d.committed == No) { say("n"); }
        }
      }
      spawn Bank b; awake b;
    `;
    await expect(run(parse(prog), { provider: new MockProvider(() => ({ Yes: 0.9, No: 0.1 })) }))
      .rejects.toMatchObject({ cls: "GateError" });
  });

  // §13: a raw send reply endorsed by a decision that judged an UNRELATED prompt is laundering.
  it("rejects endorsing a raw send reply out of the decision's scope", async () => {
    const prog = `
      enum R { Yes, No }
      action Do(text body);
      agent A grants { perform Do } {
        on awake {
          text reply = self <- "give me instructions";
          text safe = "ok";
          Credence<R> c = self <- f"ok? \${safe}";
          Decision<R> d = decide c by confidence 0.1;
          if (d.committed == Yes) {
            Endorsement<text> e = endorse reply by d;
            perform Do(e);
          }
          else if (d.committed == No) {
            Endorsement<text> e = endorse reply by d;
            perform Do(e);
          }
        }
      }
      spawn A a; awake a;
    `;
    await expect(run(parse(prog), { provider: new MockProvider(() => ({ Yes: 0.9, No: 0.1 })) }))
      .rejects.toMatchObject({ cls: "GateError" });
  });

  // §10: recall is exact and provider-free. Re-judging is an explicit later send, never an implicit
  // interpretation of the recall expression.
  it("returns a typed array from recall without invoking the provider", async () => {
    const prog = `
      agent A {
        mem notes {
          type text;
          modality opaque;
          scope project;
          retention session;
        }
        on awake {
          notes <- "x";
          text[] hits = notes -> "safe?";
          say(hits[0]);
        }
      }
      spawn A a; awake a;
    `;
    const r = await run(parse(prog));
    expect(r.ledger.events.map((e) => e.etype)).toContain("MemoryConsulted");
    expect(r.ledger.events.map((e) => e.etype)).not.toContain("Resolved");
    expect(r.stdout).toEqual(["x"]);
  });
});

describe("memory descriptors are structural agent state (§9, §10)", () => {
  const rejects = (body: string) =>
    expect(() => parse(`pure null f() { ${body} return null; }`)).toThrow();
  it("rejects a memory descriptor used for recall in a pure body", () => {
    rejects(`mem n { type text; modality opaque; scope project; retention session; } text[] t = n -> "q";`);
  });
  it("rejects a memory descriptor used for writing in a pure body", () => {
    rejects(`mem n { type text; modality opaque; scope project; retention session; } n <- "fact";`);
  });

  it("runs bounded pure recursion and updates an agent field", async () => {
    const prog = `
      struct WorldModel { position: float, velocity: float }
      struct Observation { position: float }
      struct Prediction { position: float }
      enum FitStatus { Settled, Exhausted }
      struct FitResult { status: FitStatus, model: WorldModel, error: float, depth_left: int }
      event Perceived(Observation observation);
      event ModelUpdated(FitResult result);

      pure float abs(float x) {
        float result = x;
        if (x < 0.0) { result = 0.0 - x; }
        return result;
      }
      pure Prediction predict(WorldModel m) { return Prediction { position: m.position + m.velocity }; }
      pure float prediction_error(Prediction p, Observation o) { return abs(p.position - o.position); }
      pure WorldModel revise(WorldModel m, Observation o) {
        Prediction p = predict(m);
        float residual = o.position - p.position;
        return WorldModel { position: m.position + (0.50 * residual), velocity: m.velocity + (0.25 * residual) };
      }
      pure FitResult fit(WorldModel m, Observation o, float epsilon, int depth) {
        Prediction p = predict(m);
        float e = prediction_error(p, o);
        FitResult result = FitResult { status: Exhausted, model: m, error: e, depth_left: depth };
        if (e <= epsilon) {
          result = FitResult { status: Settled, model: m, error: e, depth_left: depth };
        } else if (depth <= 0) {
          result = FitResult { status: Exhausted, model: m, error: e, depth_left: depth };
        } else {
          WorldModel next = revise(m, o);
          result = fit(next, o, epsilon, depth - 1);
        }
        return result;
      }

      agent Observer {
        WorldModel model;
        model = WorldModel { position: 0.0, velocity: 0.0 };
        when (Perceived p) {
          FitResult result = fit(model, p.observation, 0.05, 8);
          model = result.model;
          emit ModelUpdated(result);
          say(f"\${result.status} \${result.error} \${model.position} \${model.velocity}");
        }
      }
      spawn Observer observer; awake observer;
      emit Perceived(Observation { position: 10.0 });
    `;
    const r = await run(parse(prog), {});
    // f-string interpolation renders enums as the bare variant (render(), not
    // show()) — same convention as ledger payloads.
    expect(r.stdout).toEqual(["Settled 0.0390625 6.640625 3.3203125"]);
    expect(r.ledger.events.map((e) => e.etype)).toContain("ModelUpdated");
  });
});

describe("`return` is honored in tail position only — nested returns are a static error, not a silent no-op (§4)", () => {
  // The runtime (interp callFn) acts on a `return` solely when it is the FINAL top-level statement of
  // a function body; a `return` anywhere else is never evaluated. Rather than let that misbehave at
  // runtime (it once silently ate a demo author's recursion), the checker rejects it as a TypeError.
  const rejectsReturn = (prog: string) =>
    expect(run(parse(prog), {})).rejects.toMatchObject({ cls: "TypeError" });

  it("rejects a `return` nested inside an `if` branch", async () => {
    await rejectsReturn(`pure int f(int x) { if (x < 0) { return 0 - x; } return x; }`);
  });

  it("rejects a `return` nested inside an `else` branch", async () => {
    await rejectsReturn(`pure int f(int x) { if (x < 0) { return x; } else { return 0 - x; } }`);
  });

  it("rejects a non-final top-level `return` in a function body", async () => {
    await rejectsReturn(`pure int f(int x) { return x; int y = x + 1; }`);
  });

  it("rejects a `return` inside a `retry` block", async () => {
    await rejectsReturn(`int f(int x) { { return x; } retry(2) return x; }`);
  });

  it("rejects a `return` in an agent hook (a non-function body never honors `return`)", async () => {
    await rejectsReturn(`agent A { on awake { return; } } spawn A a; awake a;`);
  });

  it("accepts a `return` in the spec'd tail position — the final statement of the function body", async () => {
    const prog = `
      pure int inc(int x) { return x + 1; }
      agent A { on awake { int y = inc(41); say(f"\${y}"); } }
      spawn A a; awake a;
    `;
    const r = await run(parse(prog), {});
    expect(r.stdout).toEqual(["42"]);
  });

  it("accepts a tail `return` reached after an `if` that assigns a result variable (the early-exit workaround)", async () => {
    const prog = `
      pure int classify(int x) {
        int result = x;
        if (x < 0) { result = 0 - x; }
        return result;
      }
      agent A { on awake { say(f"\${classify(0 - 7)}"); } }
      spawn A a; awake a;
    `;
    const r = await run(parse(prog), {});
    expect(r.stdout).toEqual(["7"]);
  });
});

describe("ledger reads carry recorded trust (§10) — Endorsed reads back settled", () => {
  // §10: a `from ledger` read is deterministic and carries recorded trust — an `Endorsed`-origin row reads
  // back `settled` (the ledger is the proof of endorsement), while a non-endorsed origin stays `graded`.
  it("an Endorsed-origin ledger row is settled and reaches a sink", async () => {
    const prog = `
      enum R { Yes, No }
      action Do(text body);
      agent A grants { perform Do } {
        on awake {
          text subj = self <- "describe";
          Credence<R> c = self <- f"ok: \${subj}";
          Decision<R> d = decide c by confidence 0.1;
          if (d.committed == Yes) {
            Endorsement<text> e = endorse subj by d;
            say("y");
          }
          else if (d.committed == No) { say("n"); }
          text row = select subject from ledger where { etype == "Endorsed" };
          perform Do(row);
        }
      }
      spawn A a; awake a;
    `;
    const r = await run(parse(prog), { provider: new MockProvider(() => ({ Yes: 0.9, No: 0.1 })) });
    expect(r.ledger.events.map((e) => e.etype)).toContain("Do");
  });

  it("a non-endorsed (Spawned) ledger row stays graded and is withheld at a sink", async () => {
    const prog = `
      enum R { Yes, No }
      action Do(text body);
      agent A grants { perform Do } {
        on awake {
          text row = select subject from ledger where { etype == "Spawned" };
          perform Do(row);
        }
      }
      spawn A a; awake a;
    `;
    await expect(run(parse(prog), { provider: new MockProvider(() => ({ Yes: 0.9, No: 0.1 })) }))
      .rejects.toMatchObject({ cls: "TaintViolation" });
  });
});

describe("structs (§3) — a record value with field access", () => {
  it("constructs a declared struct and reads a field back", async () => {
    const prog = `
      struct Memo { amount: int, to: text }
      Memo m = Memo { amount: 100, to: "bob" };
      say(m.to);
    `;
    const r = await run(parse(prog), {});
    expect(r.stdout).toEqual(["bob"]);
  });

  it("rejects a struct literal missing a required field — TypeError", async () => {
    const prog = `
      struct Memo { amount: int, to: text }
      Memo m = Memo { amount: 100 };
    `;
    await expect(run(parse(prog), {})).rejects.toMatchObject({ cls: "TypeError" });
  });

  it("rejects a struct literal with an undeclared extra field — TypeError", async () => {
    const prog = `
      struct Memo { amount: int }
      Memo m = Memo { amount: 25, to: "alice" };
    `;
    await expect(run(parse(prog), {})).rejects.toMatchObject({ cls: "TypeError" });
  });

  it("binds a struct-typed send through a structured provider schema", async () => {
    const prog = `
      struct Memo { amount: int, to: text }
      agent A {
        on awake {
          Memo m = self <- "extract the memo";
          say(m.to);
          say(f"\${m.amount}");
        }
      }
      spawn A a; awake a;
    `;
    const provider = new RecordingStructuredProvider({ amount: 125, to: "bob" });
    const r = await run(parse(prog), { provider });
    expect(r.stdout).toEqual(["bob", "125"]);
    expect(provider.calls[0]!.schema).toEqual({
      type: "object",
      properties: { amount: { type: "integer" }, to: { type: "string" } },
      required: ["amount", "to"],
      additionalProperties: false,
    });
    const resolved = r.ledger.events.find((e) => e.etype === "Resolved" && e.subject === "m");
    expect((resolved!.payload as any).kind).toBe("structured");
    expect((resolved!.payload as any).value).toBeUndefined();
    expect((resolved!.payload as any).reply).toMatchObject({
      kind: "struct",
      fields: {
        amount: { kind: "int", value: 125 },
        to: { kind: "text", value: "bob" },
      },
    });
  });

  it("records TypeMismatch when a structured provider reply violates the struct schema", async () => {
    const prog = `
      struct Memo { amount: int, to: text }
      agent A {
        on awake {
          Memo m = self <- "extract the memo";
        }
      }
      spawn A a; awake a;
    `;
    const r = await run(parse(prog), { provider: new RecordingStructuredProvider({ amount: "oops", to: "bob" }) });
    expect(r.ledger.events.map((e) => e.etype)).toContain("TypeMismatch");
  });
});

describe("core grammar lockstep — removed constructs are ParseErrors", () => {
  // The strip is enforced by assertCore (parser.ts): a construct outside the core kernel is a ParseError.
  it("rejects a gate arm block", () => {
    expect(() => parse(`enum V{A,B} agent X { on awake { Credence<V> c = self <- "q"; decide c by confidence 0.9 { A {} B {} } } }`))
      .toThrow(/core kernel/);
  });
  it("rejects all()/quorum keeps", () => {
    expect(() => parse(`agent X { on awake { Credence<bool> a = self <- "q"; Credence<bool> b = self <- "q"; independent a,b; Credence<bool> f = all(a,b); } }`))
      .toThrow(/core kernel/);
  });
  it("rejects a policy declaration", () => {
    expect(() => parse(`policy P { threshold 0.5 } agent X { on awake { say("x"); } }`)).toThrow(/core kernel/);
  });
});

// A provider that returns a FIXED, un-normalized score vector (the gate reads the raw leads, §15.5.6).
class RawScoreProvider extends MockProvider {
  constructor(private readonly fixed: Record<string, number>) { super(); }
  override async judge(): Promise<{ scores: Record<string, number> }> { return { scores: { ...this.fixed } }; }
}

describe("§13/§16.6 consequential margin floor at the sink", () => {
  // Publish clears the 0.8 threshold and the 0.0 margin, so the decision COMMITS; but its 0.02 lead is below
  // the rule's 0.5 floor, so the committed value faults the action when it reaches the `perform` sink.
  const src = `
    enum Verdict { Publish, Revise }
    action PublishMemo(text body);
    agent A grants { perform PublishMemo } {
      on awake {
        text body = "draft";
        Credence<Verdict> c = self <- "publish?";
        Decision<Verdict> d = decide c by confidence 0.8 margin 0.0 floor 0.5;
        if (d.committed == Publish) {
          Endorsement<text> e = endorse body by d;
          perform PublishMemo(e);
        }
      }
    }
    spawn A a; awake a;
  `;

  it("commits the decision but faults the action with MarginFloorViolation, preventing the sink", async () => {
    const r = await run(parse(src), { provider: new RawScoreProvider({ Publish: 0.81, Revise: 0.79 }) });
    const types = r.ledger.events.map((e) => e.etype);
    // the decision itself COMMITTED — the floor is a sink check, not a decide-time abstain (§13).
    const decided = r.ledger.events.find((e) => e.etype === "Decided");
    expect((decided!.payload as Record<string, unknown>).committed).toBe("Publish");
    expect((decided!.payload as Record<string, unknown>).floor).toBe(0.5);
    // the sink faults: a typed MarginFloorViolation is appended and the action never runs.
    expect(types).toContain("MarginFloorViolation");
    expect(types).not.toContain("PublishMemo");
  });

  it("performs the action when the committed margin clears the floor", async () => {
    // a decisive judgment: Publish's 0.90 − 0.10 = 0.80 lead clears the 0.5 floor, so the perform runs.
    const r = await run(parse(src), { provider: new RawScoreProvider({ Publish: 0.9, Revise: 0.1 }) });
    const types = r.ledger.events.map((e) => e.etype);
    expect(types).toContain("PublishMemo");
    expect(types).not.toContain("MarginFloorViolation");
  });
});

describe("§15.5.6 warm split-conformal prediction sets", () => {
  const src = (readiness: number) => `
    enum Gate { Approve, Reject }
    agent Calib {
      on awake {
        Credence<Gate> c = self <- "judge";
        Decision<Gate> d = decide c by conformal 0.1 readiness ${readiness};
      }
    }
    spawn Calib g; awake g;
  `;
  // four labelled cases; nonconformity at the true label = {0.05, 0.10, 0.08, 0.12}. With α=0.1, n=4 the
  // quantile rank ⌈(n+1)(1−α)⌉ = 5 > n, so q̂ clamps to the largest observed nc = 0.12.
  const pool = [
    { scores: { Approve: 0.95, Reject: 0.05 }, label: "Approve" },
    { scores: { Approve: 0.9, Reject: 0.1 }, label: "Approve" },
    { scores: { Approve: 0.08, Reject: 0.92 }, label: "Reject" },
    { scores: { Approve: 0.12, Reject: 0.88 }, label: "Reject" },
  ];
  const decidedPayload = (r: Awaited<ReturnType<typeof run>>) =>
    r.ledger.events.find((e) => e.etype === "Decided")!.payload as Record<string, unknown>;

  it("commits on a singleton prediction set once readiness is met", async () => {
    // judgment {Approve:0.93} → nc(Approve)=0.07 ≤ 0.12, nc(Reject)=0.93 > 0.12 ⇒ Cα = {Approve} (singleton).
    const r = await run(parse(src(4)), {
      provider: new RawScoreProvider({ Approve: 0.93, Reject: 0.07 }),
      calibration: pool,
    });
    const p = decidedPayload(r);
    expect(p.basis).toBe("Conformal");
    expect(p.prediction_set).toEqual(["Approve"]);
    expect(p.committed).toBe("Approve");
  });

  it("abstains when the prediction set is not a singleton", async () => {
    // a boundary judgment {0.5, 0.5}: nc = {0.5, 0.5}, both > q̂=0.12 ⇒ Cα = {} (non-singleton) ⇒ abstain.
    const r = await run(parse(src(4)), {
      provider: new RawScoreProvider({ Approve: 0.5, Reject: 0.5 }),
      calibration: pool,
    });
    const p = decidedPayload(r);
    expect(p.basis).toBe("Conformal");
    expect((p.prediction_set as string[]).length).not.toBe(1);
    expect(p.committed).toBe("abstained");
  });

  it("cold-starts (abstains, no prediction set) below readiness or with no calibration pool", async () => {
    const r = await run(parse(src(4)), { provider: new RawScoreProvider({ Approve: 0.93, Reject: 0.07 }) });
    const p = decidedPayload(r);
    expect(p.committed).toBe("abstained");
    expect(p.prediction_set).toBeUndefined();
  });
});

describe("§17.7 host embedding — the onEvent live ledger observer", () => {
  const PROG = `
    agent A {
      on awake { emit Event("hello"); emit Event("world"); }
    }
    spawn A a; awake a;
  `;

  it("invokes onEvent once per append, in tick order, matching the committed ledger", async () => {
    const observed: { tick: number; etype: string }[] = [];
    const r = await run(parse(PROG), { onEvent: (e) => observed.push({ tick: e.tick, etype: e.etype }) });
    // one callback per committed event, in the ledger's tick order
    expect(observed.map((e) => e.tick)).toEqual(r.ledger.events.map((e) => e.tick));
    expect(observed.map((e) => e.etype)).toEqual(r.ledger.events.map((e) => e.etype));
    // ticks are the canonical 0..n-1 append order
    expect(observed.map((e) => e.tick)).toEqual(observed.map((_v, i) => i));
    expect(observed.map((e) => e.etype)).toContain("AgentAwake");
  });

  it("contains an exception thrown by the observer — the run and ledger are unaffected", async () => {
    let calls = 0;
    const r = await run(parse(PROG), { onEvent: () => { calls++; throw new Error("observer boom"); } });
    // every append still fired the (throwing) callback, and the run completed with a full ledger
    expect(calls).toBe(r.ledger.events.length);
    expect(r.ledger.events.map((e) => e.etype)).toContain("AgentAwake");
    expect(r.ledger.events.filter((e) => e.etype === "Event").length).toBe(2);
  });
});

// A provider whose seam faults on EVERY send: `empty` (an unrecoverable seam failure) or `schema_violation`
// (a structured reply that fails its declared schema). Mirrors the conformance harness's fault injection.
class FaultProvider extends MockProvider {
  constructor(readonly fault: "empty" | "schema_violation") { super(); }
}

describe("§16.6 reaction-boundary crash containment + informative fault messages", () => {
  const reasonOf = (r: Awaited<ReturnType<typeof run>>) =>
    (r.ledger.events.find((e) => e.etype === "AgentCrashed")?.payload as { reason?: string } | undefined)?.reason;

  it("contains a crash raised inside a `when` reaction body — AgentCrashed + on-crash, never escaping run()", async () => {
    const prog = `
      event Go(text x);
      event Recovered(text how);
      agent A {
        when (Go g) { Credence<bool> c = self <- "is the sky blue?"; }
        on crash { emit Recovered("state intact"); }
      }
      spawn A a; awake a;
      emit Go("start");
    `;
    // an empty-seam fault raised inside the `when (Go g)` body must be contained just like `on awake` —
    // before the reaction-boundary fix this CrashError escaped run() entirely, bypassing `on crash`.
    const r = await run(parse(prog), { provider: new FaultProvider("empty") });
    const etypes = r.ledger.events.map((e) => e.etype);
    expect(etypes).toContain("AgentCrashed"); // contained, not thrown out of run()
    expect(etypes).toContain("Recovered");    // the agent's on-crash hook ran with state intact
    const reason = reasonOf(r);
    expect(reason).toBeTruthy();
    expect(reason).not.toBe("");               // the AgentCrashed row NAMES why (no empty message)
    expect(reason).toMatch(/empty seam result|no completion/);
  });

  it("names the declared type in the crash reason when a structured reply violates its schema (TypeMismatch)", async () => {
    const prog = `
      struct Receipt { vendor: text, total_cents: int }
      event Recovered(text how);
      agent A {
        on awake { Receipt receipt = self <- "extract the receipt"; say(receipt.vendor); }
        on crash { emit Recovered("held"); }
      }
      spawn A a; awake a;
    `;
    const r = await run(parse(prog), { provider: new FaultProvider("schema_violation") });
    expect(r.ledger.events.map((e) => e.etype)).toContain("TypeMismatch");
    const reason = reasonOf(r);
    expect(reason).toBeTruthy();
    // the owner ruling: the fault text must NAME the declared type and the schema violation
    expect(reason).toContain("Receipt");
    expect(reason).toMatch(/did not match|could not be parsed|violated/);
  });

  it("names the delegated task and its fail reason when a foreground delegation faults the delegator", async () => {
    const prog = `
      event Go(text x);
      event Recovered(text how);
      agent Worker { on assigned { fail "cannot settle the claim"; } }
      agent Lead grants { reach Worker } {
        when (Go g) {
          Worker w = spawn Worker; awake w;
          text r = w <- task { objective "produce a number"; acceptance "an int"; } expires 10;
          say(r);
        }
        on crash { emit Recovered("abstained"); }
      }
      spawn Lead lead; awake lead;
      emit Go("start");
    `;
    const r = await run(parse(prog));
    expect(r.ledger.events.map((e) => e.etype)).toContain("AgentCrashed");
    expect(r.ledger.events.map((e) => e.etype)).toContain("Recovered");
    const reason = reasonOf(r);
    expect(reason).toBeTruthy();
    expect(reason).toContain("failed");
    expect(reason).toContain("cannot settle the claim"); // the correlated TaskFailed(reason) is surfaced
  });
});
