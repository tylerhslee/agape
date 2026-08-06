import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildGraph } from "../../agape-ts/src/graph.ts";
import { parse } from "../../agape-ts/src/parser.ts";
import { applyFlowChanges, buildFlowDocument, FlowEditError } from "./flow-model.ts";

const EDIT_SOURCE = `
prompt text question;
enum Verdict { Accept, Reject }
action Reply(text answer);
agent Checker grants { perform Reply } {
  when (Prompt p about question) {
    Credence<Verdict> c = self <- f"compare \${p.text}; repeat \${p.text}; context \${question}";
    Decision<Verdict> d = decide c by confidence 0.7;
    if (d.committed == Accept) {
      Endorsement<text> approved = endorse p.text by d;
      perform Reply(approved);
      say(f"approved \${p.text}");
    }
  }
}
spawn Checker checker;
awake checker;
`;

function diagnosticFor(source: string, change: { nodeId: string; field: string; value: unknown }) {
  try {
    applyFlowChanges("main.ag", source, [change]);
    throw new Error("expected flow edit rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(FlowEditError);
    return (error as FlowEditError).diagnostics[0];
  }
}

describe("flow edit safety invariants", () => {
  it("accepts only finite JSON numbers in range for confidence thresholds", () => {
    const decision = buildFlowDocument("main.ag", EDIT_SOURCE).nodes.find((node) => node.kind === "decision")!;
    for (const value of [null, true, false, "0.7", NaN, Infinity, -Infinity, -0.1, 1.1]) {
      expect(diagnosticFor(EDIT_SOURCE, { nodeId: decision.id, field: "threshold", value })).toMatchObject({
        code: "invalid_value",
        nodeId: decision.id,
        field: "threshold",
      });
    }
    for (const value of [0, 0.25, 1]) {
      expect(applyFlowChanges("main.ag", EDIT_SOURCE, [{ nodeId: decision.id, field: "threshold", value }]).source).toContain(`confidence ${value}`);
    }
  });

  it("preserves the exact interpolation token multiset, including duplicates", () => {
    const document = buildFlowDocument("main.ag", EDIT_SOURCE);
    const model = document.nodes.find((node) => node.kind === "model")!;
    const reordered = applyFlowChanges("main.ag", EDIT_SOURCE, [{
      nodeId: model.id,
      field: "instruction",
      value: "context ${question}; repeat ${p.text}; compare ${p.text}",
    }]);
    expect(reordered.source).toContain("context ${question}; repeat ${p.text}; compare ${p.text}");

    for (const value of [
      "compare ${p.text}; context ${question}",
      "compare ${p.text}; repeat ${question}; context ${question}",
      "compare ${p.text}; repeat ${p.text}; context ${question}; extra ${p.text}",
      "compare p.text; repeat ${p.text}; context ${question}",
    ]) {
      const diagnostic = diagnosticFor(EDIT_SOURCE, { nodeId: model.id, field: "instruction", value });
      expect(diagnostic).toMatchObject({ code: "invalid_value", nodeId: model.id, field: "instruction" });
      expect(diagnostic.message).toContain("including duplicates");
    }

    const output = document.nodes.find((node) => node.kind === "output")!;
    expect(diagnosticFor(EDIT_SOURCE, { nodeId: output.id, field: "template", value: "approved" })).toMatchObject({
      code: "invalid_value",
      field: "template",
    });
  });

  it("round-trips escaped interpolation literals without turning them into live expressions", () => {
    const live = "${p.text}";
    const escapedLiteral = "\\${example}";
    const slashBeforeLive = "\\\\${p.text}";
    const rawBody = String.raw`literal ${escapedLiteral}; live ${live}; slash-live ${slashBeforeLive}; quote \"old\"; line\nnext; tab\tend; path C:\\tmp`;
    const source = `agent A { on awake { text answer = self <- f"${rawBody}"; } }`;
    const model = buildFlowDocument("escapes.ag", source).nodes.find((node) => node.kind === "model")!;
    const instruction = model.fields.find((field) => field.key === "instruction")!.value;

    expect(instruction).toBe(`literal ${escapedLiteral}; live ${live}; slash-live ${slashBeforeLive}; quote "old"; line\nnext; tab\tend; path C:\\tmp`);
    expect(applyFlowChanges("escapes.ag", source, [{ nodeId: model.id, field: "instruction", value: instruction }]).source).toBe(source);

    const editedValue = `updated ${escapedLiteral}; live ${live}; slash-live ${slashBeforeLive}; quote "new"; line\nchanged; tab\tkept; path D:\\work`;
    const edited = applyFlowChanges("escapes.ag", source, [{ nodeId: model.id, field: "instruction", value: editedValue }]);
    const editedBody = String.raw`updated ${escapedLiteral}; live ${live}; slash-live ${slashBeforeLive}; quote \"new\"; line\nchanged; tab\tkept; path D:\\work`;
    expect(edited.source).toBe(`agent A { on awake { text answer = self <- f"${editedBody}"; } }`);

    const reparsed = buildFlowDocument("escapes.ag", edited.source).nodes.find((node) => node.kind === "model")!;
    expect(reparsed.fields.find((field) => field.key === "instruction")!.value).toBe(editedValue);
  });

  it("round-trips ordinary strings containing interpolation-shaped text", () => {
    const rawPlain = "\\\\${x}";
    const decodedPlain = "\\${x}";
    const source = `agent A { on awake { text answer = self <- "literal ${rawPlain}"; say("output ${rawPlain}"); } }`;
    const document = buildFlowDocument("plain-escapes.ag", source);
    const model = document.nodes.find((node) => node.kind === "model")!;
    const output = document.nodes.find((node) => node.kind === "output")!;
    const instruction = model.fields.find((field) => field.key === "instruction")!.value;
    const template = output.fields.find((field) => field.key === "template")!.value;

    expect(instruction).toBe(`literal ${decodedPlain}`);
    expect(template).toBe(`output ${decodedPlain}`);
    expect(applyFlowChanges("plain-escapes.ag", source, [
      { nodeId: model.id, field: "instruction", value: instruction },
      { nodeId: output.id, field: "template", value: template },
    ]).source).toBe(source);

    const edited = applyFlowChanges("plain-escapes.ag", source, [
      { nodeId: model.id, field: "instruction", value: `updated ${decodedPlain}` },
      { nodeId: output.id, field: "template", value: `changed ${decodedPlain}` },
    ]);
    expect(edited.source).toBe(`agent A { on awake { text answer = self <- "updated ${rawPlain}"; say("changed ${rawPlain}"); } }`);
  });
});

const TOPOLOGY_SOURCE = `
prompt text question;
enum Verdict { Accept, Reject }
action Reply(text answer);
event Checked(text answer);
principal reviewer;

text helper(text input) {
  Credence<Verdict> helper_c = self <- f"helper \${input}";
  Decision<Verdict> helper_d = decide helper_c by confidence 0.6;
  return input;
}

agent Checker grants { perform Reply } {
  when (Prompt p about question) {
    Credence<Verdict> c = self <- f"check \${p.text}";
    Decision<Verdict> d = reviewer decide c by confidence 0.7;
    text answer = helper(p.text);
    if (d.committed == Accept) { perform Reply(answer); }
  }
  when (Checked e) { say(f"logged \${e.answer}"); }
}
spawn Checker checker;
awake checker;
`;

function expectHonestCompilerEdges(source: string, rel: string) {
  const graph = buildGraph(parse(source), rel);
  const document = buildFlowDocument(rel, source, graph);
  expect(document.edges.some((edge) => edge.kind === "control")).toBe(false);
  const compilerEdges = document.edges.filter((edge) => edge.kind.startsWith("compiler:"));
  expect(compilerEdges).toHaveLength(graph.edges.length);
  for (const edge of compilerEdges) {
    const from = document.nodes.find((node) => node.id === edge.source)!;
    const to = document.nodes.find((node) => node.id === edge.target)!;
    expect(from).toBeTruthy();
    expect(to).toBeTruthy();
  }
  return document;
}

describe("compiler-grounded flow topology", () => {
  it("does not synthesize adjacency across functions or handlers", () => {
    const document = expectHonestCompilerEdges(TOPOLOGY_SOURCE, "topology.ag");
    const kinds = new Set(document.nodes.map((node) => node.kind));
    expect([...kinds]).toEqual(expect.arrayContaining(["agent", "function", "handler", "principal"]));
    const compilerNodes = document.nodes.filter((node) => node.id.startsWith("compiler:"));
    expect(compilerNodes.every((node) => node.readOnly && node.readOnlyReason && node.fields.some((field) => field.key === "compilerKind"))).toBe(true);
    const edgeKinds = new Set(document.edges.map((edge) => edge.kind));
    expect([...edgeKinds]).toEqual(expect.arrayContaining(["compiler:prompt", "compiler:call", "compiler:flow", "compiler:escalate", "compiler:sink"]));
    expect(document.edges.filter((edge) => edge.kind === "subscription")).toHaveLength(0);
  });

  const repositoryFactChecker = new URL("../../agape-ts/examples/fact_checker.ag", import.meta.url);
  it("represents every compiler edge in the repository-owned fact checker", () => {
    const source = readFileSync(repositoryFactChecker, "utf8");
    const document = expectHonestCompilerEdges(source, "agape-ts/examples/fact_checker.ag");
    const compilerKinds = new Set(document.nodes.map((node) => node.metadata?.compilerKind).filter(Boolean));
    expect([...compilerKinds]).toEqual(expect.arrayContaining(["agent", "fn", "handler"]));
    expect(document.nodes.some((node) => node.kind === "model")).toBe(true);
    expect(document.nodes.some((node) => node.kind === "decision")).toBe(true);
    expect(document.nodes.some((node) => node.kind === "output")).toBe(true);
  });

  const dogfoodFactChecker = process.env.AGAPE_FACT_CHECKER_SOURCE || "";
  it.skipIf(!dogfoodFactChecker || !existsSync(dogfoodFactChecker))("covers the full dogfood fact checker when AGAPE_FACT_CHECKER_SOURCE is set", () => {
    const source = readFileSync(dogfoodFactChecker, "utf8");
    const document = expectHonestCompilerEdges(source, "dogfood/fact_checker.ag");
    const count = (kind: string) => document.nodes.filter((node) => node.metadata?.compilerKind === kind).length;
    expect(count("agent")).toBe(2);
    expect(count("fn")).toBe(13);
    expect(count("handler")).toBe(3);
    expect(count("hook")).toBe(2);
    expect(count("principal")).toBe(1);
    expect(document.nodes.some((node) => node.kind === "principal" && node.label === "reviewer")).toBe(true);
    const edgeKinds = new Set(document.edges.map((edge) => edge.kind));
    expect([...edgeKinds]).toEqual(expect.arrayContaining(["compiler:prompt", "compiler:call", "compiler:flow", "compiler:event", "compiler:escalate", "compiler:sink", "compiler:send"]));
    expect(document.diagnostics.some((diagnostic) => diagnostic.code === "unresolved_compiler_edge")).toBe(true);
  });
});
