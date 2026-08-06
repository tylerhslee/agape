import { createHash } from "node:crypto";
import { applyCompilerGraphToDocument } from "./flow-compiler-graph.ts";
import { validateConfidence, validateLiteralInterpolations } from "./flow-model-safety.ts";

export type FlowDiagnostic = {
  severity: "error" | "warning";
  code: string;
  message: string;
  nodeId?: string;
  field?: string;
};

export type FlowField = {
  key: string;
  label: string;
  type: "text" | "multiline" | "number" | "select";
  value: string | number;
  options?: string[];
  readOnly: boolean;
  readOnlyReason?: string;
};

export type FlowNode = {
  id: string;
  kind: "prompt" | "agent" | "model" | "decision" | "endorsement" | "action" | "event" | "output" | "program" | "function" | "handler" | "hook" | "principal" | "memory" | "ledger" | "tool";
  label: string;
  readOnly: boolean;
  readOnlyReason?: string;
  position: { x: number; y: number };
  source: { line: number; column: number };
  fields: FlowField[];
  metadata?: { compilerNodeId?: string; compilerKind?: string; contextId?: string; contextKind?: string; parentCompilerId?: string; compilerMeta?: Record<string, unknown> };
};

export type FlowEdge = {
  id: string;
  source: string;
  target: string;
  label: string;
  kind: string;
  readOnly: true;
};

export type FlowDocument = {
  schemaVersion: 1;
  rel: string;
  revision: string;
  readOnly: boolean;
  readOnlyReason?: string;
  capabilities: { editProperties: boolean; createNodes: false; deleteNodes: false; connectNodes: false };
  diagnostics: FlowDiagnostic[];
  nodes: FlowNode[];
  edges: FlowEdge[];
};

type Token = { value: string; start: number; end: number; line: number; column: number; string?: "plain" | "format"; innerStart?: number; innerEnd?: number };
type Edit = { nodeId: string; field: string; start: number; end: number; encode: (value: unknown) => string; validate: (value: unknown) => string | null };
type Parsed = { document: FlowDocument; edits: Map<string, Edit> };

export type FlowChange = { nodeId: string; field: string; value: unknown };
export type CompilerGraphLike = {
  nodes: Array<{ id: string; kind: string; label: string; line: number; parent?: string; meta?: Record<string, unknown>; context?: { id?: string; kind?: string } }>;
  edges: Array<{ id: string; from: string; to: string; kind: string; label?: string; variant?: string; resolved?: boolean }>;
};

export class FlowEditError extends Error {
  constructor(public diagnostics: FlowDiagnostic[]) { super("invalid flow edit"); }
}

export function flowRevision(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

export function buildFlowDocument(rel: string, source: string, compilerGraph?: CompilerGraphLike): FlowDocument {
  const parsed = parseFlow(rel, source);
  if (compilerGraph) applyCompilerGraphToDocument(parsed.document, compilerGraph);
  return parsed.document;
}

export function applyFlowChanges(rel: string, source: string, changes: FlowChange[]): { source: string; document: FlowDocument } {
  const parsed = parseFlow(rel, source);
  const diagnostics: FlowDiagnostic[] = [];
  const replacements: Array<Edit & { replacement: string }> = [];
  if (!Array.isArray(changes) || changes.length === 0) {
    throw new FlowEditError([{ severity: "error", code: "empty_changes", message: "At least one flow property change is required." }]);
  }
  const seen = new Set<string>();
  for (const change of changes) {
    const key = `${change?.nodeId}:${change?.field}`;
    const edit = parsed.edits.get(key);
    if (!edit) {
      diagnostics.push({ severity: "error", code: "read_only_property", message: "This property is not safely editable from the flow view.", nodeId: String(change?.nodeId || ""), field: String(change?.field || "") });
      continue;
    }
    if (seen.has(key)) {
      diagnostics.push({ severity: "error", code: "duplicate_change", message: "A property may be changed only once per request.", nodeId: edit.nodeId, field: edit.field });
      continue;
    }
    seen.add(key);
    const message = edit.validate(change.value);
    if (message) diagnostics.push({ severity: "error", code: "invalid_value", message, nodeId: edit.nodeId, field: edit.field });
    else replacements.push({ ...edit, replacement: edit.encode(change.value) });
  }
  if (diagnostics.length) throw new FlowEditError(diagnostics);
  replacements.sort((a, b) => b.start - a.start);
  let next = source;
  for (const edit of replacements) next = next.slice(0, edit.start) + edit.replacement + next.slice(edit.end);
  return { source: next, document: buildFlowDocument(rel, next) };
}

function parseFlow(rel: string, source: string): Parsed {
  const diagnostics: FlowDiagnostic[] = [];
  let tokens: Token[];
  try { tokens = scan(source); }
  catch (error: any) {
    const message = error?.message || "Unable to scan Agape source.";
    return {
      edits: new Map(),
      document: { schemaVersion: 1, rel, revision: flowRevision(source), readOnly: true, readOnlyReason: message, capabilities: { editProperties: false, createNodes: false, deleteNodes: false, connectNodes: false }, diagnostics: [{ severity: "error", code: "unsupported_source", message }], nodes: [], edges: [] },
    };
  }

  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  const edits = new Map<string, Edit>();
  const counts = new Map<string, number>();
  const agents: Array<{ name: string; start: number; end: number; nodeId: string }> = [];
  const declarations = new Map<string, string>();

  const unique = (base: string) => {
    const n = (counts.get(base) || 0) + 1;
    counts.set(base, n);
    return n === 1 ? base : `${base}:${n}`;
  };
  const field = (key: string, label: string, type: FlowField["type"], value: string | number, readOnly: boolean, readOnlyReason?: string): FlowField => ({ key, label, type, value, readOnly, ...(readOnlyReason ? { readOnlyReason } : {}) });
  const addNode = (node: Omit<FlowNode, "position">, lane = 0) => {
    nodes.push({ ...node, position: { x: 80 + lane * 310, y: 60 + nodes.filter((n) => n.position.x === 80 + lane * 310).length * 170 } });
  };

  const braces = matching(tokens, "{", "}");
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].value !== "agent") continue;
    const nameTok = tokens[i + 1];
    if (!nameTok || !isName(nameTok.value)) continue;
    let open = i + 2;
    while (open < tokens.length && tokens[open].value !== "{") open++;
    if (tokens[open - 1]?.value === "grants" || tokens.slice(i + 2, open).some((t) => t.value === "grants")) {
      open = (braces.get(open) ?? open) + 1;
      while (open < tokens.length && tokens[open].value !== "{") open++;
    }
    const close = braces.get(open);
    if (close === undefined) continue;
    const id = unique(`agent:${nameTok.value}`);
    addNode({ id, kind: "agent", label: nameTok.value, readOnly: true, readOnlyReason: "Renaming agents requires a reference-aware refactor and is not available in flow editing yet.", source: { line: nameTok.line, column: nameTok.column }, fields: [field("name", "Agent", "text", nameTok.value, true, "Agent identifiers are read-only in the conservative editor.")] }, 1);
    agents.push({ name: nameTok.value, start: tokens[open].start, end: tokens[close].end, nodeId: id });
  }

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.value === "prompt" && tokens[i + 1] && tokens[i + 1].value !== "{") {
      let semi = i + 1;
      while (semi < tokens.length && tokens[semi].value !== ";") semi++;
      const nameTok = tokens[semi - 1];
      if (!nameTok || !isName(nameTok.value)) continue;
      const id = unique(`prompt:${nameTok.value}`);
      addNode({ id, kind: "prompt", label: nameTok.value, readOnly: true, readOnlyReason: "Prompt sensor signatures are structural and must be edited as code.", source: { line: t.line, column: t.column }, fields: [field("name", "Sensor", "text", nameTok.value, true, "Sensor renames require updating subscriptions."), field("type", "Input type", "text", tokens.slice(i + 1, semi - 1).map((x) => x.value).join(""), true, "Type changes require compiler-aware refactoring.")] }, 0);
      declarations.set(`prompt:${nameTok.value}`, id);
    }
    if ((t.value === "action" || t.value === "event") && isName(tokens[i + 1]?.value || "")) {
      const nameTok = tokens[i + 1];
      let semi = i + 2;
      while (semi < tokens.length && tokens[semi].value !== ";") semi++;
      const id = unique(`${t.value}-decl:${nameTok.value}`);
      addNode({ id, kind: t.value as "action" | "event", label: `${capitalize(t.value)} ${nameTok.value}`, readOnly: true, readOnlyReason: "Declaration signatures are structural and remain source-only.", source: { line: t.line, column: t.column }, fields: [field("signature", "Signature", "text", source.slice(t.start, tokens[semi]?.end || nameTok.end), true, "Signature editing is not yet supported.")] }, 0);
      declarations.set(`${t.value}:${nameTok.value}`, id);
    }
  }

  const scopeFor = (offset: number) => agents.find((a) => offset >= a.start && offset <= a.end);
  const scopeName = (offset: number) => scopeFor(offset)?.name || "module";
  const byScope = new Map<string, FlowNode[]>();
  const remember = (scope: string, node: FlowNode) => {
    const list = byScope.get(scope) || [];
    list.push(node);
    byScope.set(scope, list);
  };
  const addConstruct = (node: Omit<FlowNode, "position">, offset: number) => {
    const owner = scopeFor(offset);
    addNode(node, owner ? 2 + agents.indexOf(owner) : 2);
    remember(owner?.name || "module", nodes[nodes.length - 1]);
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const scope = scopeName(t.start);
    if (t.value === "<-" || t.value === "instruction") {
      const end = statementEnd(tokens, i);
      const literal = tokens.slice(i + 1, end).find((x) => x.string);
      const binding = bindingBefore(tokens, i);
      const id = unique(`model:${scope}:${binding || "call"}`);
      const fields: FlowField[] = [];
      if (literal?.string && literal.innerStart !== undefined && literal.innerEnd !== undefined) {
        const value = decodeString(source.slice(literal.innerStart, literal.innerEnd), literal.string === "format");
        fields.push(field("instruction", "Instruction", "multiline", value, false));
        edits.set(`${id}:instruction`, literalEdit(id, "instruction", literal, source));
      } else {
        fields.push(field("instruction", "Instruction", "multiline", source.slice(t.end, tokens[end]?.start || t.end).trim(), true, "This message is computed rather than literal-backed; editing it could change data flow."));
        diagnostics.push({ severity: "warning", code: "computed_prompt_read_only", message: "Computed model messages remain visible but read-only.", nodeId: id, field: "instruction" });
      }
      addConstruct({ id, kind: "model", label: binding ? `Model: ${binding}` : "Model call", readOnly: fields.every((f) => f.readOnly), ...(fields.every((f) => f.readOnly) ? { readOnlyReason: "No literal-backed instruction is available for safe editing." } : {}), source: { line: t.line, column: t.column }, fields }, t.start);
    }
    if (t.value === "decide") {
      const end = statementEnd(tokens, i);
      const binding = bindingBefore(tokens, i) || "decision";
      const id = unique(`decision:${scope}:${binding}`);
      const confidence = tokens.slice(i, end).findIndex((x, n, a) => x.value === "confidence" && a[n + 1] && /^\d+(?:\.\d+)?$/.test(a[n + 1].value));
      const slice = tokens.slice(i, end);
      const numberTok = confidence >= 0 ? slice[confidence + 1] : undefined;
      const fields = [field("rule", "Gate rule", "text", source.slice(t.start, tokens[end]?.start || t.end).trim(), true, "Only literal confidence thresholds are editable.")];
      if (numberTok) {
        fields.push(field("threshold", "Confidence threshold", "number", Number(numberTok.value), false));
        edits.set(`${id}:threshold`, { nodeId: id, field: "threshold", start: numberTok.start, end: numberTok.end, encode: (v) => String(Number(v)), validate: confidenceValue });
      }
      addConstruct({ id, kind: "decision", label: `Decision: ${binding}`, readOnly: !numberTok, ...(!numberTok ? { readOnlyReason: "This gate uses a non-literal or named policy." } : {}), source: { line: t.line, column: t.column }, fields }, t.start);
    }
    if (t.value === "endorse") {
      const binding = bindingBefore(tokens, i) || "endorsement";
      const id = unique(`endorsement:${scope}:${binding}`);
      const end = statementEnd(tokens, i);
      addConstruct({ id, kind: "endorsement", label: `Endorse: ${binding}`, readOnly: true, readOnlyReason: "Endorsement dependencies are structural and remain source-only.", source: { line: t.line, column: t.column }, fields: [field("expression", "Endorsement", "text", source.slice(t.start, tokens[end]?.start || t.end).trim(), true, "Dependency edits require compiler-aware validation.")] }, t.start);
    }
    if ((t.value === "perform" || t.value === "emit") && isName(tokens[i + 1]?.value || "") && tokens[i + 2]?.value === "(") {
      const name = tokens[i + 1].value;
      const kind = t.value === "perform" ? "action" : "event";
      const id = unique(`${kind}:${scope}:${name}`);
      const end = statementEnd(tokens, i);
      addConstruct({ id, kind, label: `${capitalize(t.value)} ${name}`, readOnly: true, readOnlyReason: "Invocation arguments and topology remain source-only in v1.", source: { line: t.line, column: t.column }, fields: [field("expression", "Invocation", "text", source.slice(t.start, tokens[end]?.start || t.end).trim(), true, "Structural edits are not yet supported.")] }, t.start);
      const decl = declarations.get(`${kind}:${name}`);
      if (!decl) diagnostics.push({ severity: "warning", code: "unresolved_flow_target", message: `${capitalize(kind)} ${name} is not declared in this file; it remains visible as an unresolved flow target.`, nodeId: id });
    }
    if (t.value === "say" && tokens[i + 1]?.value === "(") {
      const end = statementEnd(tokens, i);
      const literal = tokens.slice(i + 2, end).find((x) => x.string);
      const id = unique(`output:${scope}:say`);
      const fields: FlowField[] = [];
      if (literal?.innerStart !== undefined && literal.innerEnd !== undefined) {
        fields.push(field("template", "Output template", "multiline", decodeString(source.slice(literal.innerStart, literal.innerEnd), literal.string === "format"), false));
        edits.set(`${id}:template`, literalEdit(id, "template", literal, source));
      } else fields.push(field("template", "Output expression", "text", source.slice(tokens[i + 2]?.start || t.end, tokens[end]?.start || t.end).trim(), true, "Only literal-backed outputs can be safely edited."));
      addConstruct({ id, kind: "output", label: "Say output", readOnly: fields.every((f) => f.readOnly), ...(fields.every((f) => f.readOnly) ? { readOnlyReason: "This output is computed." } : {}), source: { line: t.line, column: t.column }, fields }, t.start);
    }
  }

  for (const agent of agents) {
    const subscriptions = tokens.filter((t, i) => t.start >= agent.start && t.end <= agent.end && t.value === "about" && isName(tokens[i + 1]?.value || ""));
    for (const about of subscriptions) {
      const idx = tokens.indexOf(about);
      const prompt = declarations.get(`prompt:${tokens[idx + 1].value}`);
      if (prompt) edges.push(edge(prompt, agent.nodeId, "input", "subscription", edges.length));
    }
  }

  diagnostics.push({ severity: "warning", code: "topology_read_only", message: "Flow topology is inferred from source. Creating, deleting, reconnecting, and reordering nodes remains source-only in this conservative editor." });
  const editable = edits.size > 0;
  return { edits, document: { schemaVersion: 1, rel, revision: flowRevision(source), readOnly: !editable, ...(!editable ? { readOnlyReason: "This file has no literal-backed prompts, thresholds, or outputs that can be edited safely." } : {}), capabilities: { editProperties: editable, createNodes: false, deleteNodes: false, connectNodes: false }, diagnostics, nodes, edges } };
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
      const format = source[i] === "f";
      if (format) advance();
      advance();
      const innerStart = i;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === "\\") { advance(); if (i < source.length) advance(); }
        else advance();
      }
      if (i >= source.length) throw new Error(`Unterminated string at ${tokenLine}:${tokenColumn}.`);
      const innerEnd = i;
      advance();
      out.push({ value: format ? "fstring" : "string", start, end: i, line: tokenLine, column: tokenColumn, string: format ? "format" : "plain", innerStart, innerEnd });
      continue;
    }
    if (/[A-Za-z_]/.test(source[i])) {
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i])) advance();
      out.push({ value: source.slice(start, i), start, end: i, line: tokenLine, column: tokenColumn });
      continue;
    }
    if (/\d/.test(source[i])) {
      while (i < source.length && /\d/.test(source[i])) advance();
      if (source[i] === "." && /\d/.test(source[i + 1] || "")) { advance(); while (i < source.length && /\d/.test(source[i])) advance(); }
      out.push({ value: source.slice(start, i), start, end: i, line: tokenLine, column: tokenColumn });
      continue;
    }
    const op = ["<-", "->", "|>", ">=", "<=", "==", "!=", "&&", "||"].find((x) => source.startsWith(x, i));
    if (op) { for (let n = 0; n < op.length; n++) advance(); out.push({ value: op, start, end: i, line: tokenLine, column: tokenColumn }); continue; }
    advance();
    out.push({ value: source.slice(start, i), start, end: i, line: tokenLine, column: tokenColumn });
  }
  return out;
}

function matching(tokens: Token[], open: string, close: string): Map<number, number> {
  const stack: number[] = [], result = new Map<number, number>();
  tokens.forEach((token, i) => { if (token.value === open) stack.push(i); else if (token.value === close) { const start = stack.pop(); if (start !== undefined) result.set(start, i); } });
  return result;
}

function statementEnd(tokens: Token[], start: number): number {
  let paren = 0, brace = 0, bracket = 0;
  for (let i = start; i < tokens.length; i++) {
    const value = tokens[i].value;
    if (value === "(") paren++; else if (value === ")") paren--; else if (value === "{") brace++; else if (value === "}") brace--; else if (value === "[") bracket++; else if (value === "]") bracket--;
    if (value === ";" && paren === 0 && brace === 0 && bracket === 0) return i;
  }
  return tokens.length;
}

function bindingBefore(tokens: Token[], at: number): string {
  for (let i = at - 1; i >= 0 && i >= at - 20; i--) {
    if (tokens[i].value === "=") return isName(tokens[i - 1]?.value || "") ? tokens[i - 1].value : "";
    if ([";", "{", "}"].includes(tokens[i].value)) break;
  }
  return "";
}

function isName(value: string): boolean { return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value); }
function capitalize(value: string): string { return value ? value[0].toUpperCase() + value.slice(1) : value; }
function edge(source: string, target: string, label: string, kind: string, index: number): FlowEdge { return { id: `edge:${index}:${source}:${target}`, source, target, label, kind, readOnly: true }; }
function decodeString(value: string, format: boolean): string {
  let decoded = "";
  let index = 0;
  while (index < value.length) {
    if (value[index] !== "\\") { decoded += value[index++]; continue; }
    const slashStart = index;
    while (value[index] === "\\") index++;
    const slashCount = index - slashStart;
    if (format && value[index] === "$" && value[index + 1] === "{") {
      decoded += "\\".repeat(slashCount) + "${";
      index += 2;
      continue;
    }
    decoded += "\\".repeat(Math.floor(slashCount / 2));
    if (slashCount % 2 === 0) continue;
    const escaped = value[index++];
    if (escaped === "n") decoded += "\n";
    else if (escaped === "t") decoded += "\t";
    else if (escaped === '"') decoded += '"';
    else if (escaped === "\\") decoded += "\\";
    else decoded += `\\${escaped ?? ""}`;
  }
  return decoded;
}

function encodeString(value: unknown, format: boolean): string {
  const text = String(value);
  let encoded = "";
  let index = 0;
  while (index < text.length) {
    if (format && text[index] === "\\") {
      const slashStart = index;
      while (text[index] === "\\") index++;
      const slashes = text.slice(slashStart, index);
      if (text[index] === "$" && text[index + 1] === "{") {
        encoded += slashes + "${";
        index += 2;
        continue;
      }
      encoded += "\\\\".repeat(slashes.length);
      continue;
    }
    const char = text[index++];
    if (char === "\\") encoded += "\\\\";
    else if (char === '"') encoded += '\\"';
    else if (char === "\n") encoded += "\\n";
    else if (char === "\t") encoded += "\\t";
    else encoded += char;
  }
  return encoded;
}
function confidenceValue(value: unknown): string | null { return validateConfidence(value); }

function literalEdit(nodeId: string, field: string, literal: Token, source: string): Edit {
  const start = literal.innerStart!;
  const end = literal.innerEnd!;
  const original = source.slice(start, end);
  return {
    nodeId,
    field,
    start,
    end,
    encode: (value) => encodeString(value, literal.string === 'format'),
    validate: literal.string === "format" ? (value) => validateLiteralInterpolations(original, value) : () => null,
  };
}
