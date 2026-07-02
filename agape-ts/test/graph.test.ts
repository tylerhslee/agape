// The orchestration graph (GRAPH.md): statically derived from the AST — nodes for instances/
// handlers/gates/sinks/…, edges for the produce/consume relation, gate escalation, and guarded
// sinks. These tests pin the extraction on small kernel programs.

import { describe, it, expect } from "vitest";
import { parse } from "../src/parser.js";
import { buildGraph, toDot, type ProgramGraph } from "../src/graph.js";

function graphOf(src: string): ProgramGraph {
  return buildGraph(parse(src), "test.ag");
}

const node = (g: ProgramGraph, id: string) => g.nodes.find((n) => n.id === id);
const edges = (g: ProgramGraph, kind: string) => g.edges.filter((e) => e.kind === kind);

const GATED = `
enum Verdict { Approve, Deny }
struct Claim { amount_cents: int, summary: text }
event  Logged(text note);
action Reimburse(int cents);

agent Desk grants { perform Reimburse } {
  on awake {
    Claim claim = self <- "extract the claim";
    Credence<Verdict> c = self <- f"approve {claim.amount_cents}?";
    Decision<Verdict> d = decide c by confidence 0.85 margin 0.1;
    if (d.committed == Approve) {
      Endorsement<Claim> e = endorse claim by d;
      perform Reimburse(e.amount_cents);
      emit Logged("approved");
    } else if (d.committed == Deny) {
      emit Logged("denied");
    } else {
      emit Logged("needs-review");
    }
  }
}

when (Logged l) { say(f"log: {l.note}"); }

spawn Desk desk;
awake desk;
`;

describe("graph: the gated-sink chain", () => {
  const g = graphOf(GATED);

  it("has the instance cluster, its hook, and the standalone gate diamond", () => {
    const agent = node(g, "agent:desk");
    expect(agent?.kind).toBe("agent");
    expect(agent?.label).toBe("desk: Desk");
    const hook = node(g, "hook:desk/awake");
    expect(hook?.parent).toBe("agent:desk");
    const gate = g.nodes.find((n) => n.kind === "gate");
    expect(gate?.parent).toBeUndefined(); // the decision is pulled OUT of the agent box
    expect(gate?.meta?.agent).toBe("desk");
    expect(gate?.meta?.enum).toBe("Verdict");
    expect(String(gate?.meta?.rule)).toContain("confidence 0.85");
    expect(String(gate?.meta?.rule)).toContain("margin 0.1");
  });

  it("shows both model asks and chains them by dataflow into the gate", () => {
    const asks = g.nodes.filter((n) => n.kind === "ask");
    expect(asks.map((a) => a.label).sort()).toEqual(["ask Claim", "ask Credence<Verdict>"]);
    for (const a of asks) expect(a.parent).toBe("agent:desk");
    const flow = edges(g, "flow");
    const gate = g.nodes.find((n) => n.kind === "gate")!;
    const askClaim = asks.find((a) => a.label === "ask Claim")!;
    const askCred = asks.find((a) => a.label === "ask Credence<Verdict>")!;
    // hook -> ask Claim; ask Claim -> ask Credence (the prompt references `claim`);
    // ask Credence -> gate (the credence); ask Claim -> gate (the endorsed subject).
    expect(flow.some((e) => e.from === "hook:desk/awake" && e.to === askClaim.id)).toBe(true);
    expect(flow.some((e) => e.from === askClaim.id && e.to === askCred.id)).toBe(true);
    expect(flow.some((e) => e.from === askCred.id && e.to === gate.id)).toBe(true);
    expect(flow.some((e) => e.from === askClaim.id && e.to === gate.id)).toBe(true);
  });

  it("guards the per-site sink box with the committed variant", () => {
    const site = g.nodes.find((n) => n.kind === "sink")!;
    expect(site.label).toBe("perform Reimburse");
    expect(site.meta?.action).toBe("Reimburse");
    expect(site.meta?.variant).toBe("Approve");
    const sink = edges(g, "sink");
    expect(sink.length).toBe(1);
    expect(sink[0]!.to).toBe(site.id);
    expect(sink[0]!.variant).toBe("Approve");
    // the edge leaves the GATE, not the hook — the sink is reachable only through the gate.
    expect(sink[0]!.from).toBe(g.nodes.find((n) => n.kind === "gate")!.id);
  });

  it("gives each emit its own site box and wires sites -> the subscriber", () => {
    const sites = g.nodes.filter((n) => n.kind === "emit");
    expect(sites.length).toBe(3); // one per arm (Approve / Deny / abstain)
    for (const st of sites) {
      expect(st.label).toBe("emit Logged");
      expect(st.meta?.consumed).toBe(true);
    }
    expect(sites.map((st) => st.meta?.variant).sort()).toEqual(["Approve", "Deny", "abstain"].sort());
    const ev = edges(g, "event");
    const armEdges = ev.filter((e) => node(g, e.to)?.kind === "emit");
    const subEdges = ev.filter((e) => node(g, e.to)?.kind === "handler");
    expect(armEdges.length).toBe(3); // gate -> site, branch-guarded
    expect(armEdges.map((e) => e.variant).sort()).toEqual(["Approve", "Deny", "abstain"].sort());
    expect(subEdges.length).toBe(3); // site -> the top-level subscriber, labelled by the event
    for (const e of subEdges) expect(e.label).toBe("Logged");
  });

  it("omits the boilerplate program node (top level is only spawn/awake/when)", () => {
    expect(node(g, "top")).toBeUndefined();
    expect(edges(g, "spawn").length).toBe(0);
  });
});

describe("graph: principal escalation", () => {
  const g = graphOf(`
enum Approval { Approve, Deny }
event Wired(text note);
action WireFunds(int cents);
principal boss;
agent Treasurer grants { perform WireFunds } {
  on awake {
    Credence<Approval> c = self <- "judge";
    Decision<Approval> d = boss decide c by conformal 0.05;
    if (d.committed == Approve) {
      Endorsement<int> e = endorse 1 by d;
      perform WireFunds(e);
    } else { emit Wired("held"); }
  }
}
spawn Treasurer t;
awake t;
`);

  it("draws gate -> principal", () => {
    expect(node(g, "principal:boss")?.kind).toBe("principal");
    const esc = edges(g, "escalate");
    expect(esc.length).toBe(1);
    expect(esc[0]!.to).toBe("principal:boss");
    expect(node(g, esc[0]!.from)?.kind).toBe("gate");
  });

  it("keeps the unconsumed emit visible as a dashed dead-end site", () => {
    const site = g.nodes.find((n) => n.kind === "emit")!;
    expect(site.label).toBe("emit Wired");
    expect(site.meta?.consumed).toBe(false);
    expect(site.meta?.variant).toBe("abstain"); // it lives in the residual arm
    const e = edges(g, "event");
    expect(e.length).toBe(1); // gate -> site only; no subscriber edges
    expect(e[0]!.to).toBe(site.id);
  });
});

describe("graph: prompts, sends, memory, ledger, tools", () => {
  const g = graphOf(`
prompt text request;
enum Notice { Notify, Ignore }
event Held(text reason);
read tool int Lookup(text q);
agent Notifier grants { use Lookup } {
  mem notes;
  when (Prompt p about request) {
    notes <- p.text;
    text past = notes -> "similar requests";
    int n = Lookup("prior notices");
    emit Held("seen");
  }
  when (Held h) {
    LedgerEntry<Held> row = select Held as x from ledger where { x.reason == "seen" };
  }
}
spawn Notifier a;
awake a;
`);

  it("wires prompt sensor -> the about-handler", () => {
    expect(node(g, "prompt:request")?.kind).toBe("prompt");
    const pe = edges(g, "prompt");
    expect(pe.length).toBe(1);
    expect(pe[0]!.from).toBe("prompt:request");
    expect(node(g, pe[0]!.to)?.label).toBe("when Prompt");
  });

  it("draws store and recall against the mem handle", () => {
    expect(node(g, "mem:a/notes")?.kind).toBe("mem");
    expect(edges(g, "store").length).toBe(1);
    expect(edges(g, "recall").length).toBe(1);
    expect(edges(g, "recall")[0]!.from).toBe("mem:a/notes");
  });

  it("draws the tool call and the ledger query", () => {
    expect(node(g, "tool:Lookup")?.meta?.effect).toBe("read");
    expect(edges(g, "tool").length).toBe(1);
    expect(node(g, "ledger")).toBeTruthy();
    const q = edges(g, "query");
    expect(q.length).toBe(1);
    expect(q[0]!.label).toBe("Held");
  });

  it("wires emit Held through its site to when Held", () => {
    const sub = edges(g, "event").filter((e) => e.label === "Held");
    expect(sub.length).toBe(1);
    expect(node(g, sub[0]!.from)?.kind).toBe("emit");
    expect(node(g, sub[0]!.to)?.label).toBe("when Held");
  });
});

describe("graph: agent-to-agent send", () => {
  const g = graphOf(`
agent Worker {}
agent Boss(Worker hand) grants { reach Worker } {
  on awake {
    text r = hand <- "delegate this";
  }
}
spawn Worker w;
spawn Boss b(w);
awake b;
`);

  it("resolves the ctor-param destination to the spawned instance", () => {
    const s = edges(g, "send");
    expect(s.length).toBe(1);
    expect(s[0]!.to).toBe("agent:w"); // `hand` is bound to `w` at `spawn Boss b(w)`
    expect(s[0]!.label).toBe("text");
    expect(s[0]!.from).toBe("hook:b/awake");
  });
});

describe("graph: dot output", () => {
  it("emits clusters and edges", () => {
    const dot = toDot(graphOf(GATED));
    expect(dot).toContain("digraph");
    expect(dot).toContain("subgraph cluster_");
    expect(dot).toContain("perform Reimburse");
  });
});
