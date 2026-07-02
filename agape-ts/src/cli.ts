#!/usr/bin/env tsx
// CLI — `agape-ts run <file.ag>`: lex -> parse -> run (async), then print the ledger.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse } from "./parser.js";
import { run } from "./interp.js";
import { createProvider, loadManifest } from "./config.js";
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
      else if (rest[i] === "--live") allowLive = true;
      else if (rest[i] === "--token") token = rest[++i];
    }
    loadEnv();
    const { startStudio } = await import("../studio/server.js");
    await startStudio({ dir: process.cwd(), port, allowLive, token });
    return await new Promise<number>(() => {}); // serve until killed
  }
  if (cmd !== "run" || rest.length === 0) {
    console.error("usage: agape-ts run <file.ag> [--manifest agape.toml] [--provider mock|anthropic|openai|gemini]");
    console.error("       agape-ts studio [--port 4317] [--live]   # execution-inspection UI over the cwd");
    return 2;
  }
  let file = "";
  let manifestPath: string | undefined;
  let backendOverride: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--manifest") manifestPath = rest[++i];
    else if (a === "--provider") backendOverride = rest[++i];
    else file = a;
  }

  loadEnv();
  const source = readFileSync(file, "utf8");
  const manifest = loadManifest(manifestPath, backendOverride);
  const provider = createProvider(manifest);

  const program = parse(source);
  const { ledger, stdout } = await run(program, { provider });

  const modelNote = manifest.provider.model ? ` / ${manifest.provider.model}` : "";
  console.log(`# agape-ts — ran ${file}  (provider: ${manifest.provider.backend}${modelNote})\n`);
  if (stdout.length) {
    console.log("say:");
    for (const line of stdout) console.log(`  ${line}`);
    console.log();
  }
  console.log("ledger:");
  for (const e of ledger.events) console.log(`  ${fmt(e)}`);
  console.log(`\nchain-head: ${ledger.head()}`);
  return 0;
}

function fmt(e: LedgerEvent): string {
  const payload = e.payload === undefined ? "" : ` ${JSON.stringify(e.payload)}`;
  return `[${String(e.tick).padStart(2, " ")}] ${e.etype}(${e.subject})${payload}`;
}

main(process.argv.slice(2)).then((code) => process.exit(code));

// re-export for convenience
export { show };
