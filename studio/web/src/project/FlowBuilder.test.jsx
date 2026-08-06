import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import FlowBuilder from "./FlowBuilder.jsx";

describe("FlowBuilder", () => {
  it("renders a project-backed program selector before loading the flow", () => {
    const html = renderToStaticMarkup(<FlowBuilder info={{ files: [{ rel: "fact_checker.ag" }, { rel: "support.ag" }] }} />);
    expect(html).toContain("Agentic flow");
    expect(html).toContain("fact_checker.ag");
    expect(html).toContain("support.ag");
    expect(html).toContain("Reading flow");
  });
});
