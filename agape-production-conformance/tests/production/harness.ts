import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = resolve(HERE, "..", "..");
export const REPO_ROOT = resolve(PACKAGE_ROOT, "..");
export const FIXTURE_ROOT = join(PACKAGE_ROOT, "fixtures", "production");

export interface LedgerEvent {
  tick: number;
  etype: string;
  subject: string;
  payload?: unknown;
  agent?: string;
  [key: string]: unknown;
}

export interface CliJson {
  ok?: boolean;
  events?: LedgerEvent[];
  head?: string;
  error?: string;
  class?: string;
  [key: string]: unknown;
}

export interface CliResult {
  command: string;
  args: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  json?: CliJson;
  parseError?: string;
}

export interface TempProject {
  root: string;
  write(relativePath: string, contents: string): Promise<string>;
  cleanup(): Promise<void>;
}

export function sentinel(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

export function renderTemplate(source: string, values: Record<string, string>): string {
  return source.replace(/\{\{([A-Z0-9_-]+)\}\}/g, (_whole, key: string) => {
    if (!(key in values)) throw new Error(`missing template value ${key}`);
    return values[key]!;
  });
}

export async function fixture(relativePath: string, values: Record<string, string> = {}): Promise<string> {
  const source = await readFile(join(FIXTURE_ROOT, relativePath), "utf8");
  return renderTemplate(source, values);
}

export async function createTempProject(projectName: string): Promise<TempProject> {
  const root = await mkdtemp(join(tmpdir(), "agape-production-conformance-"));
  const manifest = await fixture("agape.toml.tmpl", { PROJECT: projectName });
  await writeFile(join(root, "agape.toml"), manifest, "utf8");
  return {
    root,
    async write(relativePath: string, contents: string): Promise<string> {
      const path = join(root, relativePath);
      await writeFile(path, contents, "utf8");
      return path;
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function invocation(): { command: string; prefix: string[]; cmdShim: boolean } {
  const installed = process.env.AGAPE_PRODUCTION_BIN;
  if (installed) {
    return {
      command: resolve(installed),
      prefix: [],
      cmdShim: process.platform === "win32" && extname(installed).toLowerCase() === ".cmd",
    };
  }
  return {
    command: process.execPath,
    prefix: [
      join(REPO_ROOT, "agape-ts", "node_modules", "tsx", "dist", "cli.mjs"),
      join(REPO_ROOT, "agape-ts", "src", "cli.ts"),
    ],
    cmdShim: false,
  };
}

const CMD_META = /[\r\n"&|<>^%!()]/;

export function windowsCmdCommand(executable: string, args: string[]): string {
  const values = [executable, ...args];
  for (const value of values) {
    if (CMD_META.test(value)) {
      throw new Error("unsafe cmd.exe metacharacter in production CLI argument: " + JSON.stringify(value));
    }
  }
  return "call " + values.map((value) => '"' + value + '"').join(" ");
}


export interface WindowsCmdSpawnPlan {
  command: string;
  args: string[];
  shell: false;
}

/** Explicit, shell-free plan for launching an npm-style .cmd shim. */
export function windowsCmdSpawnPlan(
  executable: string,
  args: string[],
  comSpec = process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe",
): WindowsCmdSpawnPlan {
  return {
    command: comSpec,
    args: ["/d", "/s", "/c", windowsCmdCommand(executable, args)],
    shell: false,
  };
}
function scrubbedProcessEnv(): NodeJS.ProcessEnv {
  const inherited: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(AGAPE|OPENAI|ANTHROPIC|AZURE_OPENAI|GOOGLE|AWS|MISTRAL|COHERE|GROQ|TOGETHER|DEEPSEEK)_/i.test(key)) continue;
    if (/(?:API_?KEY|ACCESS_?KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)/i.test(key)) continue;
    inherited[key] = value;
  }
  return inherited;
}

function parseCliJson(stdout: string): { json?: CliJson; parseError?: string } {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return { json: JSON.parse(lines[i]!) as CliJson };
    } catch {
      // Keep scanning so benign wrapper output cannot hide the CLI JSON line.
    }
  }
  return { parseError: stdout.trim() ? "stdout contained no JSON object" : "stdout was empty" };
}

export async function runCliCommand(args: {
  project: TempProject;
  commandArgs: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<CliResult> {
  const target = invocation();
  const cliArgs = [...target.prefix, ...args.commandArgs];
  const windowsPlan = target.cmdShim ? windowsCmdSpawnPlan(target.command, cliArgs) : undefined;
  const spawnCommand = windowsPlan?.command ?? target.command;
  const spawnArgs = windowsPlan?.args ?? cliArgs;
  return await new Promise<CliResult>((done) => {
    const child = spawn(spawnCommand, spawnArgs, {
      cwd: args.project.root,
      // A developer shell may contain real connector credentials or Agape overrides. Production
      // conformance supplies every seam explicitly; inherited secrets must never select a backend.
      env: { ...scrubbedProcessEnv(), ...(args.env ?? {}) },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), args.timeoutMs ?? 20_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      done({
        command: spawnCommand,
        args: spawnArgs,
        exitCode: null,
        signal: null,
        stdout,
        stderr: `${stderr}${error.message}`,
        parseError: `failed to start CLI: ${error.message}`,
      });
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      const parsed = parseCliJson(stdout);
      done({ command: spawnCommand, args: spawnArgs, exitCode, signal, stdout, stderr, ...parsed });
    });
  });
}

export async function runCli(args: {
  project: TempProject;
  file: string;
  extraArgs?: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<CliResult> {
  return runCliCommand({
    project: args.project,
    commandArgs: [
      "run",
      args.file,
      "--manifest",
      join(args.project.root, "agape.toml"),
      "--json",
      ...(args.extraArgs ?? []),
    ],
    env: args.env,
    timeoutMs: args.timeoutMs,
  });
}

export function runDiagnostic(result: CliResult): string {
  return [
    `${result.command} ${result.args.join(" ")}`,
    `exit=${String(result.exitCode)} signal=${String(result.signal)}`,
    `json=${JSON.stringify(result.json)}`,
    result.parseError ? `parse=${result.parseError}` : "",
    result.stderr ? `stderr=${result.stderr.trim()}` : "",
  ].filter(Boolean).join("\n");
}

export function eventsOf(result: CliResult, etype?: string): LedgerEvent[] {
  const events = Array.isArray(result.json?.events) ? result.json!.events! : [];
  return etype ? events.filter((event) => event.etype === etype) : events;
}

export function payloadObject(event: LedgerEvent | undefined): Record<string, unknown> {
  const payload = event?.payload;
  return payload !== null && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
}

export async function readTree(root: string): Promise<Record<string, string>> {
  const output: Record<string, string> = {};
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else output[full.slice(root.length + 1).replaceAll("\\", "/")] = await readFile(full, "utf8");
    }
  }
  try { await walk(root); } catch { /* absent tree is a useful empty oracle */ }
  return output;
}
