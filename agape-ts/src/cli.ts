#!/usr/bin/env tsx
// CLI — `agape-ts run <file.ag>`: lex -> parse -> run (async), then print the ledger.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse } from "./parser.js";
import { run } from "./interp.js";
import { check } from "./check.js";
import { createMemoryDriver, createProvider, loadManifest } from "./config.js";
import { show, type LedgerEvent } from "./runtime.js";

// Load API keys from a `.env` (searched upward from cwd) without clobbering existing env vars.
// Live provider secrets come from the environment (SPEC.md §17) — never the manifest.
function loadEnv(): void {
  let dir = process.cwd();
  for (let up = 0; up < 6; up++) {
    const candidate = resolve(dir, ".env");
    if (existsSync(candidate)) {
      for (const line of readFileSync(candidate, "utf8").split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (!m) continue;
        const key = m[1]!;
        if (process.env[key] !== undefined) continue;
        process.env[key] = m[2]!.trim().replace(/^["']|["']$/g, "");
      }
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  // `studio` — the execution-inspection web UI over the .ag programs in the CURRENT directory.
  if (cmd === "studio") {
    let port = 4317;
    let allowLive = false;
    let token: string | undefined;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--port") port = Number(rest[++i]);
      else if (rest[i] === "--share") allowLive = true;
      else if (rest[i] === "--live") allowLive = true;
      else if (rest[i] === "--token") token = rest[++i];
    }
    loadEnv();
    const { startStudio } = await import("../studio/server.js");
    await startStudio({ dir: process.cwd(), port, allowLive, token });
    return await new Promise<number>(() => {}); // serve until killed
  }
  // `graph` — the statically derived orchestration graph (GRAPH.md): parse + check, then emit.
  if (cmd === "graph") {
    let file = "";
    let format: "json" | "dot" = "json";
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--format") format = rest[++i] === "dot" ? "dot" : "json";
      else file = rest[i]!;
    }
    if (!file) { console.error("usage: agape-ts graph <file.ag> [--format json|dot]"); return 2; }
    const { check } = await import("./check.js");
    const { buildGraph, toDot } = await import("./graph.js");
    const program = parse(readFileSync(file, "utf8"));
    // the graph is syntactic; a static-check rejection is reported alongside it, not instead of it.
    try { check(program); } catch (e) {
      console.error(`note: static check rejects this program — ${(e as { cls?: string }).cls ?? "TypeError"}: ${(e as Error).message}`);
    }
    const graph = buildGraph(program, file);
    console.log(format === "dot" ? toDot(graph) : JSON.stringify(graph, null, 2));
    return 0;
  }
  if ((cmd !== "run" && cmd !== "check") || rest.length === 0) {
    console.error("usage: agape-ts run <file.ag> [--json] [--prompt name=value] [--manifest agape.toml] [--provider mock|anthropic|openai|gemini]");
    console.error("       agape-ts check <file.ag> [--json] [--manifest agape.toml] [--provider mock|anthropic|openai|gemini]");
    console.error("       agape-ts graph <file.ag> [--format json|dot]                      # derived orchestration graph");
    console.error("       agape-ts studio [--port 4317] [--share|--live] [--token secret]   # execution-inspection UI over the cwd");
    return 2;
  }
  let file = "";
  let manifestPath: string | undefined;
  let backendOverride: string | undefined;
  let json = false;
  const promptInputs: { name: string; value: string }[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--manifest") manifestPath = rest[++i];
    else if (a === "--provider" || a === "--backend") backendOverride = rest[++i];
    else if (a === "--json") json = true;
    else if (a === "--prompt") {
      const raw = rest[++i] ?? "";
      const eq = raw.indexOf("=");
      if (eq < 0) return emitCliError(new Error("--prompt expects name=value"), json);
      promptInputs.push({ name: raw.slice(0, eq), value: raw.slice(eq + 1) });
    } else if (a === "--claude") backendOverride = "anthropic";
    else if (a === "--samples" || a === "--temperature") i++; // accepted for Studio compatibility; manifest owns runtime policy.
    else file = a;
  }
  if (!file) return emitCliError(new Error(`usage: agape-ts ${cmd} <file.ag>`), json);

  loadEnv();
  const memoryRoot = manifestPath ? dirname(resolve(manifestPath)) : process.cwd();
  try {
    const source = readFileSync(file, "utf8");
    const manifest = loadManifest(manifestPath, backendOverride);
    const program = parse(source);

    if (cmd === "check") {
      check(program, undefined, manifest);
      if (json) console.log(JSON.stringify({ ok: true, file }, null, 2));
      else console.log("ok");
      return 0;
    }

    const provider = createProvider(manifest);
    const memory = createMemoryDriver(manifest, { cwd: memoryRoot });
    const result = await run(program, { provider, manifest, memory, memoryRoot, promptInputs });

    if (json) {
      console.log(JSON.stringify(jsonRunResult(file, manifest, result), null, 2));
      return 0;
    }

    const modelNote = manifest.provider.model ? ` / ${manifest.provider.model}` : "";
    console.log(`# agape-ts — ran ${file}  (provider: ${manifest.provider.backend}${modelNote})\n`);
    if (result.stdout.length) {
      console.log("say:");
      for (const line of result.stdout) console.log(`  ${line}`);
      console.log();
    }
    if (result.warnings.length) {
      console.log("warnings:");
      for (const w of result.warnings) console.log(`  ${w.kind}: ${w.message}`);
      console.log();
    }
    console.log("ledger:");
    for (const e of result.ledger.events) console.log(`  ${fmt(e)}`);
    console.log(`\nchain-head: ${result.ledger.head()}`);
    return 0;
  } catch (e) {
    return emitCliError(e, json);
  }
}


function jsonRunResult(file: string, manifest: ReturnType<typeof loadManifest>, result: Awaited<ReturnType<typeof run>>): Record<string, unknown> {
  const events = result.ledger.events.map((e) => ({
    ...e,
    corr: e.etype === "Sent" || e.etype === "Resolved" ? e.subject : undefined,
  }));
  return {
    ok: true,
    file,
    provider: manifest.provider,
    events,
    stdout: result.stdout,
    warnings: result.warnings,
    head: result.ledger.head(),
  };
}

function emitCliError(e: unknown, json: boolean): number {
  const err = e instanceof Error ? e : new Error(String(e));
  const cls = (e as { cls?: string })?.cls ?? err.name ?? "Error";
  if (json) console.log(JSON.stringify({ ok: false, class: cls, error: err.message }, null, 2));
  else console.error(`${cls}: ${err.message}`);
  return 1;
}

function fmt(e: LedgerEvent): string {
  const payload = e.payload === undefined ? "" : ` ${JSON.stringify(e.payload)}`;
  return `[${String(e.tick).padStart(2, " ")}] ${e.etype}(${e.subject})${payload}`;
}

main(process.argv.slice(2)).then((code) => process.exit(code));

// re-export for convenience
export { show };
