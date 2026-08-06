import { describe, expect, it } from "vitest";
import { applyFlowChanges, buildFlowDocument, FlowEditError } from "./flow-model.ts";

const SOURCE = `
prompt text question;
action Publish(text answer);
event Final(text status);

agent FactChecker grants { perform Publish } {
  when (Prompt p about question) {
    Credence<Verdict> readiness = self <- f"Check this answer: \${p.text}";
    Decision<Verdict> decision = decide readiness by confidence 0.8;
    if (decision.committed == Accept) {
      Endorsement<text> approved = endorse p.text by decision;
      perform Publish(approved);
      emit Final("published");
      say(f"answer: \${approved}");
    }
  }
}
`;

describe("Agape flow model", () => {
  it("extracts an inspectable graph with stable editable prompt and gate fields", () => {
    const doc = buildFlowDocument("main.ag", SOURCE);
    expect(doc.schemaVersion).toBe(1);
    expect(doc.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(doc.nodes.find((node) => node.id === "agent:FactChecker")).toBeTruthy();
    const model = doc.nodes.find((node) => node.kind === "model");
    expect(model?.fields.find((field) => field.key === "instruction")).toMatchObject({ readOnly: false });
    const decision = doc.nodes.find((node) => node.kind === "decision");
    expect(decision?.fields.find((field) => field.key === "threshold")?.value).toBe(0.8);
    expect(doc.nodes.every((node) => Array.isArray(node.fields) && Number.isFinite(node.position.x))).toBe(true);
    const ids = new Set(doc.nodes.map((node) => node.id));
    expect(doc.edges.every((edge) => ids.has(edge.source) && ids.has(edge.target))).toBe(true);
  });

  it("round-trips exact-span edits without rewriting surrounding source or interpolations", () => {
    const before = buildFlowDocument("main.ag", SOURCE);
    const model = before.nodes.find((node) => node.kind === "model")!;
    const decision = before.nodes.find((node) => node.kind === "decision")!;
    const changed = applyFlowChanges("main.ag", SOURCE, [
      { nodeId: model.id, field: "instruction", value: "Verify carefully: ${p.text}" },
      { nodeId: decision.id, field: "threshold", value: 0.9 },
    ]);
    expect(changed.source).toContain('f"Verify carefully: ${p.text}"');
    expect(changed.source).toContain("by confidence 0.9");
    expect(changed.source.replace('Verify carefully: ${p.text}', 'Check this answer: ${p.text}').replace("confidence 0.9", "confidence 0.8")).toBe(SOURCE);
  });

  it("rejects malicious, unknown, duplicate, and out-of-range changes atomically", () => {
    const decision = buildFlowDocument("main.ag", SOURCE).nodes.find((node) => node.kind === "decision")!;
    expect(() => applyFlowChanges("main.ag", SOURCE, [{ nodeId: "../../secret", field: "instruction", value: "x" }])).toThrow(FlowEditError);
    expect(() => applyFlowChanges("main.ag", SOURCE, [{ nodeId: decision.id, field: "threshold", value: 2 }])).toThrow(FlowEditError);
    expect(() => applyFlowChanges("main.ag", SOURCE, [
      { nodeId: decision.id, field: "threshold", value: 0.2 },
      { nodeId: decision.id, field: "threshold", value: 0.3 },
    ])).toThrow(FlowEditError);
  });

  it("keeps computed delegation messages visible and read-only", () => {
    const doc = buildFlowDocument("delegate.ag", "agent A { on awake { Task<text> h = self <- approved expires 5; } }");
    const node = doc.nodes.find((candidate) => candidate.kind === "model");
    expect(node).toBeTruthy();
    expect(node?.readOnly).toBe(true);
    expect(doc.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "computed_prompt_read_only", nodeId: node?.id })]));
  });
});
