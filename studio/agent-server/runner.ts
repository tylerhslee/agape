// The runner executes written Agape source and returns a pass/fail signal: the
// feedback the learner reflects on. It drives the TypeScript Agape CLI that ships
// with the base installation.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface RunResult {
  ok: boolean;
  output: string;
  error: string;
  runner: string;
}

export interface Runner {
  readonly name: string;
  available(): boolean;
  run(source: string): Promise<RunResult>;
}

export class AgapeTsRunner implements Runner {
  readonly name = "agape-ts";
  private cli: string;
  private tsxCli: string;

  constructor(rootDir: string) {
    const agapeTs = path.join(rootDir, "agape-ts");
    this.cli = process.env.AGAPE_TS_CLI || path.join(agapeTs, "src", "cli.ts");
    this.tsxCli = process.env.TSX_CLI || firstExisting([
      path.join(agapeTs, "node_modules", "tsx", "dist", "cli.mjs"),
      path.join(agapeTs, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx"),
      path.join(agapeTs, "node_modules", ".bin", "tsx"),
    ]);
  }

  available(): boolean {
    return fs.existsSync(this.cli) && fs.existsSync(this.tsxCli);
  }

  async run(source: string): Promise<RunResult> {
    const file = path.join(os.tmpdir(), `agape_${Date.now()}_${Math.random().toString(36).slice(2)}.ag`);
    fs.writeFileSync(file, source);
    try {
      const r = spawnSync(process.execPath, [this.tsxCli, this.cli, "check", file], { encoding: "utf8", timeout: 30000 });
      const out = (r.stdout || "").trim();
      const err = (r.stderr || "").trim();
      return { ok: r.status === 0, output: out, error: r.status === 0 ? "" : err || out || "non-zero exit", runner: this.name };
    } finally {
      try { fs.unlinkSync(file); } catch {}
    }
  }
}

function firstExisting(paths: string[]): string {
  return paths.find((p) => fs.existsSync(p)) || paths[0]!;
}

export class NullRunner implements Runner {
  readonly name = "none";
  available(): boolean {
    return true;
  }
  async run(): Promise<RunResult> {
    return {
      ok: false,
      output: "",
      error: "no Agape TypeScript runner: install agape-ts dependencies first (`npm install` in agape-ts/).",
      runner: this.name,
    };
  }
}

export function makeRunner(rootDir: string): Runner {
  const r = new AgapeTsRunner(rootDir);
  return r.available() ? r : new NullRunner();
}