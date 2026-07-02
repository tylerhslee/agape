// The orchestration graph (GRAPH.md): a static derivation of a program's agent topology from its
// AST — instances, handlers, gates, sinks, tools, principals, prompt sensors, memory handles, and
// the typed edges between them. Tooling only: it adds no semantics, and consumes the same AST the
// checker validates.

import type * as A from "./ast.js";

export interface GraphNode {
  id: string;
  kind:
    | "top" | "agent" | "handler" | "hook" | "ask" | "gate" | "sink" | "emit" | "tool"
    | "principal" | "prompt" | "mem" | "event" | "ledger";
  label: string;
  parent?: string; // cluster (an agent instance, or "top")
  line: number;    // 1-based, for click-to-source
  meta?: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind:
    | "event" | "prompt" | "send" | "flow" | "escalate" | "sink"
    | "tool" | "store" | "recall" | "query" | "spawn";
  label?: string;
  variant?: string; // the committed variant guarding this edge, when inside `if (d.committed == V)`
  line?: number;
  resolved?: boolean; // false when a send destination could not be pinned to a static instance
}

export interface ProgramGraph {
  program: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

interface Instance {
  name: string;
  agentType: string;
  decl?: A.AgentDecl;
  args: A.Expr[];
  spawnLine: number;
}

// one walkable body: a hook, a handler, the agent ctor, or the top-level statement stream.
interface Ctx {
  nodeId: string;      // the node edges attach to when no gate context is active
  instance?: Instance; // owning instance (undefined = top level)
  body: A.Stmt[];
}

export function buildGraph(program: A.Program, programName = ""): ProgramGraph {
  const nodes = new Map<string, GraphNode>();
  const edgeList: GraphEdge[] = [];
  let edgeSeq = 0;

  const addNode = (n: GraphNode): GraphNode => {
    const prior = nodes.get(n.id);
    if (prior) return prior;
    nodes.set(n.id, n);
    return n;
  };
  const addEdge = (e: Omit<GraphEdge, "id">): void => {
    edgeList.push({ id: `e${edgeSeq++}`, ...e });
  };
  const line = (n: A.Node): number => n.pos?.line ?? 1;

  // ---- declaration tables --------------------------------------------------------------------
  const agents = new Map<string, A.AgentDecl>();
  const actions = new Map<string, A.ActionDecl>();
  const events = new Map<string, A.EventDecl>();
  const tools = new Map<string, A.ToolDecl>();
  const enums = new Map<string, A.EnumDecl>();
  const prompts = new Map<string, A.PromptDecl>();
  const principals = new Set<string>();
  for (const d of program.decls) {
    switch (d.kind) {
      case "agent": agents.set(d.name, d); break;
      case "action": actions.set(d.name, d); break;
      case "event": events.set(d.name, d); break;
      case "tool": tools.set(d.name, d); break;
      case "enum": enums.set(d.name, d); break;
      case "prompt": prompts.set(d.name, d); break;
      case "principal": principals.add(d.name); break;
      default: break;
    }
  }

  // ---- instances: `spawn Type name(args)` is statically known ---------------------------------
  const instances = new Map<string, Instance>();
  const collectSpawns = (stmts: A.Stmt[]): void => {
    for (const s of stmts) {
      if (s.kind === "spawn") {
        instances.set(s.name, {
          name: s.name, agentType: s.agentType, decl: agents.get(s.agentType),
          args: s.args, spawnLine: line(s),
        });
      }
      if (s.kind === "if") { collectSpawns(s.then); if (s.else) collectSpawns(s.else); }
      if (s.kind === "when") collectSpawns(s.body);
      if (s.kind === "retry") collectSpawns(s.body);
    }
  };
  collectSpawns(program.stmts);
  for (const inst of instances.values()) {
    if (inst.decl) for (const hook of inst.decl.ctor) if (hook.kind === "spawn") collectSpawns([hook]);
  }

  // sensors + principals are always visible: they are the program's declared dependencies.
  for (const p of prompts.values()) {
    addNode({ id: `prompt:${p.name}`, kind: "prompt", label: `prompt ${typeLabel(p.type)} ${p.name}`, line: line(p), meta: { type: typeLabel(p.type) } });
  }
  for (const d of program.decls) {
    if (d.kind === "principal") addNode({ id: `principal:${d.name}`, kind: "principal", label: d.name, line: line(d) });
  }

  // ---- contexts: agent clusters (hooks/handlers/ctors/mems) + the top level -------------------
  const ctxs: Ctx[] = [];
  // spawn/awake/sleep are wiring boilerplate — a program whose top level is ONLY that gets no
  // "program" node (the graph starts at the agents); anything more substantive keeps it.
  const topStmts = program.stmts.filter((s) => !["when", "spawn", "awake", "sleep"].includes(s.kind));
  const topWhens = program.stmts.filter((s): s is A.WhenStmt => s.kind === "when");
  const needTop = topStmts.length > 0;
  if (needTop) addNode({ id: "top", kind: "top", label: "program", line: 1 });

  for (const inst of instances.values()) {
    const decl = inst.decl;
    addNode({
      id: `agent:${inst.name}`, kind: "agent", label: `${inst.name}: ${inst.agentType}`,
      line: decl ? line(decl) : inst.spawnLine,
      meta: {
        agentType: inst.agentType,
        grants: decl ? (decl.grants === "all" ? "all" : decl.grants.map((g) => `${g.cap} ${g.name}`)) : [],
        spawnLine: inst.spawnLine,
      },
    });
    if (!decl) continue;
    for (const f of walkStmtsForMems(decl.ctor)) {
      addNode({ id: `mem:${inst.name}/${f.name}`, kind: "mem", label: f.name, parent: `agent:${inst.name}`, line: line(f) });
    }
    decl.hooks.forEach((h) => {
      const id = `hook:${inst.name}/${h.event}`;
      addNode({ id, kind: "hook", label: `on ${h.event}`, parent: `agent:${inst.name}`, line: line(h) });
      ctxs.push({ nodeId: id, instance: inst, body: h.body });
    });
    decl.whens.forEach((w, i) => {
      const id = `handler:${inst.name}/when:${i}`;
      addNode({
        id, kind: "handler", label: `when ${w.etype}`, parent: `agent:${inst.name}`, line: line(w),
        meta: { etype: w.etype, ...(w.about && w.about.kind === "ident" ? { about: w.about.name } : {}), ...(w.guard ? { guarded: true } : {}) },
      });
      ctxs.push({ nodeId: id, instance: inst, body: w.body });
    });
    const ctorBody = decl.ctor.filter((s) => s.kind !== "memdecl");
    if (ctorBody.length) ctxs.push({ nodeId: `agent:${inst.name}`, instance: inst, body: ctorBody });
  }
  topWhens.forEach((w, i) => {
    const id = `handler:top/when:${i}`;
    addNode({
      id, kind: "handler", label: `when ${w.etype}`, line: line(w),
      meta: { etype: w.etype, ...(w.about && w.about.kind === "ident" ? { about: w.about.name } : {}) },
    });
    ctxs.push({ nodeId: id, body: w.body });
  });
  if (needTop) ctxs.push({ nodeId: "top", body: topStmts });
  // spawn edges attach to the spawning context (top for top-level spawns).
  for (const s of program.stmts) {
    if (s.kind === "spawn") addEdge({ from: needTop ? "top" : "spawnsite", to: `agent:${s.name}`, kind: "spawn", label: "spawn", line: line(s) });
  }
  if (!needTop) {
    // no top node: spawn edges have no visible source — drop them (the agent nodes still exist).
    for (let i = edgeList.length - 1; i >= 0; i--) if (edgeList[i]!.from === "spawnsite") edgeList.splice(i, 1);
  }

  // ---- subscriptions: who consumes each event type --------------------------------------------
  interface Sub { nodeId: string; etype: string; about?: string }
  const subs: Sub[] = [];
  for (const n of nodes.values()) {
    if (n.kind === "handler") subs.push({ nodeId: n.id, etype: String(n.meta?.etype ?? n.label.replace(/^when /, "")), about: n.meta?.about as string | undefined });
  }
  // prompt sensor → its `about` handlers (an about-less Prompt handler hears every sensor).
  for (const p of prompts.values()) {
    for (const s of subs) {
      if (s.etype !== "Prompt") continue;
      if (s.about && s.about !== p.name) continue;
      addEdge({ from: `prompt:${p.name}`, to: s.nodeId, kind: "prompt", label: "Prompt", line: line(p) });
    }
  }

  // ---- walk each context body ------------------------------------------------------------------
  interface GateInfo { nodeId: string; enumName?: string; vars: Set<string> }
  for (const ctx of ctxs) {
    let siteSeq = 0; // shared ask/gate sequence, so the UI can order the chain within a context
    const gates = new Map<string, GateInfo>(); // decision-binding name -> gate
    const replyTypes = new Map<string, string>(); // binding name -> declared type label (for send labels)
    const bindingNode = new Map<string, string>(); // binding name -> the ask node that produced it

    // the node a produced effect attributes to: the active gate (+variant) or the context itself.
    type Attribution = { nodeId: string; variant?: string };

    const enumOfCredence = (e: A.Expr): string | undefined => {
      if (e.kind === "ident") {
        const t = replyTypes.get(e.name);
        const m = t?.match(/^Credence<(\w+)>$/);
        return m?.[1];
      }
      if (e.kind === "quorum") return enumOfCredence(e.source);
      return undefined;
    };

    // idents referenced by an expression that were bound by earlier asks — the dataflow chain.
    const identRefs = (e: A.Expr, out: Set<string>): Set<string> => {
      switch (e.kind) {
        case "ident": out.add(e.name); break;
        case "member": identRefs(e.obj, out); break;
        case "index": identRefs(e.obj, out); identRefs(e.index, out); break;
        case "binary": identRefs(e.left, out); identRefs(e.right, out); break;
        case "unary": identRefs(e.operand, out); break;
        case "fstring": for (const p of e.parts) if (p.kind === "expr") identRefs(p.expr, out); break;
        case "call": identRefs(e.callee, out); for (const a of e.args) identRefs(a, out); break;
        case "structlit": for (const f of e.fields) identRefs(f.value, out); break;
        case "arraylit": for (const i of e.items) identRefs(i, out); break;
        case "quorum": identRefs(e.source, out); break;
        case "agg": for (const o of e.operands) identRefs(o, out); break;
        case "pipe": identRefs(e.source, out); identRefs(e.fn, out); break;
        default: break;
      }
      return out;
    };
    // the nodes a value flows FROM: any ask that bound a referenced ident, else the context.
    const flowSources = (e: A.Expr, at: Attribution): string[] => {
      const srcs = [...identRefs(e, new Set<string>())].map((n) => bindingNode.get(n)).filter((x): x is string => Boolean(x));
      return srcs.length ? [...new Set(srcs)] : [at.nodeId];
    };

    const resolveDest = (e: A.Expr): { instName?: string; label: string } => {
      if (e.kind === "self") return { instName: ctx.instance?.name, label: "self" };
      if (e.kind === "ident") {
        if (instances.has(e.name)) return { instName: e.name, label: e.name };
        // a ctor param bound at spawn: `agent Boss(Worker hand)` + `spawn Boss b(w)` → hand = w.
        const params = ctx.instance?.decl?.params ?? [];
        const idx = params.findIndex((p) => p.name === e.name);
        if (idx >= 0) {
          const arg = ctx.instance?.args[idx];
          if (arg && arg.kind === "ident" && instances.has(arg.name)) return { instName: arg.name, label: arg.name };
        }
        return { label: e.name };
      }
      return { label: "?" };
    };

    const visitExpr = (e: A.Expr, at: Attribution, declType?: A.TypeRef, bindName?: string): void => {
      switch (e.kind) {
        case "decide": {
          const enumName = declType?.kind === "decision" ? declType.enumName : enumOfCredence(e.credence);
          // the gate is a STANDALONE decision diamond (not a cluster member): the chain drops out
          // of the agent box into it, and its arms fan to per-site consequence boxes.
          const gid = `gate:${ctx.nodeId}#${siteSeq++}`;
          addNode({
            id: gid, kind: "gate",
            label: `decide${enumName ? ` Credence<${enumName}>` : ""}`, line: line(e),
            meta: {
              ...(enumName ? { enum: enumName, variants: enums.get(enumName)?.variants } : {}),
              rule: ruleLabel(e.rule),
              ...(e.principal ? { principal: e.principal } : {}),
              ...(e.credence.kind === "quorum" ? { quorum: e.credence.k } : {}),
              ...(ctx.instance ? { agent: ctx.instance.name } : {}),
            },
          });
          // the credence flows in from the ask(s) that produced it — real dataflow, no label
          // needed (the gate node itself names the Credence type).
          for (const src of flowSources(e.credence, at)) {
            addEdge({ from: src, to: gid, kind: "flow", variant: at.variant, line: line(e) });
          }
          if (e.principal && principals.has(e.principal)) {
            addEdge({ from: gid, to: `principal:${e.principal}`, kind: "escalate", label: "escalate", line: line(e) });
          }
          if (bindName) gates.set(bindName, { nodeId: gid, enumName, vars: new Set() });
          visitExpr(e.credence, at);
          return;
        }
        case "endorse": {
          // attach to the gate the decision binding names; the gate node covers decide+endorse.
          if (e.decision.kind === "ident") {
            const g = gates.get(e.decision.name);
            const gn = g && nodes.get(g.nodeId);
            if (gn) gn.meta = { ...gn.meta, endorses: exprLabel(e.subject) };
            // the endorsed SUBJECT flows from the ask that produced it into the gate that settles it.
            if (g) {
              const subjectAsks = [...identRefs(e.subject, new Set<string>())]
                .map((n) => bindingNode.get(n)).filter((x): x is string => Boolean(x));
              for (const src of new Set(subjectAsks)) {
                if (!edgeList.some((ed) => ed.from === src && ed.to === g.nodeId && ed.kind === "flow")) {
                  addEdge({ from: src, to: g.nodeId, kind: "flow", line: line(e) });
                }
              }
            }
          }
          visitExpr(e.subject, at); visitExpr(e.decision, at);
          return;
        }
        case "send": {
          const dest = resolveDest(e.dest);
          // a mem handle on the left is a store, not a send.
          if (e.dest.kind === "ident" && ctx.instance && nodes.has(`mem:${ctx.instance.name}/${e.dest.name}`)) {
            addEdge({ from: at.nodeId, to: `mem:${ctx.instance.name}/${e.dest.name}`, kind: "store", label: "store", variant: at.variant, line: line(e) });
            visitExpr(e.message, at);
            return;
          }
          const selfSend = e.dest.kind === "self" || dest.instName === ctx.instance?.name;
          if (selfSend) {
            // a self-send is the agent's own cognition: a TESTIMONY step, visible as an ask node
            // labelled by the typed reply it produces, chained from the asks its prompt references.
            const aid = `ask:${ctx.nodeId}#${siteSeq++}`;
            addNode({
              id: aid, kind: "ask", parent: ctx.instance ? `agent:${ctx.instance.name}` : undefined,
              label: `ask ${declType ? typeLabel(declType) : "text"}`, line: line(e),
              // `binding` lets the live overlay match a Resolved ledger event (subjected by the
              // binding name) back to this ask.
              meta: { reply: declType ? typeLabel(declType) : "text", ...(bindName ? { binding: bindName } : {}) },
            });
            for (const src of flowSources(e.message, at)) {
              addEdge({ from: src, to: aid, kind: "flow", variant: at.variant, line: line(e) });
            }
            if (bindName) bindingNode.set(bindName, aid);
          } else {
            const to = dest.instName ? `agent:${dest.instName}` : addNode({ id: `agent:?${dest.label}`, kind: "agent", label: `${dest.label} (unresolved)`, line: line(e), meta: { resolved: false } }).id;
            addEdge({ from: at.nodeId, to, kind: "send", label: declType ? typeLabel(declType) : undefined, variant: at.variant, line: line(e), resolved: Boolean(dest.instName) });
          }
          if (bindName && declType) replyTypes.set(bindName, typeLabel(declType));
          visitExpr(e.message, at);
          return;
        }
        case "recall": {
          if (e.mem.kind === "ident" && ctx.instance && nodes.has(`mem:${ctx.instance.name}/${e.mem.name}`)) {
            addEdge({ from: `mem:${ctx.instance.name}/${e.mem.name}`, to: at.nodeId, kind: "recall", label: "recall", line: line(e) });
          }
          visitExpr(e.query, at);
          return;
        }
        case "select": {
          if (e.target === "ledger") {
            addNode({ id: "ledger", kind: "ledger", label: "ledger", line: line(e) });
            addEdge({ from: "ledger", to: at.nodeId, kind: "query", label: e.eventType ?? "*", line: line(e) });
          }
          for (const c of e.cond) visitExpr(c.value, at);
          return;
        }
        case "call": {
          if (e.callee.kind === "ident" && tools.has(e.callee.name)) {
            const t = tools.get(e.callee.name)!;
            addNode({ id: `tool:${t.name}`, kind: "tool", label: t.name, line: line(t), meta: { effect: t.effect, reversible: t.reversible } });
            addEdge({ from: at.nodeId, to: `tool:${t.name}`, kind: "tool", label: t.name, variant: at.variant, line: line(e) });
          }
          visitExpr(e.callee, at);
          for (const a of e.args) visitExpr(a, at);
          return;
        }
        case "quorum": visitExpr(e.source, at); return;
        case "agg": e.operands.forEach((o) => visitExpr(o, at)); return;
        case "pipe": visitExpr(e.source, at); visitExpr(e.fn, at); return;
        case "arraylit": e.items.forEach((i) => visitExpr(i, at)); return;
        case "structlit": e.fields.forEach((f) => visitExpr(f.value, at)); return;
        case "fstring": e.parts.forEach((p) => { if (p.kind === "expr") visitExpr(p.expr, at); }); return;
        case "member": visitExpr(e.obj, at); return;
        case "index": visitExpr(e.obj, at); visitExpr(e.index, at); return;
        case "binary": visitExpr(e.left, at); visitExpr(e.right, at); return;
        case "unary": visitExpr(e.operand, at); return;
        case "find": case "match": case "string": case "int": case "float":
        case "bool": case "null": case "self": case "ident": return;
      }
    };

    // `if (d.committed == V)` (or `V == d.committed`) → the gate for `d` + the variant.
    const narrowing = (cond: A.Expr): { gate: GateInfo; variant: string } | undefined => {
      if (cond.kind !== "binary" || cond.op !== "==") return undefined;
      const sides = [cond.left, cond.right];
      for (let i = 0; i < 2; i++) {
        const l = sides[i]!, r = sides[1 - i]!;
        if (l.kind === "member" && l.field === "committed" && l.obj.kind === "ident" && r.kind === "ident") {
          const g = gates.get(l.obj.name);
          if (g) return { gate: g, variant: r.name };
        }
      }
      return undefined;
    };

    const visitStmts = (stmts: A.Stmt[], at: Attribution): void => {
      for (const s of stmts) {
        switch (s.kind) {
          case "var": if (s.init) visitExpr(s.init, at, s.type, s.name); break;
          case "assign": visitExpr(s.value, at); break;
          case "exprstmt": visitExpr(s.expr, at); break;
          case "emit": {
            // each emit SITE is its own consequence box (`emit E`); subscribers hang off the site.
            const consumers = subs.filter((x) => x.etype === s.name);
            const sid = `do:${ctx.nodeId}#${siteSeq++}`;
            addNode({
              id: sid, kind: "emit", label: `emit ${s.name}`, line: line(s),
              meta: {
                event: s.name, consumed: consumers.length > 0,
                ...(at.variant ? { variant: at.variant } : {}),
                ...(ctx.instance ? { agent: ctx.instance.name } : {}),
              },
            });
            addEdge({ from: at.nodeId, to: sid, kind: "event", variant: at.variant, line: line(s) });
            for (const c of consumers) addEdge({ from: sid, to: c.nodeId, kind: "event", label: s.name, line: line(s) });
            s.args.forEach((a) => visitExpr(a, at));
            break;
          }
          case "perform": {
            // each perform SITE is its own consequence box (`perform A`).
            const a = actions.get(s.name);
            const sid = `do:${ctx.nodeId}#${siteSeq++}`;
            addNode({
              id: sid, kind: "sink", label: `perform ${s.name}`, line: line(s),
              meta: {
                action: s.name,
                ...(a ? { reversible: a.reversible } : {}),
                ...(at.variant ? { variant: at.variant } : {}),
                ...(ctx.instance ? { agent: ctx.instance.name } : {}),
              },
            });
            addEdge({ from: at.nodeId, to: sid, kind: "sink", variant: at.variant, line: line(s) });
            s.args.forEach((x) => visitExpr(x, at));
            break;
          }
          case "if": {
            const n = narrowing(s.cond);
            visitExpr(s.cond, at);
            if (n) {
              visitStmts(s.then, { nodeId: n.gate.nodeId, variant: n.variant });
              // the else of a narrowing chain is the residual arm; a nested `else if` narrowing
              // overrides this with its own variant, so only the FINAL else keeps "abstain" (§13).
              if (s.else) visitStmts(s.else, { nodeId: n.gate.nodeId, variant: "abstain" });
            } else {
              visitStmts(s.then, at);
              if (s.else) visitStmts(s.else, at);
            }
            break;
          }
          case "when": break;    // hoisted; already a context of its own
          case "spawn":          // a ctor/handler spawn draws from its own context (top-level ones are pre-wired)
            if (ctx.nodeId !== "top") addEdge({ from: at.nodeId, to: `agent:${s.name}`, kind: "spawn", label: "spawn", variant: at.variant, line: line(s) });
            break;
          case "retry": visitStmts(s.body, at); break;
          case "say": visitExpr(s.arg, at); break;
          case "return": if (s.value) visitExpr(s.value, at); break;
          case "memdecl": if (s.init) visitExpr(s.init, at); break;
          case "dispatch": {
            visitExpr(s.gate, at);
            for (const arm of s.arms) visitStmts(arm.body, at);
            if (s.abstain) visitStmts(s.abstain.body, at);
            break;
          }
          default: break;
        }
      }
    };

    visitStmts(ctx.body, { nodeId: ctx.nodeId });
  }

  return { program: programName, nodes: [...nodes.values()], edges: edgeList };
}

function walkStmtsForMems(stmts: A.Stmt[]): A.MemDecl[] {
  const out: A.MemDecl[] = [];
  for (const s of stmts) if (s.kind === "memdecl") out.push(s);
  return out;
}

function typeLabel(t: A.TypeRef): string {
  switch (t.kind) {
    case "scalar": return t.name;
    case "mem": return "mem";
    case "event": return `event<${typeLabel(t.inner)}>`;
    case "array": return `${typeLabel(t.inner)}[]`;
    case "credence": return `Credence<${t.enumName}>`;
    case "decision": return `Decision<${t.enumName}>`;
    case "endorsement": return `Endorsement<${typeLabel(t.inner)}>`;
    case "named": return t.typeArgs?.length ? `${t.name}<${t.typeArgs.map(typeLabel).join(", ")}>` : t.name;
  }
}

function ruleLabel(r: A.Rule): string {
  switch (r.kind) {
    case "confidence": return `confidence ${r.theta}${r.margin !== undefined ? ` margin ${r.margin}` : ""}${r.floor !== undefined ? ` floor ${r.floor}` : ""}`;
    case "conformal": return `conformal${r.alpha !== undefined ? ` ${r.alpha}` : ""}${r.readiness !== undefined ? ` readiness ${r.readiness}` : ""}${r.floor !== undefined ? ` floor ${r.floor}` : ""}`;
    case "policy": return `policy ${r.name}`;
    case "expr": return "expr";
  }
}

function exprLabel(e: A.Expr): string {
  switch (e.kind) {
    case "ident": return e.name;
    case "member": return `${exprLabel(e.obj)}.${e.field}`;
    case "self": return "self";
    case "string": return JSON.stringify(e.value);
    case "int": case "float": return String(e.value);
    default: return e.kind;
  }
}

// ---- Graphviz DOT ------------------------------------------------------------------------------

export function toDot(g: ProgramGraph): string {
  const q = (s: string) => JSON.stringify(s);
  const shape: Record<GraphNode["kind"], string> = {
    top: "box", agent: "box", handler: "box", hook: "box", ask: "ellipse", gate: "diamond", sink: "doubleoctagon",
    emit: "note", tool: "component", principal: "house", prompt: "cds", mem: "cylinder", event: "note", ledger: "cylinder",
  };
  const lines: string[] = [`digraph ${q(g.program || "agape")} {`, `  rankdir=LR;`, `  node [fontname="monospace", fontsize=10];`];
  const clustered = new Map<string, GraphNode[]>();
  const loose: GraphNode[] = [];
  for (const n of g.nodes) (n.parent ? (clustered.get(n.parent) ?? clustered.set(n.parent, []).get(n.parent)!) : loose).push(n);
  const nodeLine = (n: GraphNode, indent: string) =>
    `${indent}${q(n.id)} [label=${q(n.label + (n.meta?.rule ? `\n${n.meta.rule}` : ""))}, shape=${shape[n.kind]}];`;
  for (const n of loose) {
    if (clustered.has(n.id)) continue; // cluster parents render inside their subgraph below
    lines.push(nodeLine(n, "  "));
  }
  let ci = 0;
  for (const [parent, members] of clustered) {
    const head = g.nodes.find((n) => n.id === parent);
    lines.push(`  subgraph cluster_${ci++} {`, `    label=${q(head?.label ?? parent)};`);
    // the parent renders as a header node inside its own cluster, so edges to it stay in-cluster.
    if (head) lines.push(`    ${q(head.id)} [label=${q(head.label)}, shape=plaintext];`);
    for (const m of members) lines.push(nodeLine(m, "    "));
    lines.push("  }");
  }
  for (const e of g.edges) {
    const attrs = [
      e.label ? `label=${q(e.variant ? `${e.label} [${e.variant}]` : e.label)}` : e.variant ? `label=${q(`[${e.variant}]`)}` : "",
      e.kind === "recall" || e.kind === "store" ? "style=dashed" : "",
      e.kind === "escalate" ? "color=orange" : e.kind === "sink" ? "color=gold" : "",
    ].filter(Boolean).join(", ");
    lines.push(`  ${q(e.from)} -> ${q(e.to)}${attrs ? ` [${attrs}]` : ""};`);
  }
  lines.push("}");
  return lines.join("\n");
}
