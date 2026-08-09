import { describe, expect, it } from "vitest";
import { buildGraph } from "../../agape-ts/src/graph.ts";
import { parse } from "../../agape-ts/src/parser.ts";
import { applyFlowStructuralPatch, FlowStructuralEditError, structuralCapabilities } from "./flow-structural-edit.ts";

const SOURCE = `// keep this project note
event Ping();
event Pong();
event Typed(text value);
action Audit();
action Publish(text value);

agent Worker grants { perform Audit } {
  on awake {
    emit Ping(); // keep this comment
    emit Pong();
  }
}
`;

describe("AST-grounded structural flow patches", () => {
  it("creates and dependency-safely deletes agent definitions while preserving unrelated bytes", () => {
    const created = applyFlowStructuralPatch("main.ag", SOURCE, { op: "create_agent", name: "Reviewer" });
    expect(created.source).toContain("agent Reviewer {\n}");
    expect(created.source).toContain("// keep this project note");
    expect(created.diff).toContain("+++ b/main.ag");
    expect(buildGraph(parse(created.source), "main.ag")).toBeTruthy();

    const deleted = applyFlowStructuralPatch("main.ag", created.source, { op: "delete_agent", nodeId: "agent:Reviewer" });
    expect(deleted.source).toBe(SOURCE);

    const referenced = SOURCE + "spawn Worker worker;\n";
    expect(() => applyFlowStructuralPatch("main.ag", referenced, { op: "delete_agent", nodeId: "agent:Worker" }))
      .toThrowError(FlowStructuralEditError);
  });

  it("adds, removes, reconnects, and reorders only whole typed handoff statements", () => {
    const added = applyFlowStructuralPatch("main.ag", SOURCE, {
      op: "add_handoff", contextNodeId: "agent:Worker", handoff: "action", target: "Audit",
    });
    expect(added.source).toContain("perform Audit();");

    const reconnected = applyFlowStructuralPatch("main.ag", SOURCE, {
      op: "reconnect_handoff", nodeId: "event:Worker:Ping", target: "Pong",
    });
    expect(reconnected.source).toContain("emit Pong(); // keep this comment");
    expect(reconnected.source).not.toContain("emit Ping()");

    expect(() => applyFlowStructuralPatch("main.ag", SOURCE, {
      op: "reconnect_handoff", nodeId: "event:Worker:Ping", target: "Typed",
    })).toThrowError(FlowStructuralEditError);

    const reordered = applyFlowStructuralPatch("main.ag", SOURCE, {
      op: "reorder_step", nodeId: "event:Worker:Pong", beforeNodeId: "event:Worker:Ping",
    });
    expect(reordered.source.indexOf("emit Pong();")).toBeLessThan(reordered.source.indexOf("emit Ping();"));
    expect(reordered.source).toContain("emit Ping(); // keep this comment");

    const removed = applyFlowStructuralPatch("main.ag", SOURCE, { op: "remove_handoff", nodeId: "event:Worker:Pong" });
    expect(removed.source).not.toContain("emit Pong();");
    expect(removed.source).toContain("emit Ping(); // keep this comment");
  });

  it("rejects reorder across handlers, branches, and retry blocks", () => {
    const crossHandler = `event Ping(); event Pong(); agent Worker { on awake { emit Ping(); } when (Ping e) { emit Pong(); } }`;
    expect(() => applyFlowStructuralPatch("handlers.ag", crossHandler, {
      op: "reorder_step", nodeId: "event:Worker:Pong", beforeNodeId: "event:Worker:Ping",
    })).toThrowError(FlowStructuralEditError);

    const crossBranch = `event Ping(); event Pong(); agent Worker { on awake { if (true) { emit Ping(); } else { emit Pong(); } } }`;
    try {
      applyFlowStructuralPatch("branches.ag", crossBranch, {
        op: "reorder_step", nodeId: "event:Worker:Pong", beforeNodeId: "event:Worker:Ping",
      });
      throw new Error("expected cross-branch rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(FlowStructuralEditError);
      expect((error as FlowStructuralEditError).diagnostics[0]?.code).toBe("cross_context_reorder");
    }

    const retryBoundary = `event Ping(); event Pong(); agent Worker { on awake { { emit Ping(); } retry(2) emit Pong(); } }`;
    try {
      applyFlowStructuralPatch("retry.ag", retryBoundary, {
        op: "reorder_step", nodeId: "event:Worker:Ping", beforeNodeId: "event:Worker:Pong",
      });
      throw new Error("expected retry-boundary rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(FlowStructuralEditError);
      expect((error as FlowStructuralEditError).diagnostics[0]?.code).toBe("cross_context_reorder");
    }
  });

  it("truthfully reports unsupported argument synthesis and source capabilities", () => {
    expect(structuralCapabilities(SOURCE)).toEqual({ createNodes: true, deleteNodes: true, connectNodes: true, reorderSteps: true });
    expect(() => applyFlowStructuralPatch("main.ag", SOURCE, {
      op: "add_handoff", contextNodeId: null, handoff: "event", target: "Ping",
    } as any)).toThrowError(FlowStructuralEditError);
    expect(() => applyFlowStructuralPatch("main.ag", SOURCE, { op: "delete_agent", nodeId: "agent:Worker", surprise: true } as any)).toThrowError(FlowStructuralEditError);
    expect(() => applyFlowStructuralPatch("main.ag", SOURCE, {
      op: "add_handoff", contextNodeId: "agent:Worker", handoff: "event", target: "Typed",
    })).toThrowError(FlowStructuralEditError);
  });

  it("adds only messages wired through a typed instance constructor binding", () => {
    const source = `
      agent Reviewer {}
      agent Sender(Reviewer reviewer) grants { reach Reviewer } {}
      spawn Reviewer reviewer;
      spawn Sender sender(reviewer);
    `;
    const added = applyFlowStructuralPatch("messages.ag", source, {
      op: "add_handoff", contextNodeId: "instance:sender", handoff: "message", target: "reviewer", message: "review this",
    });
    expect(added.source).toContain('reviewer <- "review this";');

    const unresolved = `
      agent Reviewer {}
      agent Sender grants { reach Reviewer } {}
      spawn Reviewer reviewer;
      spawn Sender sender;
    `;
    try {
      applyFlowStructuralPatch("messages.ag", unresolved, {
        op: "add_handoff", contextNodeId: "instance:sender", handoff: "message", target: "reviewer", message: "review this",
      });
      throw new Error("expected unwired message rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(FlowStructuralEditError);
      expect((error as FlowStructuralEditError).diagnostics[0]?.code).toBe("unsupported_message_target_binding");
    }
  });
});
