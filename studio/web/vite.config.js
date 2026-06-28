import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";

// The three versions the studio reports (Studio → Settings → About), read from
// their canonical files at build / dev-server start. In a coherent release these
// move in lockstep; sourcing them here keeps the display honest with no backend
// round-trip. Missing files (e.g. a stripped bundle) fall back to "unknown".
function match1(url, re) {
  try {
    return (readFileSync(url, "utf8").match(re) || [])[1] || "unknown";
  } catch {
    return "unknown";
  }
}
const STUDIO_VERSION = (() => {
  try { return JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version; }
  catch { return "unknown"; }
})();
const RUNTIME_VERSION = match1(new URL("../../agape-rs/Cargo.toml", import.meta.url), /^\s*version\s*=\s*"([^"]+)"/m);
const LANGUAGE_VERSION = match1(new URL("../../SPEC.md", import.meta.url), /Agape Language Specification\s*\(v?([0-9][0-9.]*)\)/);

// Expose the versions as a virtual module: `import { STUDIO, RUNTIME, LANGUAGE }
// from "virtual:agape-versions"`. A real module, so it resolves identically in
// dev and build (unlike `define`, which only statically replaces at build time).
function versionsModule() {
  const id = "virtual:agape-versions";
  const resolved = "\0" + id;
  return {
    name: "agape-versions",
    resolveId: (s) => (s === id ? resolved : null),
    load: (s) =>
      s === resolved
        ? `export const STUDIO = ${JSON.stringify(STUDIO_VERSION)};\n` +
          `export const RUNTIME = ${JSON.stringify(RUNTIME_VERSION)};\n` +
          `export const LANGUAGE = ${JSON.stringify(LANGUAGE_VERSION)};\n`
        : null,
  };
}

// In dev, the Vite server (5173) proxies the Agape backend's JSON API to the
// Python process on 8765, so the frontend always calls same-origin "/api/...".
// In production, `npm run build` emits dist/, which the Python backend serves.
export default defineConfig({
  plugins: [react(), versionsModule()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8765",
      // The somatic agent server (Claude-backed operators today; Agape + MCP later).
      "/agent": "http://127.0.0.1:8799",
      "/learn": "http://127.0.0.1:8799",
      "/review": "http://127.0.0.1:8799",
      "/project": "http://127.0.0.1:8799",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
