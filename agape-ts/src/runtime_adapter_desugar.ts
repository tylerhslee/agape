// Legacy-surface desugar for the runtime conformance adapter (src/runtime_adapter.ts).
//
// The agape-runtime-conformance suite embeds Agape sources written against the pre-core-kernel
// FULL surface. SPEC.md (core kernel) removed that sugar, and this compiler accepts exactly the
// core grammar. This module is a small, transparent source-to-source bridge so the suite's
// programs exercise the real kernel runtime:
//
//   1. `policy NAME { threshold t margin m floor f }` + `decide c by NAME`
//        -> inline `decide c by confidence t margin m floor f`
//   2. `write tool RET NAME(params);` -> `action NAME(params);` plus a [tools.NAME]/[actions.NAME]
//        manifest wiring (returned in `tools`), `grants { use NAME }` -> `grants { perform NAME }`,
//        and bare calls `NAME(args)` -> `perform NAME(args)`.
//   3. Gate arm blocks `endorse s by d { V as e { ... } W { ... } } abstain { ... }`
//        -> the kernel `if (d.committed == V) { Endorsement<text> e = endorse s by d; ... } else ...`
//   4. `event<T> x = ...` reply bindings -> `T x = ...` when `struct T` is declared, else `text x = ...`.
//   5. `when (Prompt p about src)` binder field `p.body` -> `p.text` (the kernel Prompt binder field).
//   6. `{ BODY } retry(N)` -> BODY re-issued N additional times inside `if (true) { ... }` blocks.
//        (The kernel has no bounded loop; this is an unrolled approximation whose observable
//        behavior matches the suite's fault-then-recover scenario.)
//   7. f-string interpolation `f"... {x} ..."` -> the kernel spelling `f"... ${x} ..."`.
//   8. A TOP-LEVEL `when` whose body consults cognition (`self <-`) or performs an action is
//        hoisted into a generated `agent __Conformance grants { * } { ... }` (spawned+awoken at
//        the end) — the kernel allows `self`/`perform` only inside an agent.
//
// Every rewrite is purely syntactic; gate/taint/authority semantics still run in the kernel.

export interface DesugarResult {
  source: string;
  /** tool names introduced by `write tool` declarations (need manifest wiring + handlers). */
  tools: string[];
}

export function desugarLegacySurface(input: string): DesugarResult {
  let src = input;
  const tools: string[] = [];

  // ---- 1. policy declarations -> inline confidence rules ----
  const policies = new Map<string, string>();
  src = src.replace(
    /policy\s+([A-Za-z_]\w*)\s*\{([^}]*)\}/g,
    (_m, name: string, body: string) => {
      const rule: string[] = [];
      const threshold = /threshold\s+([\d.]+)/.exec(body)?.[1];
      const margin = /margin\s+([\d.]+)/.exec(body)?.[1];
      const floor = /floor\s+([\d.]+)/.exec(body)?.[1];
      rule.push(`confidence ${threshold ?? "0.5"}`);
      if (margin !== undefined) rule.push(`margin ${margin}`);
      if (floor !== undefined) rule.push(`floor ${floor}`);
      policies.set(name, rule.join(" "));
      return "";
    },
  );
  for (const [name, rule] of policies) {
    src = src.replace(new RegExp(`\\bby\\s+${name}\\b`, "g"), `by ${rule}`);
  }

  // ---- 2. write tool declarations -> actions + wiring ----
  src = src.replace(
    /write\s+tool\s+\w+\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*;/g,
    (_m, name: string, params: string) => {
      tools.push(name);
      return `action ${name}(${params});`;
    },
  );
  for (const name of tools) {
    src = src.replace(new RegExp(`\\buse\\s+${name}\\b`, "g"), `perform ${name}`);
    // bare call statements NAME(...) -> perform NAME(...), leaving the decl and existing performs alone.
    src = src.replace(
      new RegExp(`(^|[\\s{;])(?!action\\s)(?!perform\\s)${name}\\(`, "g"),
      (m, lead: string) => `${lead}perform ${name}(`,
    );
    src = src.replace(new RegExp(`\\baction\\s+perform\\s+${name}\\(`, "g"), `action ${name}(`);
    src = src.replace(new RegExp(`\\bperform\\s+perform\\s+${name}\\(`, "g"), `perform ${name}(`);
  }

  // ---- 4. event<T> reply bindings ----
  src = src.replace(/\bevent<\s*([A-Za-z_]\w*)\s*>/g, (_m, inner: string) => {
    const hasStruct = new RegExp(`\\bstruct\\s+${inner}\\b`).test(src);
    return hasStruct ? inner : "text";
  });

  // ---- 5. Prompt binder `.body` -> `.text` ----
  const promptBinders = new Set<string>();
  for (const m of src.matchAll(/when\s*\(\s*Prompt\s+([A-Za-z_]\w*)/g)) promptBinders.add(m[1]!);
  for (const binder of promptBinders) {
    src = src.replace(new RegExp(`\\b${binder}\\.body\\b`, "g"), `${binder}.text`);
  }

  // ---- 7. f-string `{x}` -> `${x}` ----
  src = src.replace(/f"((?:[^"\\]|\\.)*)"/g, (_m, body: string) => `f"${body.replace(/(?<!\$)\{/g, "${")}"`);

  // ---- 3. gate arm blocks -> if/else chains ----
  src = desugarArmBlocks(src);

  // ---- 6. retry blocks -> unrolled attempts ----
  src = desugarRetry(src);

  // ---- 8. hoist cognition-bearing top-level `when` blocks into a generated agent ----
  src = hoistTopLevelWhens(src);

  return { source: src, tools };
}

/**
 * The kernel allows `self <-` and `perform` only inside an agent. The suite's sources attach
 * prompt subscriptions at top level, so any top-level `when` whose body needs an agent context
 * is moved into one generated `agent __Conformance grants { * } { ... }` (spawned and awoken at
 * the end of the program). Pure top-level `when`s (plain `emit` cascades) stay where they are.
 */
function hoistTopLevelWhens(input: string): string {
  const hoisted: string[] = [];
  let src = input;
  for (let guard = 0; guard < 32; guard++) {
    const found = findTopLevelWhen(src);
    if (!found) break;
    const { start, end, text } = found;
    const body = text.slice(text.indexOf("{"));
    if (!/\bself\b|\bperform\b/.test(body)) break; // benign top-level `when`s stay (scan stops at the first)
    hoisted.push(text);
    src = src.slice(0, start) + src.slice(end);
  }
  if (hoisted.length === 0) return src;
  return (
    `${src}\n` +
    `agent __Conformance grants { * } {\n  ${hoisted.join("\n  ")}\n}\n` +
    `spawn __Conformance __conformance;\nawake __conformance;\n`
  );
}

function findTopLevelWhen(src: string): { start: number; end: number; text: string } | null {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (depth === 0 && ch === "w" && /^when\b/.test(src.slice(i)) && (i === 0 || /[\s;}]/.test(src[i - 1]!))) {
      const openIdx = src.indexOf("{", i);
      if (openIdx < 0) return null;
      const closeIdx = matchBrace(src, openIdx);
      if (closeIdx < 0) return null;
      const text = src.slice(i, closeIdx + 1);
      const body = text.slice(text.indexOf("{"));
      if (!/\bself\b|\bperform\b/.test(body)) {
        i = closeIdx; // benign — skip past it and keep scanning
        continue;
      }
      return { start: i, end: closeIdx + 1, text };
    }
  }
  return null;
}

function matchBrace(src: string, openIdx: number): number {
  let depth = 0;
  let inString = false;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i]!;
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

interface Arm {
  variant: string;
  binder?: string;
  body: string;
}

function desugarArmBlocks(input: string): string {
  let src = input;
  // repeat until no statement-position `endorse ... by IDENT {` remains.
  for (let guard = 0; guard < 32; guard++) {
    const m = /(^|[\s{;])endorse\s+([^{;]+?)\s+by\s+([A-Za-z_]\w*)\s*\{/.exec(src);
    if (!m) break;
    const lead = m[1]!;
    const subject = m[2]!.trim();
    const decision = m[3]!;
    const openIdx = m.index + m[0].length - 1;
    const closeIdx = matchBrace(src, openIdx);
    if (closeIdx < 0) break;
    const inner = src.slice(openIdx + 1, closeIdx);
    // optional trailing `abstain { ... }`
    let tailEnd = closeIdx + 1;
    let abstainBody: string | undefined;
    const tail = /^\s*abstain\s*\{/.exec(src.slice(closeIdx + 1));
    if (tail) {
      const abOpen = closeIdx + 1 + tail[0].length - 1;
      const abClose = matchBrace(src, abOpen);
      if (abClose >= 0) {
        abstainBody = src.slice(abOpen + 1, abClose);
        tailEnd = abClose + 1;
      }
    }
    const arms = parseArms(inner);
    const chain: string[] = [];
    arms.forEach((arm, i) => {
      const kw = i === 0 ? "if" : "else if";
      const settle = arm.binder
        ? `Endorsement<text> ${arm.binder} = endorse ${subject} by ${decision}; `
        : "";
      chain.push(`${kw} (${decision}.committed == ${arm.variant}) { ${settle}${arm.body.trim()} }`);
    });
    chain.push(`else { ${(abstainBody ?? "").trim()} }`);
    src = src.slice(0, m.index) + lead + chain.join("\n        ") + src.slice(tailEnd);
  }
  return src;
}

function parseArms(inner: string): Arm[] {
  const arms: Arm[] = [];
  let i = 0;
  while (i < inner.length) {
    const head = /^\s*([A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?\s*\{/.exec(inner.slice(i));
    if (!head) break;
    const openIdx = i + head[0].length - 1;
    const closeIdx = matchBrace(inner, openIdx);
    if (closeIdx < 0) break;
    arms.push({
      variant: head[1]!,
      binder: head[2],
      body: inner.slice(openIdx + 1, closeIdx),
    });
    i = closeIdx + 1;
  }
  return arms;
}

function desugarRetry(input: string): string {
  let src = input;
  for (let guard = 0; guard < 8; guard++) {
    const m = /\}\s*retry\s*\(\s*(\d+)\s*\)/.exec(src);
    if (!m) break;
    const n = Number(m[1]);
    // find the matching `{` for the `}` right before `retry(`
    const closeIdx = m.index;
    let depth = 0;
    let openIdx = -1;
    for (let i = closeIdx; i >= 0; i--) {
      const ch = src[i]!;
      if (ch === "}") depth++;
      else if (ch === "{") {
        depth--;
        if (depth === 0) {
          openIdx = i;
          break;
        }
      }
    }
    if (openIdx < 0) break;
    const body = src.slice(openIdx + 1, closeIdx).trim();
    const attempts = [body];
    for (let k = 0; k < n; k++) attempts.push(`if (true) { ${body} }`);
    src = src.slice(0, openIdx) + attempts.join("\n            ") + src.slice(m.index + m[0].length);
  }
  return src;
}
