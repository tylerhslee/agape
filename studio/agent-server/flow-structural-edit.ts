import { check } from "../../agape-ts/src/check.ts";
import { buildGraph, type ProgramGraph } from "../../agape-ts/src/graph.ts";
import { parse } from "../../agape-ts/src/parser.ts";
import type * as A from "../../agape-ts/src/ast.ts";

export type FlowStructuralPatch =
  | { op: "create_agent"; name: string }
  | { op: "delete_agent"; nodeId: string }
  | { op: "add_handoff"; contextNodeId: string; handoff: "event" | "action" | "message"; target: string; message?: string }
  | { op: "remove_handoff"; nodeId: string }
  | { op: "reconnect_handoff"; nodeId: string; target: string }
  | { op: "reorder_step"; nodeId: string; beforeNodeId: string | null };

export type StructuralDiagnostic = { severity: "error"; code: string; message: string; nodeId?: string };

export class FlowStructuralEditError extends Error {
  constructor(readonly diagnostics: StructuralDiagnostic[]) {
    super("invalid structural flow edit");
  }
}

export type StructuralCapabilities = {
  createNodes: boolean;
  deleteNodes: boolean;
  connectNodes: boolean;
  reorderSteps: boolean;
};

type Token = { value: string; start: number; end: number; line: number; column: number; string?: boolean };
type AgentSpan = { name: string; nodeId: string; start: number; bodyOpen: number; bodyClose: number; end: number };
type Step = { nodeId: string; kind: "event" | "action" | "message" | "output"; name: string; start: number; end: number; nameStart: number; nameEnd: number; owner?: string; blockStart: number };
type SourceIndex = { tokens: Token[]; agents: AgentSpan[]; steps: Step[]; program: A.Program };

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function deletableAgentNodeIds(source: string): Set<string> {
  try {
    const index = indexSource(source);
    return new Set(index.agents.filter((agent) => dependencySafeAgent(index, source, agent)).map((agent) => agent.nodeId));
  } catch {
    return new Set();
  }
}

export function structuralCapabilities(source: string): StructuralCapabilities {
  try {
    const index = indexSource(source);
    const deletable = deletableAgentNodeIds(source).size > 0;
    const handoffDecls = index.program.decls.some((decl) => (decl.kind === "event" || decl.kind === "action") && decl.fields.length === 0);
    const reorderable = index.steps.some((step, i) => index.steps.slice(i + 1).some((other) => step.owner === other.owner));
    return { createNodes: true, deleteNodes: deletable, connectNodes: handoffDecls || index.steps.some((step) => step.kind !== "output"), reorderSteps: reorderable };
  } catch {
    return { createNodes: false, deleteNodes: false, connectNodes: false, reorderSteps: false };
  }
}

export function applyFlowStructuralPatch(rel: string, source: string, patch: FlowStructuralPatch): { source: string; diff: string } {
  validatePatchShape(patch);
  const index = indexSource(source);
  let candidate: string;
  switch (patch.op) {
    case "create_agent": candidate = createAgent(source, index, patch.name); break;
    case "delete_agent": candidate = deleteAgent(source, index, patch.nodeId); break;
    case "add_handoff": candidate = addHandoff(source, index, patch); break;
    case "remove_handoff": candidate = removeHandoff(source, index, patch.nodeId); break;
    case "reconnect_handoff": candidate = reconnectHandoff(source, index, patch.nodeId, patch.target); break;
    case "reorder_step": candidate = reorderStep(source, index, patch.nodeId, patch.beforeNodeId); break;
    default: return fail("unsupported_structural_patch", `Unsupported structural operation '${String((patch as any).op)}'.`);
  }
  if (candidate === source) fail("no_structural_change", "The structural patch did not change the source.");
  let program: A.Program;
  try {
    program = parse(candidate);
    check(program);
  } catch (error: any) {
    fail("structural_check_failed", String(error?.message || error).slice(0, 4000));
  }
  if ((patch.op === "add_handoff" && patch.handoff === "message") || (patch.op === "reconnect_handoff" && index.steps.find((step) => step.nodeId === patch.nodeId)?.kind === "message")) {
    if (introducesUnresolvedMessage(index.program, program!)) fail("unresolved_message_target", "The message destination is not a statically resolved agent instance or binding.");
  }
  if ((patch.op === "add_handoff" || patch.op === "reconnect_handoff") && introducesCausalCycle(index.program, program!)) {
    fail("structural_cycle", "The connection would introduce a new event/message cycle. Add an explicit bounded mediator in Code view instead.");
  }
  return { source: candidate, diff: unifiedDiff(rel, source, candidate) };
}

function validatePatchShape(patch: FlowStructuralPatch): void {
  if (!patch || typeof patch !== "object" || typeof (patch as any).op !== "string") {
    fail("invalid_structural_patch", "A single explicit structural patch is required.");
  }
  const value = patch as any;
  const text = (key: string) => typeof value[key] === "string";
  let valid = false;
  switch (value.op) {
    case "create_agent": valid = text("name"); break;
    case "delete_agent": valid = text("nodeId"); break;
    case "add_handoff":
      valid = text("contextNodeId") && ["event", "action", "message"].includes(value.handoff) && text("target")
        && (value.message === undefined || typeof value.message === "string");
      break;
    case "remove_handoff": valid = text("nodeId"); break;
    case "reconnect_handoff": valid = text("nodeId") && text("target"); break;
    case "reorder_step": valid = text("nodeId") && (value.beforeNodeId === null || typeof value.beforeNodeId === "string"); break;
    default: fail("unsupported_structural_patch", `Unsupported structural operation '${String(value.op)}'.`);
  }
  if (!valid) fail("invalid_structural_patch", `Structural operation '${value.op}' has invalid or missing fields.`);
  const allowed: Record<string, string[]> = {
    create_agent: ["op", "name"], delete_agent: ["op", "nodeId"],
    add_handoff: ["op", "contextNodeId", "handoff", "target", "message"],
    remove_handoff: ["op", "nodeId"], reconnect_handoff: ["op", "nodeId", "target"],
    reorder_step: ["op", "nodeId", "beforeNodeId"],
  };
  const extras = Object.keys(value).filter((key) => !allowed[value.op].includes(key));
  if (extras.length) fail("invalid_structural_patch", `Structural operation '${value.op}' contains unsupported fields: ${extras.join(", ")}.`);
}

function createAgent(source: string, index: SourceIndex, name: string): string {
  if (typeof name !== "string" || !NAME.test(name)) fail("invalid_agent_name", "Agent names must be Agape identifiers.");
  if (index.program.decls.some((decl) => "name" in decl && decl.name === name)) fail("duplicate_declaration", `A declaration named '${name}' already exists.`);
  const firstStatement = index.program.stmts[0];
  const insertion = firstStatement ? offsetAt(source, firstStatement.pos.line, firstStatement.pos.col) : source.length;
  const prefix = insertion > 0 && source[insertion - 1] !== "\n" ? "\n" : "";
  const suffix = insertion < source.length && source[insertion] !== "\n" ? "\n" : "";
  return source.slice(0, insertion) + `${prefix}agent ${name} {\n}\n${suffix}` + source.slice(insertion);
}

function deleteAgent(source: string, index: SourceIndex, nodeId: string): string {
  const agent = index.agents.find((item) => item.nodeId === nodeId);
  if (!agent) fail("unsupported_agent_delete", "Only source-backed agent definitions can be deleted structurally.", nodeId);
  if (!dependencySafeAgent(index, source, agent!)) fail("agent_has_dependencies", `Agent '${agent!.name}' is still referenced; delete or reconnect those dependencies first.`, nodeId);
  let start = agent!.start;
  let end = agent!.end;
  while (end < source.length && (source[end] === " " || source[end] === "\t")) end++;
  if (source[end] === "\r") end++;
  if (source[end] === "\n") end++;
  if (start > 0 && source[start - 1] === "\n" && source[end] === "\n") end++;
  return source.slice(0, start) + source.slice(end);
}

function addHandoff(source: string, index: SourceIndex, patch: Extract<FlowStructuralPatch, { op: "add_handoff" }>): string {
  const { ownerName, owner, instanceName } = resolveHandoffContext(index, patch.contextNodeId);
  if (!owner) fail("unsupported_handoff_context", "New handoffs can only be dropped on a source-backed agent body. Handler-specific insertion remains Code-only.", patch.contextNodeId);
  assertHandoffAuthority(index.program, ownerName, patch.handoff, patch.target);
  let statement: string;
  if (patch.handoff === "event" || patch.handoff === "action") {
    const decl = index.program.decls.find((item): item is A.EventDecl | A.ActionDecl => item.kind === patch.handoff && item.name === patch.target);
    if (!decl) fail("unknown_handoff_target", `No ${patch.handoff} declaration named '${patch.target}' exists.`);
    if (decl!.fields.length !== 0) fail("unsupported_handoff_arguments", "Drag-to-add supports only zero-argument declarations; construct typed arguments in Code view.");
    statement = `${patch.handoff === "event" ? "emit" : "perform"} ${patch.target}();`;
  } else {
    if (!NAME.test(patch.target)) fail("invalid_handoff_target", "A message target must be an identifier.");
    if (typeof patch.message !== "string") fail("unsupported_message_payload", "A drag-added message requires an explicit text payload.");
    let destination = patch.target;
    if (instanceName) {
      const ownerSpawn = index.program.stmts.find((stmt): stmt is A.SpawnStmt => stmt.kind === "spawn" && stmt.name === instanceName);
      const ownerDecl = index.program.decls.find((decl): decl is A.AgentDecl => decl.kind === "agent" && decl.name === ownerName);
      const parameter = ownerDecl?.params.find((_, position) => {
        const argument = ownerSpawn?.args[position];
        return argument?.kind === "ident" && argument.name === patch.target;
      });
      if (!parameter) fail("unsupported_message_target_binding", "The dropped agent is not wired through a constructor parameter of this source instance; Studio will not invent an unresolved global send.");
      destination = parameter.name;
    }
    statement = `${destination} <- ${JSON.stringify(patch.message)};`;
  }
  const insertion = owner!.bodyClose;
  const indent = indentationAt(source, owner!.bodyOpen) + "  ";
  const needsLeadingNewline = source.slice(owner!.bodyOpen + 1, insertion).trim().length === 0 ? "\n" : (source[insertion - 1] === "\n" ? "" : "\n");
  return source.slice(0, insertion) + `${needsLeadingNewline}${indent}${statement}\n${indent.slice(0, -2)}` + source.slice(insertion);
}

function removeHandoff(source: string, index: SourceIndex, nodeId: string): string {
  const step = index.steps.find((item) => item.nodeId === nodeId && item.kind !== "output");
  if (!step) fail("unsupported_handoff_remove", "Only source-backed emit, perform, and message statements can be removed structurally.", nodeId);
  return source.slice(0, step!.start) + source.slice(step!.end);
}

function reconnectHandoff(source: string, index: SourceIndex, nodeId: string, target: string): string {
  const step = index.steps.find((item) => item.nodeId === nodeId && item.kind !== "output");
  if (!step) fail("unsupported_handoff_reconnect", "Only source-backed emit, perform, and message statements can be reconnected structurally.", nodeId);
  if (!NAME.test(target)) fail("invalid_handoff_target", "A handoff target must be an Agape identifier.", nodeId);
  if (step!.owner) assertHandoffAuthority(index.program, step!.owner!, step!.kind === "action" ? "action" : step!.kind === "message" ? "message" : "event", target);
  if (step!.kind === "event" || step!.kind === "action") {
    const current = index.program.decls.find((decl): decl is A.EventDecl | A.ActionDecl => decl.kind === step!.kind && decl.name === step!.name);
    const next = index.program.decls.find((decl): decl is A.EventDecl | A.ActionDecl => decl.kind === step!.kind && decl.name === target);
    if (!current || !next) fail("unknown_handoff_target", `No compatible ${step!.kind} declaration named '${target}' exists.`, nodeId);
    if (signature(current!.fields) !== signature(next!.fields)) fail("incompatible_handoff_type", `The '${target}' signature does not match '${step!.name}'.`, nodeId);
  }
  return source.slice(0, step!.nameStart) + target + source.slice(step!.nameEnd);
}

function reorderStep(source: string, index: SourceIndex, nodeId: string, beforeNodeId: string | null): string {
  const step = index.steps.find((item) => item.nodeId === nodeId);
  const before = beforeNodeId === null ? undefined : index.steps.find((item) => item.nodeId === beforeNodeId);
  if (!step || (beforeNodeId !== null && !before)) fail("unsupported_step_reorder", "Both reorder endpoints must be source-backed whole statements.", nodeId);
  if (before && before.nodeId === step!.nodeId) fail("no_structural_change", "A step cannot be moved before itself.", nodeId);
  if (before && before.blockStart !== step!.blockStart) fail("cross_context_reorder", "Steps can only be reordered inside the same lexical statement block.", nodeId);
  if (!before && !step!.owner) fail("unsupported_step_reorder", "Appending a top-level step is not available from this flow surface.", nodeId);
  if (!before && index.agents.find((agent) => agent.name === step!.owner)?.bodyOpen !== step!.blockStart) fail("cross_context_reorder", "A nested step cannot be moved out of its lexical statement block.", nodeId);
  const text = source.slice(step!.start, step!.end);
  const without = source.slice(0, step!.start) + source.slice(step!.end);
  let insertion: number;
  if (before) insertion = before.start - (before.start > step!.start ? step!.end - step!.start : 0);
  else {
    const owner = index.agents.find((agent) => agent.name === step!.owner)!;
    insertion = owner.bodyClose - (owner.bodyClose > step!.start ? step!.end - step!.start : 0);
  }
  return without.slice(0, insertion) + text + without.slice(insertion);
}

function indexSource(source: string): SourceIndex {
  let program: A.Program;
  try { program = parse(source); check(program); }
  catch (error: any) { return fail("unsupported_source", String(error?.message || error).slice(0, 4000)); }
  const tokens = scan(source);
  const bracePairs = pairs(tokens, "{", "}");
  const agents: AgentSpan[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].value !== "agent" || !NAME.test(tokens[i + 1]?.value || "")) continue;
    let open = i + 2;
    while (open < tokens.length && tokens[open].value !== "{") open++;
    if (tokens.slice(i + 2, open).some((token) => token.value === "grants")) {
      open = (bracePairs.get(open) ?? open) + 1;
      while (open < tokens.length && tokens[open].value !== "{") open++;
    }
    const close = bracePairs.get(open);
    if (close === undefined) continue;
    agents.push({ name: tokens[i + 1].value, nodeId: `agent:${tokens[i + 1].value}`, start: tokens[i].start, bodyOpen: tokens[open].start, bodyClose: tokens[close].start, end: tokens[close].end });
  }
  const memoryNames = programMemoryNames(program);
  const ownerAt = (offset: number) => agents.find((agent) => offset > agent.bodyOpen && offset < agent.bodyClose)?.name;
  const blockAt = (offset: number) => [...bracePairs.entries()]
    .filter(([open, close]) => tokens[open].start < offset && offset < tokens[close].end)
    .sort((left, right) => tokens[right[0]].start - tokens[left[0]].start)[0]?.[0];
  const localMemories = tokens.flatMap((token, position) => {
    if (token.value !== "mem" || !NAME.test(tokens[position + 1]?.value || "") || tokens[position + 2]?.value === "{") return [];
    const open = blockAt(token.start);
    const close = open === undefined ? undefined : bracePairs.get(open);
    return open === undefined || close === undefined ? [] : [{
      name: tokens[position + 1].value,
      declaration: token.start,
      blockStart: tokens[open].start,
      blockEnd: tokens[close].end,
    }];
  });
  const steps: Step[] = [];
  const counts = new Map<string, number>();
  const unique = (base: string) => { const n = (counts.get(base) || 0) + 1; counts.set(base, n); return n === 1 ? base : `${base}:${n}`; };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const owner = ownerAt(token.start) || "module";
    if ((token.value === "emit" || token.value === "perform") && NAME.test(tokens[i + 1]?.value || "") && tokens[i + 2]?.value === "(") {
      const kind = token.value === "emit" ? "event" : "action";
      const end = statementEnd(tokens, i);
      const name = tokens[i + 1];
      steps.push({ nodeId: unique(`${kind}:${owner}:${name.value}`), kind, name: name.value, start: lineStart(source, token.start), end: statementTrailingEnd(source, tokens[end]?.end ?? name.end), nameStart: name.start, nameEnd: name.end, owner: owner === "module" ? undefined : owner, blockStart: tokens[blockAt(token.start)!]?.start ?? -1 });
    }
    if (token.value === "say" && tokens[i + 1]?.value === "(") {
      const end = statementEnd(tokens, i);
      steps.push({ nodeId: unique(`output:${owner}:say`), kind: "output", name: "say", start: lineStart(source, token.start), end: statementTrailingEnd(source, tokens[end]?.end ?? token.end), nameStart: token.start, nameEnd: token.end, owner: owner === "module" ? undefined : owner, blockStart: tokens[blockAt(token.start)!]?.start ?? -1 });
    }
    if (token.value === "<-" && tokens[i - 1]?.value !== "self") {
      const destination = tokens[i - 1];
      if (!destination || !NAME.test(destination.value)) continue;
      const localMemory = localMemories.some((memory) => memory.name === destination.value
        && memory.declaration < token.start && memory.blockStart < token.start && token.start < memory.blockEnd);
      if (memoryNames.get(owner)?.has(destination.value) || localMemory) continue;
      const end = statementEnd(tokens, i);
      const startToken = statementStart(tokens, i);
      const binding = bindingName(tokens, startToken, i);
      steps.push({ nodeId: unique(`message:${owner}:${binding || destination.value}`), kind: "message", name: destination.value, start: lineStart(source, tokens[startToken].start), end: statementTrailingEnd(source, tokens[end]?.end ?? token.end), nameStart: destination.start, nameEnd: destination.end, owner: owner === "module" ? undefined : owner, blockStart: tokens[blockAt(token.start)!]?.start ?? -1 });
    }
  }
  return { tokens, agents, steps, program };
}

function dependencySafeAgent(index: SourceIndex, source: string, agent: AgentSpan): boolean {
  const outside = source.slice(0, agent.start) + source.slice(agent.end);
  return !new RegExp(`\\b${escapeRegExp(agent.name)}\\b`).test(outside);
}

function resolveHandoffContext(index: SourceIndex, contextNodeId: string): { ownerName: string; owner?: AgentSpan; instanceName?: string } {
  if (contextNodeId.startsWith("instance:")) {
    const instanceName = contextNodeId.slice("instance:".length);
    const spawn = index.program.stmts.find((stmt): stmt is A.SpawnStmt => stmt.kind === "spawn" && stmt.name === instanceName);
    const ownerName = spawn?.agentType || "";
    return { ownerName, owner: index.agents.find((agent) => agent.name === ownerName), instanceName };
  }
  const ownerName = contextNodeId.startsWith("agent:") ? contextNodeId.slice("agent:".length) : "";
  return { ownerName, owner: index.agents.find((agent) => agent.name === ownerName) };
}

function programMemoryNames(program: A.Program): Map<string, Set<string>> {
  const names = new Map<string, Set<string>>();
  const add = (owner: string, name: string) => { const set = names.get(owner) || new Set<string>(); set.add(name); names.set(owner, set); };
  const agents = new Map(program.decls.filter((decl): decl is A.AgentDecl => decl.kind === "agent").map((agent) => [agent.name, agent]));
  const collect = (agent: A.AgentDecl, seen = new Set<string>()): Set<string> => {
    if (seen.has(agent.name)) return new Set();
    const next = new Set(seen); next.add(agent.name);
    const inherited = agent.extends ? agents.get(agent.extends.name) : undefined;
    const result = inherited ? collect(inherited, next) : new Set<string>();
    agent.mems.forEach((memory) => result.add(memory.name));
    return result;
  };
  for (const agent of agents.values()) for (const name of collect(agent)) add(agent.name, name);
  return names;
}

function assertHandoffAuthority(program: A.Program, ownerName: string, handoff: "event" | "action" | "message", target: string): void {
  if (handoff === "event") return;
  const agent = program.decls.find((decl): decl is A.AgentDecl => decl.kind === "agent" && decl.name === ownerName);
  if (!agent) fail("unsupported_handoff_context", `Agent '${ownerName}' is not source-backed.`);
  if (agent!.grants === "all") return;
  const capability = handoff === "action" ? "perform" : "reach";
  let authorityTarget = target;
  if (handoff === "message") {
    const spawn = program.stmts.find((stmt): stmt is A.SpawnStmt => stmt.kind === "spawn" && stmt.name === target);
    if (spawn) authorityTarget = spawn.agentType;
    else {
      const parameter = agent!.params.find((field) => field.name === target);
      if (parameter?.type.kind === "named") authorityTarget = parameter.type.name;
    }
  }
  if (!agent!.grants.some((grant) => grant.cap === capability && grant.name === authorityTarget)) {
    fail(
      "structural_authority",
      `Agent '${ownerName}' has no declared '${capability} ${authorityTarget}' authority for this ${handoff} handoff. Update grants explicitly in Code view.`,
    );
  }
}

function signature(fields: A.Field[]): string { return fields.map((field) => typeLabel(field.type)).join(","); }
function typeLabel(type: A.TypeRef): string {
  if (type.kind === "scalar" || type.kind === "named") return type.name + (type.kind === "named" && type.typeArgs?.length ? `<${type.typeArgs.map(typeLabel).join(",")}>` : "");
  if (type.kind === "array" || type.kind === "event" || type.kind === "task") return `${type.kind}<${typeLabel(type.inner)}>`;
  if (type.kind === "credence" || type.kind === "decision") return `${type.kind}<${type.enumName}>`;
  if (type.kind === "endorsement") return `Endorsement<${typeLabel(type.inner)}>`;
  return "mem";
}

function introducesCausalCycle(before: A.Program, after: A.Program): boolean {
  const oldCycles = cycleKeys(buildGraph(before));
  return [...cycleKeys(buildGraph(after))].some((key) => !oldCycles.has(key));
}

function introducesUnresolvedMessage(before: A.Program, after: A.Program): boolean {
  const count = (program: A.Program) => buildGraph(program).edges.filter(
    (edge) => edge.kind === "send" && edge.resolved === false,
  ).length;
  return count(after) > count(before);
}

function cycleKeys(graph: ProgramGraph): Set<string> {
  const adjacency = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.kind !== "event" && edge.kind !== "send") continue;
    const list = adjacency.get(edge.from) || [];
    list.push(edge.to); adjacency.set(edge.from, list);
  }
  const keys = new Set<string>();
  const visit = (start: string, node: string, seen: string[]) => {
    for (const next of adjacency.get(node) || []) {
      if (next === start) keys.add([...seen, node, start].sort().join("|"));
      else if (!seen.includes(next) && seen.length < graph.nodes.length) visit(start, next, [...seen, node]);
    }
  };
  for (const node of adjacency.keys()) visit(node, node, []);
  return keys;
}

function unifiedDiff(rel: string, before: string, after: string): string {
  const a = before.split("\n"), b = after.split("\n");
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  const contextStart = Math.max(0, prefix - 2);
  const oldEnd = a.length - suffix, newEnd = b.length - suffix;
  const lines = [`--- a/${rel}`, `+++ b/${rel}`, `@@ -${contextStart + 1},${oldEnd - contextStart} +${contextStart + 1},${newEnd - contextStart} @@`];
  for (let i = contextStart; i < prefix; i++) lines.push(` ${a[i]}`);
  for (let i = prefix; i < oldEnd; i++) lines.push(`-${a[i]}`);
  for (let i = prefix; i < newEnd; i++) lines.push(`+${b[i]}`);
  return lines.join("\n");
}

function scan(source: string): Token[] {
  const out: Token[] = [];
  let i = 0, line = 1, column = 1;
  const advance = () => { if (source[i] === "\n") { line++; column = 1; } else column++; i++; };
  while (i < source.length) {
    if (/\s/.test(source[i])) { advance(); continue; }
    if (source[i] === "/" && source[i + 1] === "/") { while (i < source.length && source[i] !== "\n") advance(); continue; }
    const start = i, tokenLine = line, tokenColumn = column;
    if ((source[i] === "f" && source[i + 1] === '"') || source[i] === '"') {
      if (source[i] === "f") advance(); advance();
      while (i < source.length && source[i] !== '"') { if (source[i] === "\\") { advance(); if (i < source.length) advance(); } else advance(); }
      if (i >= source.length) fail("unsupported_source", `Unterminated string at ${tokenLine}:${tokenColumn}.`);
      advance(); out.push({ value: "string", start, end: i, line: tokenLine, column: tokenColumn, string: true }); continue;
    }
    if (/[A-Za-z_]/.test(source[i])) { while (i < source.length && /[A-Za-z0-9_]/.test(source[i])) advance(); out.push({ value: source.slice(start, i), start, end: i, line: tokenLine, column: tokenColumn }); continue; }
    if (/\d/.test(source[i])) { while (i < source.length && /\d/.test(source[i])) advance(); if (source[i] === ".") { advance(); while (i < source.length && /\d/.test(source[i])) advance(); } out.push({ value: source.slice(start, i), start, end: i, line: tokenLine, column: tokenColumn }); continue; }
    const op = ["<-", "->", "|>", ">=", "<=", "==", "!=", "&&", "||"].find((value) => source.startsWith(value, i));
    if (op) { for (let n = 0; n < op.length; n++) advance(); out.push({ value: op, start, end: i, line: tokenLine, column: tokenColumn }); continue; }
    advance(); out.push({ value: source.slice(start, i), start, end: i, line: tokenLine, column: tokenColumn });
  }
  return out;
}

function pairs(tokens: Token[], open: string, close: string): Map<number, number> { const stack: number[] = [], result = new Map<number, number>(); tokens.forEach((token, i) => { if (token.value === open) stack.push(i); else if (token.value === close) { const start = stack.pop(); if (start !== undefined) result.set(start, i); } }); return result; }
function statementEnd(tokens: Token[], start: number): number { let p = 0, b = 0, a = 0; for (let i = start; i < tokens.length; i++) { const v = tokens[i].value; if (v === "(") p++; else if (v === ")") p--; else if (v === "{") b++; else if (v === "}") b--; else if (v === "[") a++; else if (v === "]") a--; if (v === ";" && p === 0 && b === 0 && a === 0) return i; } return tokens.length - 1; }
function statementStart(tokens: Token[], at: number): number { let i = at; while (i > 0 && ![";", "{", "}"].includes(tokens[i - 1].value)) i--; return i; }
function bindingName(tokens: Token[], start: number, end: number): string { for (let i = start; i < end; i++) if (tokens[i].value === "=" && NAME.test(tokens[i - 1]?.value || "")) return tokens[i - 1].value; return ""; }
function lineStart(source: string, offset: number): number { const start = source.lastIndexOf("\n", offset - 1) + 1; return source.slice(start, offset).trim() ? offset : start; }
function statementTrailingEnd(source: string, offset: number): number { let end = offset; while (source[end] === " " || source[end] === "\t") end++; if (source[end] === "\r") end++; if (source[end] === "\n") end++; return end; }
function indentationAt(source: string, offset: number): string { const start = source.lastIndexOf("\n", offset - 1) + 1; return source.slice(start, offset).match(/^\s*/)?.[0] || ""; }
function offsetAt(source: string, line: number, col: number): number { let offset = 0; for (let current = 1; current < line; current++) { const next = source.indexOf("\n", offset); if (next < 0) return source.length; offset = next + 1; } return Math.min(source.length, offset + Math.max(0, col - 1)); }
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function fail(code: string, message: string, nodeId?: string): never { throw new FlowStructuralEditError([{ severity: "error", code, message, ...(nodeId ? { nodeId } : {}) }]); }
