// Playwright webServer launcher: scaffold a throwaway project and start the
// agent-server serving the built web app (one process, like a real bundle), so the
// E2E test drives the actual Studio end to end on the deterministic mock provider.
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.resolve(here, ".."); // studio/web
const root = path.resolve(web, "..", "..");
const agentDir = path.resolve(web, "..", "agent-server"); // studio/agent-server
const agapeTs = path.join(root, "agape-ts");
const agapeTsCli = path.join(agapeTs, "src", "cli.ts");
const tsxCli = [
  path.join(agapeTs, "node_modules", "tsx", "dist", "cli.mjs"),
  path.join(agentDir, "node_modules", "tsx", "dist", "cli.mjs"),
].find(existsSync);

if (!tsxCli || !existsSync(agapeTsCli)) {
  console.error("e2e: agape-ts dependencies missing - run `npm install` in agape-ts and studio/agent-server");
  process.exit(1);
}
if (!existsSync(path.join(web, "dist", "index.html"))) {
  console.error("e2e: web app not built - run `npm run build`");
  process.exit(1);
}

// The fixture pins the language version the runtime actually ships — derive it
// so releases don't require a manual bump here.
const agapeVersion = JSON.parse(readFileSync(path.join(agapeTs, "package.json"), "utf8")).version;

const proj = path.join(mkdtempSync(path.join(tmpdir(), "agape-e2e-")), "app");
mkdirSync(proj, { recursive: true });
writeFileSync(path.join(proj, "agape.toml"), `[project]\nname = "E2E Fixture"\nlanguage = "${agapeVersion}"\n\n[memory]\ndriver = "markdown"\npath = ".agape/memory"\n`, "utf8");
// A program that runs to a *verified* answer on the mock provider: the Responder
// drafts an answer, decides it's safe, endorses it, and performs the `Reply`
// action — so the Run panel shows the ✓-verified reply and the ledger records the
// decision/endorsement. FactChecker gives the project a second declared agent.
// (Same journey as the agent-server integration suite; byte-stable under mock.)
writeFileSync(path.join(proj, "main.ag"), [
  "prompt text question;",
  "enum Verdict { Accept, Reject }",
  "action Reply(text answer);",
  "",
  "agent FactChecker {",
  '  on awake { say("fact checker ready"); }',
  "}",
  "",
  "agent Responder grants { perform Reply } {",
  "  when (Prompt p about question) {",
  '    text answer = f"verified answer: ${p.text}";',
  '    Credence<Verdict> c = self <- f"is this answer safe to send: ${answer}";',
  "    Decision<Verdict> d = decide c by confidence 0.5;",
  "    if (d.committed == Accept) {",
  "      Endorsement<text> e = endorse answer by d;",
  "      perform Reply(e);",
  "    }",
  "  }",
  "}",
  "",
  "spawn FactChecker checker;",
  "spawn Responder responder;",
  "awake checker;",
  "awake responder;",
  "",
].join("\n"), "utf8");
// The marquee runtime journey uses the repository proof application itself.
// main.ag remains only for the independent Monaco save smoke.
writeFileSync(path.join(proj, "agape.toml"), [
  "[project]",
  'name = "E2E Fixture"',
  `language = "${agapeVersion}"`,
  "",
  "[provider]",
  'backend = "mock"',
  "",
  "[tools.web_search]",
  'driver = "mock"',
  "",
  "[actions.Search]",
  'tool = "web_search"',
  'result_event = "SearchEvidence"',
  "",
  "[memory]",
  'driver = "markdown"',
  'path = ".agape/memory"',
  "",
  "[security.attesters.reviewer]",
  'driver = "host"',
  "",
].join("\n"), "utf8");
writeFileSync(path.join(proj, "fact_checker.ag"), readFileSync(path.join(agapeTs, "examples", "fact_checker.ag"), "utf8"), "utf8");
writeFileSync(path.join(proj, "attestation.ag"), `prompt text message;
principal reviewer;
enum Approval { Approve, Deny }
action ReplyAttested(text answer);

agent Assistant grants { perform ReplyAttested } {
  when (Prompt p about message) {
    text answer = self <- f"answer the user: \${p.text}";
    Credence<Approval> c = self <- answer;
    Decision<Approval> d = reviewer decide c by conformal 0.1 readiness 10;
    if (d.committed == Approve) {
      Endorsement<text> e = endorse answer by d;
      perform ReplyAttested(e);
    }
  }
}

spawn Assistant assistant;
awake assistant;
`, "utf8");

const srv = spawn(process.execPath, [tsxCli, "server.ts"], {
  cwd: agentDir,
  env: {
    ...process.env,
    AGENT_PORT: process.env.PORT || "8920",
    AGAPE_PROJECT: proj,
    AGAPE_WEB_DIST: path.join(web, "dist"),
    AGAPE_TS_CLI: agapeTsCli,
    TSX_CLI: tsxCli,
    AGENT_COGNITION_PROVIDER: "mock",
    AGENT_EMBEDDING_PROVIDER: "local",
  },
  stdio: "inherit",
});
const stop = () => { srv.kill(); process.exit(0); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
srv.on("exit", (code) => process.exit(code ?? 0));