// Playwright webServer launcher: scaffold a throwaway project and start the
// agent-server serving the BUILT web app (one process, like a real bundle), so the
// E2E test drives the actual studio end to end on the deterministic mock provider.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.resolve(here, ".."); // studio/web
const agentDir = path.resolve(web, "..", "agent-server"); // studio/agent-server
const bin = ["debug", "release"]
  .map((p) => path.resolve(web, "..", "..", "agape-rs", "target", p, "agape"))
  .find(existsSync);
if (!bin) { console.error("e2e: no agape binary — run `cargo build --bin agape`"); process.exit(1); }
if (!existsSync(path.join(web, "dist", "index.html"))) { console.error("e2e: web app not built — run `npm run build`"); process.exit(1); }

const proj = path.join(mkdtempSync(path.join(tmpdir(), "agape-e2e-")), "app");
execFileSync(bin, ["init", proj], { stdio: "ignore" });

const srv = spawn("npx", ["tsx", "server.ts"], {
  cwd: agentDir,
  env: {
    ...process.env,
    AGENT_PORT: process.env.PORT || "8920",
    AGAPE_PROJECT: proj,
    AGAPE_WEB_DIST: path.join(web, "dist"),
    AGAPE_BIN: bin,
  },
  stdio: "inherit",
});
const stop = () => { srv.kill(); process.exit(0); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
srv.on("exit", (code) => process.exit(code ?? 0));
