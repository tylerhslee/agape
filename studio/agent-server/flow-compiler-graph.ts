import type { CompilerGraphLike, FlowDocument, FlowField, FlowNode } from "./flow-model.ts";

const editableKindMap: Record<string, FlowNode["kind"]> = {
  ask: "model",
  gate: "decision",
  sink: "action",
  emit: "event",
  prompt: "prompt",
  tool: "tool",
};

const compilerKindMap: Record<string, FlowNode["kind"]> = {
  top: "program",
  agent: "agent",
  fn: "function",
  handler: "handler",
  hook: "hook",
  principal: "principal",
  mem: "memory",
  ledger: "ledger",
  tool: "tool",
  event: "event",
  ask: "model",
  gate: "decision",
  sink: "action",
  emit: "event",
  prompt: "prompt",
};

export function applyCompilerGraphToDocument(document: FlowDocument, graph: CompilerGraphLike): void {
  const compilerToFlow = new Map<string, string>();
  const usedFlowIds = new Set(document.nodes.map((node) => node.id));

  // Source-backed editable sites retain their stable lexical IDs. A compiler
  // node maps only when kind + line identifies exactly one unused candidate.
  for (const compilerNode of graph.nodes) {
    const flowKind = editableKindMap[compilerNode.kind];
    if (!flowKind) continue;
    const candidates = document.nodes.filter((node) =>
      node.kind === flowKind &&
      node.source.line === compilerNode.line &&
      !node.metadata?.compilerNodeId,
    );
    if (candidates.length !== 1) continue;
    const node = candidates[0];
    node.metadata = { ...node.metadata, ...compilerMetadata(compilerNode), compilerMeta: { ...(node.metadata?.compilerMeta || {}), ...(compilerNode.meta || {}) } };
    compilerToFlow.set(compilerNode.id, node.id);
  }

  // Everything else in the compiler graph is still semantic topology. Keep it
  // visible as a read-only context node instead of dropping its incident edges.
  let synthesized = 0;
  for (const compilerNode of graph.nodes) {
    if (compilerToFlow.has(compilerNode.id)) continue;
    const id = uniqueId(`compiler:${compilerNode.id}`, usedFlowIds);
    const fields: FlowField[] = [readOnlyField("compilerKind", "Compiler kind", compilerNode.kind)];
    if (compilerNode.parent) fields.push(readOnlyField("parent", "Compiler parent", compilerNode.parent));
    if (compilerNode.meta && Object.keys(compilerNode.meta).length) {
      fields.push(readOnlyField("details", "Compiler metadata", JSON.stringify(compilerNode.meta)));
    }
    document.nodes.push({
      id,
      kind: compilerKindMap[compilerNode.kind] || "program",
      label: compilerNode.label,
      readOnly: true,
      readOnlyReason: "Compiler-derived topology context; edit the corresponding Agape source in Code view.",
      position: { x: 1040 + (synthesized % 2) * 300, y: 60 + Math.floor(synthesized / 2) * 150 },
      source: { line: compilerNode.line || 1, column: 1 },
      fields,
      metadata: compilerMetadata(compilerNode),
    });
    compilerToFlow.set(compilerNode.id, id);
    synthesized++;
  }

  // The compiler's prompt->handler edge supersedes the lexical prompt->agent
  // approximation whenever compiler topology is available.
  document.edges = document.edges.filter((edge) => edge.kind !== "subscription");

  for (const compilerEdge of graph.edges) {
    const source = compilerToFlow.get(compilerEdge.from);
    const target = compilerToFlow.get(compilerEdge.to);
    if (source && target) {
      document.edges.push({
        id: `compiler:${compilerEdge.id}`,
        source,
        target,
        label: compilerEdge.label || compilerEdge.variant || compilerEdge.kind,
        kind: `compiler:${compilerEdge.kind}`,
        readOnly: true,
      });
    } else {
      document.diagnostics.push({
        severity: "warning",
        code: "missing_compiler_endpoint",
        message: `Compiler edge ${compilerEdge.kind} references a node absent from the compiler graph (${compilerEdge.from} -> ${compilerEdge.to}); no visual edge was invented.`,
        ...(source ? { nodeId: source } : target ? { nodeId: target } : {}),
      });
    }
    if (compilerEdge.resolved === false) {
      document.diagnostics.push({
        severity: "warning",
        code: "unresolved_compiler_edge",
        message: `Compiler graph edge ${compilerEdge.kind} (${compilerEdge.from} -> ${compilerEdge.to}) remains dynamic or unresolved.`,
        ...(source ? { nodeId: source } : target ? { nodeId: target } : {}),
      });
    }
  }
}

function compilerMetadata(node: CompilerGraphLike["nodes"][number]): NonNullable<FlowNode["metadata"]> {
  return {
    compilerNodeId: node.id,
    compilerKind: node.kind,
    ...(node.context?.id ? { contextId: node.context.id } : {}),
    ...(node.context?.kind ? { contextKind: node.context.kind } : {}),
    ...(node.parent ? { parentCompilerId: node.parent } : {}),
    ...(node.meta ? { compilerMeta: node.meta } : {}),
  };
}

function readOnlyField(key: string, label: string, value: string): FlowField {
  return { key, label, type: "text", value, readOnly: true };
}

function uniqueId(base: string, used: Set<string>): string {
  let id = base;
  let suffix = 2;
  while (used.has(id)) id = `${base}:${suffix++}`;
  used.add(id);
  return id;
}
