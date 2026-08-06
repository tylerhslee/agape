import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import FlowBuilder, { FlowCanvas } from "./FlowBuilder.jsx";

describe("Flow Builder interaction contract", () => {
  it("states that source properties and canvas layout are different edit surfaces", () => {
    const html = renderToStaticMarkup(<FlowBuilder info={{ files: [{ rel: "fact_checker.ag" }] }} />);
    expect(html).toContain("Property edits rewrite");
    expect(html).toContain("dragging arranges this canvas only");
  });

  it("makes temporary filtered layouts explicitly non-draggable", () => {
    const html = renderToStaticMarkup(<FlowCanvas
      nodes={[{ id: "agent:A", kind: "agent", label: "A", fields: [] }]}
      edges={[]}
      positions={{ "agent:A": { x: 42, y: 42 } }}
      setPositions={() => {}}
      rel="main.ag"
      selected={null}
      setSelected={() => {}}
      bounds={{ width: 760, height: 520 }}
      compact={false}
      draggable={false}
    />);
    expect(html).toContain("locked-layout");
    expect(html).toContain("Clear filters or focus mode to arrange the canvas");
  });
});
