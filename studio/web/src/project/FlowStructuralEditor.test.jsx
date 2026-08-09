import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FlowCanvas, Inspector, connectionPatch } from "./FlowBuilder.jsx";

const declaration = (kind, name) => ({
  id: `${kind}-decl:${name}`, kind, label: name, readOnly: false, fields: [],
  metadata: { compilerMeta: { declaration: true, handoffKind: kind, name } },
});
const invocation = (kind, name) => ({
  id: `${kind}:Worker:${name}`, kind, label: name, readOnly: false, fields: [],
  metadata: { compilerMeta: { invocation: true, handoffKind: kind, target: name } },
});

describe("Flow structural editor", () => {
  it("derives only explicit compatible port-drop patches", () => {
    expect(connectionPatch(invocation("event", "Ping"), declaration("event", "Pong"))).toEqual({
      op: "reconnect_handoff", nodeId: "event:Worker:Ping", target: "Pong",
    });
    expect(connectionPatch(invocation("event", "Ping"), declaration("action", "Audit"))).toBeNull();
    expect(connectionPatch({ id: "agent:Worker", kind: "agent" }, declaration("event", "Pong"))).toEqual({
      op: "add_handoff", contextNodeId: "agent:Worker", handoff: "event", target: "Pong",
    });
    expect(connectionPatch({ id: "compiler:agent:worker", kind: "agent", metadata: { compilerNodeId: "agent:worker" } }, {
      id: "compiler:agent:reviewer", kind: "agent", metadata: { compilerNodeId: "agent:reviewer" },
    })).toEqual({
      op: "add_handoff", contextNodeId: "instance:worker", handoff: "message", target: "reviewer",
    });
    expect(connectionPatch({ id: "agent:Worker", kind: "agent" }, { id: "compiler:agent:reviewer", kind: "agent", metadata: { compilerNodeId: "agent:reviewer" } })).toBeNull();
  });

  it("renders distinct layout, connection, reorder, and removal targets", () => {
    const node = invocation("event", "Ping");
    const html = renderToStaticMarkup(<FlowCanvas
      nodes={[node, declaration("event", "Pong")]}
      edges={[]}
      positions={{ [node.id]: { x: 42, y: 42 }, "event-decl:Pong": { x: 340, y: 42 } }}
      setPositions={() => {}} rel="main.ag" selected={node.id} setSelected={() => {}}
      bounds={{ width: 760, height: 520 }} compact={false} draggable
    />);
    expect(html).toContain("Drag to arrange this canvas");
    expect(html).toContain("Drag onto a compatible input port to rewrite source");
    expect(html).toContain("Drag onto another source-backed step to reorder");

    const inspector = renderToStaticMarkup(<Inspector node={node} draft={{}} setDraft={() => {}}
      documentReadOnly={false} capabilities={{ deleteNodes: true }} />);
    expect(inspector).toContain("Remove handoff");
  });
});
