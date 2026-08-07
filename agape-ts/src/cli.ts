#!/usr/bin/env tsx
// CLI — `agape-ts run <file.ag>`: lex -> parse -> run (async), then print the ledger.

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "./parser.js";
import { check } from "./check.js";
import { run, type PromptInput } from "./interp.js";
import { createMemoryDriver, createProvider, loadManifest } from "./config.js";
import { show, type LedgerEvent } from "./runtime.js";

function errorClass(e: unknown, fallback = "RuntimeError"): string {
  const cls = (e as { cls?: string })?.cls;
  if (cls) return cls;
  const name = (e as Error)?.name;
  if (name && name !== "Error") return name;
  const ctor = (e as Error)?.constructor?.name;
  return ctor && ctor !== "Error" ? ctor : fallback;
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  return typeof e === "string" ? e : "unexpected Agape error";
}

function printError(e: unknown): void {
  console.error(`${errorClass(e)}: ${errorMessage(e)}`);
}

// Load API keys from a `.env` (searched upward from cwd) without clobbering existing env vars.
// Live provider secrets come from the environment (SPEC.md §17) — never the manifest.
function loadEnv(start = process.cwd()): void {
  let dir = resolve(start);
  for (let up = 0; up < 16; up++) {
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

function findProjectRootForFile(file: string): string {
  let dir = dirname(resolve(file));
  for (let up = 0; up < 16; up++) {
    if (existsSync(resolve(dir, "agape.toml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirname(resolve(file));
}

function manifestForProject(projectRoot: string, explicit?: string): string | undefined {
  if (explicit) return resolve(explicit);
  const candidate = resolve(projectRoot, "agape.toml");
  return existsSync(candidate) ? candidate : undefined;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  // `studio` — launches the full React Studio (agent-server serving the packaged
  // web app) when a build is available: AGAPE_WEB_DIST, or the bundle-relative
  // stage laid out by scripts/package.sh (<bundle>/studio/web-dist next to
  // <bundle>/studio/agent-server). Otherwise — or with --inspector — it serves
  // the embedded single-file inspector over the CURRENT directory.
  if (cmd === "studio") {
    let port = 4317;
    let allowLive = false;
    let token: string | undefined;
    let inspectorOnly = false;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--port") port = Number(rest[++i]);
      else if (rest[i] === "--share") allowLive = true;
      else if (rest[i] === "--live") allowLive = true;
      else if (rest[i] === "--token") token = rest[++i];
      else if (rest[i] === "--inspector") inspectorOnly = true;
    }
    loadEnv();

    if (!inspectorOnly) {
      const here = dirname(fileURLToPath(import.meta.url)); // agape-ts/src
      const envDist = process.env.AGAPE_WEB_DIST ? resolve(process.env.AGAPE_WEB_DIST) : undefined;
      const bundleDist = resolve(here, "..", "..", "studio", "web-dist");
      const webDist = [envDist, bundleDist].find((d) => d && existsSync(join(d, "index.html")));
      if (webDist) {
        const agentServerDir = [
          resolve(webDist, "..", "agent-server"), // bundle: studio/web-dist ~ studio/agent-server
          resolve(webDist, "..", "..", "agent-server"), // repo: studio/web/dist ~ studio/agent-server
        ].find((d) => existsSync(join(d, "server.ts")));
        const tsxCli = resolve(here, "..", "node_modules", "tsx", "dist", "cli.mjs");
        if (agentServerDir && existsSync(tsxCli)) {
          if (!existsSync(join(agentServerDir, "node_modules"))) {
            console.log("agape studio: first run — installing agent-server dependencies");
            const install = spawnSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: agentServerDir, stdio: "inherit" });
            if (install.status !== 0) { console.error("agape studio: agent-server npm install failed"); return install.status ?? 1; }
          }
          console.log(`agape studio: full Studio (agent-server + built web app) at http://127.0.0.1:${port}`);
          const srv = spawn(process.execPath, [tsxCli, "server.ts"], {
            cwd: agentServerDir,
            stdio: "inherit",
            env: {
              ...process.env,
              AGENT_PORT: String(port),
              AGAPE_PROJECT: process.env.AGAPE_PROJECT ?? process.cwd(),
              AGAPE_WEB_DIST: webDist,
              AGAPE_TS_CLI: resolve(here, "cli.ts"),
              TSX_CLI: tsxCli,
            },
          });
          return await new Promise<number>((done) => {
            const stop = () => srv.kill();
            process.on("SIGINT", stop);
            process.on("SIGTERM", stop);
            srv.on("exit", (code) => done(code ?? 0));
          });
        }
        console.error("agape studio: found a web build but no runnable agent-server — falling back to the embedded inspector");
      }
    }

    console.log(`agape studio: embedded inspector at http://127.0.0.1:${port} ${inspectorOnly ? "(--inspector)" : "(no packaged web app found; set AGAPE_WEB_DIST to launch the full Studio)"}`);
    const { startStudio } = await import("../studio/server.js");
    await startStudio({ dir: process.cwd(), port, allowLive, token });
    return await new Promise<number>(() => {}); // serve until killed
  }
  if (cmd === "check") {
    let file = "";
    let manifestPath: string | undefined;
    let backendOverride: string | undefined;
    let json = false;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i]!;
      if (a === "--manifest") manifestPath = rest[++i];
      else if (a === "--provider") backendOverride = rest[++i];
      else if (a === "--json") json = true;
      else file = a;
    }
    if (!file) { console.error("usage: agape-ts check <file.ag> [--manifest agape.toml] [--provider mock|anthropic|openai|gemini] [--json]"); return 2; }
    try {
      const projectRoot = manifestPath ? dirname(resolve(manifestPath)) : findProjectRootForFile(file);
      loadEnv(projectRoot);
      const manifest = loadManifest(manifestForProject(projectRoot, manifestPath), backendOverride);
      const program = parse(readFileSync(file, "utf8"));
      check(program, undefined, manifest);
      if (json) console.log(JSON.stringify({ ok: true, file }));
      return 0;
    } catch (e) {
      if (json) console.log(JSON.stringify({ ok: false, file, class: errorClass(e), error: errorMessage(e) }));
      else printError(e);
      return 1;
    }
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
    try {
      const { check } = await import("./check.js");
      const { buildGraph, toDot } = await import("./graph.js");
      const program = parse(readFileSync(file, "utf8"));
      // the graph is syntactic; a static-check rejection is reported alongside it, not instead of it.
      try { check(program); } catch (e) {
        console.error(`note: static check rejects this program -- ${errorClass(e, "TypeError")}: ${errorMessage(e)}`);
      }
      const graph = buildGraph(program, file);
      console.log(format === "dot" ? toDot(graph) : JSON.stringify(graph, null, 2));
      return 0;
    } catch (e) {
      printError(e);
      return 1;
    }
  }
  if (cmd !== "run" || rest.length === 0) {
    console.error("usage: agape-ts run <file.ag> [--manifest agape.toml] [--provider mock|anthropic|openai|gemini] [--json] [--prompt name=value]");
    console.error("       agape-ts check <file.ag> [--manifest agape.toml] [--provider mock|anthropic|openai|gemini] [--json]");
    console.error("       agape-ts graph <file.ag> [--format json|dot]                      # derived orchestration graph");
    console.error("       agape-ts studio [--port 4317] [--inspector] [--share|--live] [--token secret]   # full Studio when a web build is staged, else the embedded inspector");
    return 2;
  }
  let file = "";
  let manifestPath: string | undefined;
  let backendOverride: string | undefined;
  let json = false;
  const promptInputs: PromptInput[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--manifest") manifestPath = rest[++i];
    else if (a === "--provider") backendOverride = rest[++i];
    else if (a === "--json") json = true;
    else if (a === "--prompt") {
      const raw = rest[++i] ?? "";
      const eq = raw.indexOf("=");
      if (eq < 0) { console.error("--prompt expects name=value"); return 2; }
      promptInputs.push({ name: raw.slice(0, eq), value: raw.slice(eq + 1) });
    } else if (a === "--claude") backendOverride = "anthropic";
    else if (a === "--samples" || a === "--temperature") i++;
    else file = a;
  }

  try {
    const projectRoot = manifestPath ? dirname(resolve(manifestPath)) : findProjectRootForFile(file);
    loadEnv(projectRoot);
    const source = readFileSync(file, "utf8");
    const manifest = loadManifest(manifestForProject(projectRoot, manifestPath), backendOverride);
    const provider = createProvider(manifest);
    const memory = createMemoryDriver(manifest, { cwd: projectRoot, provider });

    const program = parse(source);
    const identity = {
      projectSubject: `project:sha256:${createHash("sha256").update(projectRoot, "utf8").digest("hex")}`,
      sessionLineageId: randomUUID(),
      sessionId: randomUUID(),
      conversationId: randomUUID(),
    };
    const { ledger, stdout, warnings } = await run(program, {
      identity, provider, manifest, memory, promptInputs, projectRoot,
    });

    if (json) {
      console.log(JSON.stringify({ ok: true, file, provider: manifest.provider.backend, events: ledger.events, stdout, warnings, head: ledger.head() }));
      return 0;
    }

    const modelNote = manifest.provider.model ? ` / ${manifest.provider.model}` : "";
    console.log(`# agape-ts — ran ${file}  (provider: ${manifest.provider.backend}${modelNote})\n`);
    if (stdout.length) {
      console.log("say:");
      for (const line of stdout) console.log(`  ${line}`);
      console.log();
    }
    if (warnings.length) {
      console.log("warnings:");
      for (const w of warnings) console.log(`  ${w.kind}: ${w.message}`);
      console.log();
    }
    console.log("ledger:");
    for (const e of ledger.events) console.log(`  ${fmt(e)}`);
    console.log(`\nchain-head: ${ledger.head()}`);
    return 0;
  } catch (e) {
    if (json) console.log(JSON.stringify({ ok: false, file, class: errorClass(e), error: errorMessage(e) }));
    else printError(e);
    return 1;
  }
}

function fmt(e: LedgerEvent): string {
  const payload = e.payload === undefined ? "" : ` ${JSON.stringify(e.payload)}`;
  return `[${String(e.tick).padStart(2, " ")}] ${e.etype}(${e.subject})${payload}`;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    printError(e);
    process.exit(1);
  },
);

// re-export for convenience
export { show };
