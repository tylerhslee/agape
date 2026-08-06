import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Inspector } from "./FlowBuilder.jsx";

describe("Flow inspector", () => {
  it("renders editable and read-only properties from the backend contract", () => {
    const node = {
      id: "decision:FactChecker:publish",
      kind: "decision",
      label: "Publish confidence",
      readOnly: false,
      fields: [
        { key: "threshold", label: "Threshold", type: "number", value: 0.8, readOnly: false },
        { key: "rule", label: "Rule", type: "text", value: "confidence", readOnly: true, readOnlyReason: "Rule changes require Code." },
      ],
    };
    const html = renderToStaticMarkup(<Inspector node={node} draft={{}} setDraft={() => {}} documentReadOnly={false} />);
    expect(html).toContain("Publish confidence");
    expect(html).toContain('value="0.8"');
    expect(html).toContain("Rule changes require Code.");
    expect(html).toContain("disabled");
  });

  it("explains constructs that are intentionally inspect-only", () => {
    const html = renderToStaticMarkup(<Inspector node={{ id: "action:Search", kind: "action", label: "Search", fields: [], readOnly: true,
      readOnlyReason: "Action declarations are source-only in v1." }} draft={{}} setDraft={() => {}} documentReadOnly={false} />);
    expect(html).toContain("Visible, not editable");
    expect(html).toContain("Action declarations are source-only in v1.");
  });
});
