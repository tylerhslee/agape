// Playwright webServer launcher: scaffold a throwaway project and start the
// agent-server serving the built web app (one process, like a real bundle), so the
// E2E test drives the actual Studio end to end on the deterministic mock provider.
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
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

const proj = path.join(mkdtempSync(path.join(tmpdir(), "agape-e2e-")), "app");
mkdirSync(proj, { recursive: true });
writeFileSync(path.join(proj, "agape.toml"), `[project]\nname = "E2E Fixture"\nlanguage = "1.0.0-alpha.2026.7.11.6"\n\n[memory]\ndriver = "markdown"\npath = ".agape/memory"\n`, "utf8");
writeFileSync(path.join(proj, "main.ag"), `prompt text question;\nagent Responder { when (Prompt p about question) { say(p.text); } }\nspawn Responder responder;\nawake responder;\n`, "utf8");

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