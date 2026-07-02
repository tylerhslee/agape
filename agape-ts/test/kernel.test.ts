import { describe, it, expect } from "vitest";
import { parse } from "../src/parser.js";
import { run } from "../src/interp.js";
import { MockProvider } from "../src/runtime.js";

const HELLO = `
enum Verdict { Publish, Revise }
action Announce(text body);
event  Revised(text note);

agent Greeter grants { perform Announce } {
  on awake {
    text draft = "hello, world";
    Credence<Verdict> v = self <- f"is this safe to publish: {draft}";
    Decision<Verdict> d = decide v by confidence 0.8;
    endorse draft by d {
      Publish as e { perform Announce(e); }
      Revise      { emit Revised("held"); }
    } abstain {
      emit Revised("uncertain");
    }
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

describe("the trusted kernel — gate chain", () => {
  it("commits to Publish and reaches the Announce sink with the endorsed subject", async () => {
    const r = await runWith({ Publish: 0.95, Revise: 0.05 });
    expect(etypes(r)).toContain("Endorsed");
    const announce = r.ledger.events.find((e) => e.etype === "Announce");
    expect(announce).toBeDefined();
    expect(announce!.payload).toEqual(["hello, world"]); // Endorsement<text> coerced to its subject
    expect(etypes(r)).not.toContain("Revised");
  });

  it("commits to Revise → the Announce sink does NOT fire", async () => {
    const r = await runWith({ Publish: 0.05, Revise: 0.95 });
    expect(etypes(r)).not.toContain("Announce");
    const rev = r.ledger.events.find((e) => e.etype === "Revised");
    expect(rev!.payload).toEqual(["held"]);
  });

  it("abstains below threshold → no commit, no sink, abstain branch runs", async () => {
    const r = await runWith({ Publish: 0.5, Revise: 0.5 }); // top 0.5 < 0.8 → abstained
    expect(etypes(r)).toContain("Abstained");
    expect(etypes(r)).not.toContain("Announce");
    const rev = r.ledger.events.find((e) => e.etype === "Revised");
    expect(rev!.payload).toEqual(["uncertain"]);
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
  // `decide c by <principal>` reaches the identity dependency. SPEC §13: "A declined or unavailable
  // principal records `FailedPrincipalDecision` and the decision stays `abstained`." An unconfigured /
  // unavailable principal must NEVER fabricate an approval that never happened.
  const RELEASE = `
    enum Approval { Approve, Decline }
    action ReleaseFunds(int amount);
    principal alice;
    agent Clerk grants { perform ReleaseFunds } {
      on awake {
        Credence<Approval> c = self <- "assess this refund request";
        Decision<Approval> d = decide c by alice;
        endorse c by d {
          Approve as e { perform ReleaseFunds(10000); }
          Decline as e { emit Event("declined"); }
        } abstain { emit Event("withheld"); }
      }
    }
    spawn Clerk a; awake a;
  `;
  const scores = () => ({ Approve: 0.9, Decline: 0.1 });
  const ledger = (r: Awaited<ReturnType<typeof run>>) => r.ledger.events.map((e) => e.etype);

  it("fails closed (abstain) when no principal directive is configured — no fabricated approval", async () => {
    const r = await run(parse(RELEASE), { provider: new MockProvider(scores) });
    expect(ledger(r)).toContain("FailedPrincipalDecision");
    expect(ledger(r)).toContain("Abstained");
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
  // A `prompt T NAME;` declaration opens a standing external input sensor. The sensor opens because the
  // source is DECLARED — once, independent of how many agents subscribe (`when (Prompt … about NAME)`).
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

  // §13 dependency scope: a decision about one credence cannot endorse an unrelated recalled/queried fact.
  // Endorsing a raw recall by a decision about something else, then performing it, must be rejected.
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
          endorse r by d {
            Yes as e { perform Transfer(e); }
            No  as e { perform Transfer(e); }
          }
        }
      }
      spawn Bank b; awake b;
    `;
    await expect(run(parse(prog), { provider: new MockProvider(() => ({ Yes: 0.9, No: 0.1 })) }))
      .rejects.toMatchObject({ cls: "GateError" });
  });

  // The legitimate remedy still works: re-decide the queried fact on its OWN credence (it is then in the
  // decision's dependency scope) — the endorse is admitted and records `Endorsed`.
  it("admits a queried fact re-decided on its own credence", async () => {
    const prog = `
      struct Memo { amount: int, to: text }
      enum R { Yes, No }
      action Transfer(Memo memo);
      agent Bank grants { perform Transfer } {
        on awake {
          Memo m = select amount, to from self where { kind: "pending" };
          Credence<R> c = self <- f"approve {m}?";
          Decision<R> d = decide c by confidence 0.8;
          endorse m by d {
            Yes as e { say("ok"); }
            No  as e { say("no"); }
          }
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
          endorse u by d { Yes as e { perform Pay(e); } No as e { say("n"); } }
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
          endorse reply by d { Yes as e { perform Do(e); } No as e { perform Do(e); } }
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
  it("rejects a ledger/facts select in a sync body", async () => { await rejects(`array<R> rs = select c from self where { a == 1 };`); });
  it("rejects store() in a sync body", async () => { await rejects(`store("fact");`); });
  it("rejects embed() in a sync body", async () => { await rejects(`embed("vec");`); });
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
          Credence<R> c = self <- "ok?";
          Decision<R> d = decide c by confidence 0.1;
          endorse c by d { Yes as e { } No as e { } }
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
});

describe("reproducibility", () => {
  it("same provider script → identical chain-head (recorded replay equivalence, T4)", async () => {
    const a = await runWith({ Publish: 0.9, Revise: 0.1 });
    const b = await runWith({ Publish: 0.9, Revise: 0.1 });
    expect(a.ledger.head()).toBe(b.ledger.head());
  });
});
