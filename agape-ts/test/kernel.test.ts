import { describe, it, expect } from "vitest";
import { parse } from "../src/parser.js";
import { run } from "../src/interp.js";
import { MockProvider, type StructuredSchema } from "../src/runtime.js";
import { parseManifestDirective } from "../src/config.js";

const HELLO = `
enum Verdict { Publish, Revise }
action Announce(text body);
event  Revised(text note);

agent Greeter grants { perform Announce } {
  on awake {
    text draft = "hello, world";
    Credence<Verdict> v = self <- f"is this safe to publish: {draft}";
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

describe("the trusted kernel — gate chain", () => {
  it("commits to Publish and reaches the Announce sink with the endorsed subject", async () => {
    const r = await runWith({ Publish: 0.95, Revise: 0.05 });
    expect(etypes(r)).toContain("Endorsed");
    const announce = r.ledger.events.find((e) => e.etype === "Announce");
    expect(announce).toBeDefined();
    expect(announce!.payload).toEqual(["hello, world"]); // Endorsement<text> coerced to its subject
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
    const memory = internalized?.payload as any;
    expect(memory?.memory).toContain('I was asked "summarize the incoming claim"');
    expect(memory?.memory).toContain("I received a text value from the provider");
    expect(memory?.memory).toContain('I learned the reply content was "claim summary"');
    expect(memory?.source_event).toBe(resolved?.tick);
    expect(memory?.reply?.kind).toBe("text");
    expect(memory?.kind).toBeUndefined();
    expect(memory?.experienced).toBeUndefined();
    expect(memory?.experience).toBeUndefined();
  });

  it("records the raw bad value when a structured reply fails its schema", async () => {
    const r = await run(parse(TEXT_REPLY), { provider: new RecordingStructuredProvider({ value: "wrapped" }) });
    expect(r.stdout).toEqual(["null"]);
    const mismatch = r.ledger.events.find((e) => e.etype === "TypeMismatch" && e.subject === "claim");
    expect(mismatch?.payload).toMatchObject({
      schema: { type: "string" },
      raw: { value: "wrapped" },
      error: "structured reply field is not text",
    });
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
          say(f"total: {receipt.total_cents}");
          say(f"review: {receipt.needs_review}");
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
    // §16.7: the mandatory memory envelope internalizes every received typed reply — struct replies
    // included (cfg_internalize_is_mandatory pins the same for bare text replies).
    const internalized = r.ledger.events.find((e) => e.etype === "Internalized" && e.subject === "receipt");
    expect(internalized).toBeDefined();
    const memory = internalized?.payload as any;
    expect(memory?.memory).toContain("I received a structured Receipt from the provider");
    expect(memory?.memory).toContain("I learned the provider filled 3 fields: vendor, total_cents, needs_review");
    expect(memory?.kind).toBeUndefined();
    expect(memory?.experienced).toBeUndefined();
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
    const prog = `
      agent A {
        on awake {
          mem notes;
          LedgerEntry<Internalized> receipt = notes <- "durable note";
          say(receipt._meta.etype);
          say(receipt.refs.input);
        }
      }
      spawn A a; awake a;
    `;
    const r = await run(parse(prog), {});
    expect(r.stdout[0]).toBe("Internalized");
    expect(r.stdout[1]).toMatch(/^blob:sha256:/);
    const internalized = r.ledger.events.find((e) => e.etype === "Internalized" && e.subject === "notes");
    expect((internalized?.payload as any)?.effects?.facts?.upserted).toBe(1);
    expect((internalized?.payload as any)?.policy?.background_reindex).toBe("runtime-managed");
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
    expect((prompt?.payload as any)?.input).toMatchObject({ kind: "text", value: "hello from the user", trust: "settled" });
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
          Credence<Notice> c = self <- f"should this request notify the user: {body}";
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
    expect(notify?.payload).toEqual(["send a notification"]);
  });
});

describe("manifest dependency bindings", () => {
  it("parses table-shaped conformance fixture bindings and the old flat shorthand", () => {
    const manifest = parseManifestDirective(
      "identity.alice.driver=local_keyring; prompts.question.driver=stdin; " +
      "tools.search.driver=mcp; tools.search.server=local-search; tools.legacy=mock",
    );
    expect(manifest.identity?.alice).toMatchObject({ driver: "local_keyring" });
    expect(manifest.prompts?.question).toMatchObject({ driver: "stdin" });
    expect(manifest.tools?.search).toMatchObject({ driver: "mcp", server: "local-search" });
    expect(manifest.tools?.legacy).toMatchObject({ driver: "mock" });
  });

  it("routes a configured non-mock tool through the host adapter and validates the declared return type", async () => {
    const prog = `
      read tool text search(text q);
      agent A grants { use search } {
        on awake {
          text hit = search("northwind");
          say(hit);
        }
      }
      spawn A a; awake a;
    `;
    const calls: string[] = [];
    const r = await run(parse(prog), {
      manifest: { provider: { backend: "mock" }, tools: { search: { driver: "host", provider: "fixture" } } },
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
});

describe("async fan-out", () => {
  it("runs `|>` mapped dependency paths concurrently while preserving the caller agent context", async () => {
    const prog = `
      read tool text search(text q);
      enum Grounding { Grounded, Unsupported }
      struct Verification {
        claim: text,
        evidence: text,
        verdict: Grounding
      }

      Verification verify(text claim) {
        text evidence = search(claim);
        Credence<Grounding> c = self <- f"judge this claim using evidence: {claim} / {evidence}";
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

      agent A grants { use search } {
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
      manifest: { provider: { backend: "mock" }, tools: { search: { driver: "host" } } },
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
        on awake {
          mem notes <- "DROP TABLE accounts; -- injected";
          text r = notes -> "q";
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
        on awake {
          mem notes <- "pending: 100 to bob";
          text fact = notes -> "the pending transfer";
          Credence<R> c = self <- f"approve {fact}?";
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
        on awake {
          mem notes <- "1000000-to-attacker";
          text t = notes -> "q";
          text u = "benign";
          u = t;
          text safe = "ok";
          Credence<R> c = self <- f"ok? {safe}";
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
          Credence<R> c = self <- f"ok? {safe}";
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

  // §10: a recall is graded when bound to a Credence<E> slot (the spec's prescribed re-judging path) —
  // the checker must NOT false-reject `Credence<E> c = mem -> "q"` with "cannot assign text to credence".
  it("admits a recall bound into a Credence slot (re-judging path)", async () => {
    const prog = `
      enum YN { Yes, No }
      agent A {
        on awake {
          mem notes <- "x";
          Credence<YN> c = notes -> "safe?";
          say("ok");
        }
      }
      spawn A a; awake a;
    `;
    const r = await run(parse(prog), { provider: new MockProvider(() => ({ Yes: 0.9, No: 0.1 })) });
    expect(r.ledger.events.map((e) => e.etype)).toContain("MemoryConsulted");
  });
});

describe("sync color reaches the async memory substrate (§9, §10)", () => {
  const rejects = (body: string) =>
    expect(run(parse(`sync null f() { ${body} return null; }`), {})).rejects.toMatchObject({ cls: "ColorViolation" });
  it("rejects a recall in a sync body", async () => { await rejects(`mem n <- "x"; text t = n -> "q";`); });
  it("rejects a memory write in a sync body", async () => { await rejects(`mem n; n <- "fact";`); });
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
          Credence<R> c = self <- f"ok: {subj}";
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
          say(f"{m.amount}");
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
