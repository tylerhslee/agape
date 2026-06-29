import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";

// Studio reports only its own application version at build/dev-server start.
// Runtime and language versions are project/deployment facts supplied by the
// backend for the currently opened project, not properties of the Studio bundle.
const STUDIO_VERSION = (() => {
  try { return JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version; }
  catch { return "unknown"; }
})();

// Expose the Studio version as a virtual module. A real module resolves
// identically in dev and build.
function versionsModule() {
  const id = "virtual:agape-versions";
  const resolved = "\0" + id;
  return {
    name: "agape-versions",
    resolveId: (s) => (s === id ? resolved : null),
    load: (s) =>
      s === resolved
        ? `export const STUDIO = ${JSON.stringify(STUDIO_VERSION)};\n`
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
      // The somatic agent server (Claude/OpenAI operators today; Agape + MCP later).
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
  // Vitest: component/unit tests live under src/. The Playwright E2E specs under
  // e2e/ are run by `playwright test`, not Vitest (both claim `*.spec`).
  test: {
    include: ["src/**/*.{test,spec}.{js,jsx,ts,tsx}"],
  },
});
