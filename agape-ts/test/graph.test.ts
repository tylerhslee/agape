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

  it("has the instance cluster, its hook, and the gate", () => {
    const agent = node(g, "agent:desk");
    expect(agent?.kind).toBe("agent");
    expect(agent?.label).toBe("desk: Desk");
    const hook = node(g, "hook:desk/awake");
    expect(hook?.parent).toBe("agent:desk");
    const gate = g.nodes.find((n) => n.kind === "gate");
    expect(gate?.parent).toBe("agent:desk");
    expect(gate?.meta?.enum).toBe("Verdict");
    expect(String(gate?.meta?.rule)).toContain("confidence 0.85");
    expect(String(gate?.meta?.rule)).toContain("margin 0.1");
  });

  it("draws the credence flow into the gate", () => {
    const flow = edges(g, "flow");
    expect(flow.length).toBe(1);
    expect(flow[0]!.from).toBe("hook:desk/awake");
    expect(flow[0]!.label).toBe("Credence<Verdict>");
  });

  it("guards the sink edge with the committed variant", () => {
    expect(node(g, "sink:Reimburse")?.kind).toBe("sink");
    const sink = edges(g, "sink");
    expect(sink.length).toBe(1);
    expect(sink[0]!.to).toBe("sink:Reimburse");
    expect(sink[0]!.variant).toBe("Approve");
    // the edge leaves the GATE, not the hook — the sink is reachable only through the gate.
    expect(sink[0]!.from).toBe(g.nodes.find((n) => n.kind === "gate")!.id);
  });

  it("wires emit -> the top-level subscriber, with variant guards where present", () => {
    const ev = edges(g, "event");
    expect(ev.length).toBe(3); // one per emit site (Approve / Deny / abstain arms)
    for (const e of ev) {
      expect(e.label).toBe("Logged");
      expect(node(g, e.to)?.kind).toBe("handler");
    }
    expect(ev.map((e) => e.variant).sort()).toEqual(["Approve", "Deny", undefined].sort());
  });

  it("records the spawn edge and no unconsumed-event nodes", () => {
    expect(edges(g, "spawn").length).toBe(1);
    expect(g.nodes.filter((n) => n.kind === "event").length).toBe(0);
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

  it("keeps the unconsumed emit visible as a dead-end event node", () => {
    const ev = node(g, "event:Wired");
    expect(ev?.kind).toBe("event");
    const e = edges(g, "event");
    expect(e.length).toBe(1);
    expect(e[0]!.to).toBe("event:Wired");
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

  it("wires the intra-agent event edge emit Held -> when Held", () => {
    const ev = edges(g, "event").filter((e) => e.label === "Held");
    expect(ev.length).toBe(1);
    expect(node(g, ev[0]!.to)?.label).toBe("when Held");
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
    expect(dot).toContain("sink:Reimburse");
  });
});
