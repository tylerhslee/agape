import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Inspector } from "./FlowBuilder.jsx";
import { FLOW_KINDS, kindIcon, layoutFlow, visibleFlow } from "./flowModel.js";

const COMPILER_KINDS = ["program", "function", "handler", "hook", "principal", "memory", "ledger", "tool"];

describe("compiler-derived flow kinds", () => {
  it("keeps every backend compiler kind available to filters with a distinct icon", () => {
    expect(FLOW_KINDS).toEqual(expect.arrayContaining(COMPILER_KINDS));
    for (const kind of COMPILER_KINDS) expect(kindIcon(kind)).not.toBe("ti-box");
  });

  it("filters and lays out compiler-derived nodes without special cases", () => {
    const nodes = COMPILER_KINDS.map((kind, index) => ({ id: `${kind}:${index}`, kind, label: kind, fields: [], position: null }));
    const edges = nodes.slice(1).map((node, index) => ({ id: `edge:${index}`, source: nodes[index].id, target: node.id }));
    const visible = visibleFlow(nodes, edges, { kinds: ["memory", "ledger"] });
    expect(visible.nodes.map((node) => node.kind)).toEqual(["memory", "ledger"]);
    const positions = layoutFlow(nodes, edges);
    expect(Object.keys(positions)).toHaveLength(COMPILER_KINDS.length);
    expect(Object.values(positions).every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y))).toBe(true);
  });

  it("explains compiler-derived source-only context even when metadata fields exist", () => {
    const reason = "Compiler-derived topology context; edit the corresponding Agape source in Code view.";
    const node = {
      id: "function:verifyClaim",
      kind: "function",
      label: "verifyClaim",
      readOnly: true,
      readOnlyReason: reason,
      fields: [{ key: "compilerKind", label: "Compiler kind", type: "text", value: "function", readOnly: true }],
    };
    const html = renderToStaticMarkup(<Inspector node={node} draft={{}} setDraft={() => {}} documentReadOnly={false} />);
    expect(html).toContain(reason);
    expect(html).toContain("Compiler kind");
    expect(html).toContain("disabled");
  });
});
