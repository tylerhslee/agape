// The runner executes written Agape source and returns a pass/fail signal — the
// feedback the learner reflects on. It drives the dependency-free agape-rs binary
// (`agape check <file>`: exit 0 = accepted, exit 1 = the checker/runtime error).
// NullRunner degrades gracefully when the binary hasn't been built.

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

// Uses the prebuilt release binary so each check is a fast process spawn (no compile,
// no cargo on PATH). Build it once: `cargo build --release --bin agape` in agape-rs/.
export class AgapeRsRunner implements Runner {
  readonly name = "agape-rs";
  private bin: string;
  constructor(agapeRsDir: string) {
    this.bin = path.join(agapeRsDir, "target", "release", "agape");
  }

  available(): boolean {
    return fs.existsSync(this.bin);
  }

  async run(source: string): Promise<RunResult> {
    const file = path.join(os.tmpdir(), `agape_${Date.now()}_${Math.random().toString(36).slice(2)}.ag`);
    fs.writeFileSync(file, source);
    try {
      const r = spawnSync(this.bin, ["check", file], { encoding: "utf8", timeout: 30000 });
      const out = (r.stdout || "").trim();
      const err = (r.stderr || "").trim();
      return { ok: r.status === 0, output: out, error: r.status === 0 ? "" : err || out || "non-zero exit", runner: this.name };
    } finally {
      try {
        fs.unlinkSync(file);
      } catch {}
    }
  }
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
      error: "no Agape runner — build it once with `cargo build --release --bin agape` in agape-rs/",
      runner: this.name,
    };
  }
}

export function makeRunner(agapeRsDir: string): Runner {
  const r = new AgapeRsRunner(agapeRsDir);
  return r.available() ? r : new NullRunner();
}
