import { describe, expect, it } from "vitest";
import { changedFields, edgePath, layoutFlow, visibleFlow } from "./flowModel.js";

const nodes = [
  { id: "prompt:q", kind: "prompt", label: "question", fields: [] },
  { id: "agent:Checker", kind: "agent", label: "Checker", fields: [] },
  { id: "model:judge", kind: "model", label: "judge", fields: [{ key: "instruction", value: "check evidence" }] },
  { id: "decision:d", kind: "decision", label: "confidence gate", fields: [{ key: "threshold", value: 0.8 }] },
  { id: "event:done", kind: "event", label: "Done", fields: [] },
];
const edges = [
  { id: "a", source: "prompt:q", target: "agent:Checker" },
  { id: "b", source: "agent:Checker", target: "model:judge" },
  { id: "c", source: "model:judge", target: "decision:d" },
  { id: "d", source: "decision:d", target: "event:done" },
];

describe("flow model", () => {
  it("lays a large dependency flow left-to-right and keeps stable backend positions", () => {
    const positioned = [...nodes, { id: "fixed", kind: "output", label: "fixed", position: { x: 9, y: 13 } }];
    const layout = layoutFlow(positioned, edges);
    expect(layout["prompt:q"].x).toBeLessThan(layout["agent:Checker"].x);
    expect(layout["model:judge"].x).toBeLessThan(layout["decision:d"].x);
    expect(layout.fixed).toEqual({ x: 9, y: 13 });
  });

  it("filters by kind/search and focuses the selected node plus direct neighbors", () => {
    expect(visibleFlow(nodes, edges, { query: "evidence" }).nodes.map((n) => n.id)).toEqual(["model:judge"]);
    expect(visibleFlow(nodes, edges, { kinds: ["decision"] }).edges).toEqual([]);
    expect(visibleFlow(nodes, edges, { focusId: "model:judge" }).nodes.map((n) => n.id)).toEqual([
      "agent:Checker", "model:judge", "decision:d",
    ]);
  });

  it("emits only actual editable field changes", () => {
    const document = { nodes };
    expect(changedFields(document, { "model:judge:instruction": "check primary sources", "decision:d:threshold": 0.8 }))
      .toEqual([{ nodeId: "model:judge", field: "instruction", value: "check primary sources" }]);
  });

  it("draws a connector only when both endpoints have positions", () => {
    expect(edgePath(edges[0], { "prompt:q": { x: 0, y: 0 }, "agent:Checker": { x: 400, y: 40 } })).toMatch(/^M /);
    expect(edgePath(edges[0], {})).toBe("");
  });
});
