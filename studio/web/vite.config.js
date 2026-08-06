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

const AGENT_ORIGIN = `http://127.0.0.1:${process.env.AGENT_PORT || "8799"}`;

// In dev, the Vite server proxies the Agape backend's JSON API, so the frontend
// always calls same-origin "/project/...", "/agent/...", etc.
// In production, `npm run build` emits dist/, which the Python backend serves.
export default defineConfig({
  resolve: { alias: { "monaco-editor/esm/vs/editor/editor.api": "monaco-editor/editor/editor.api" } },
  plugins: [react(), versionsModule()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8765",
      // The somatic agent server (Claude/OpenAI operators today; Agape + MCP later).
      "/agent": AGENT_ORIGIN,
      "/learn": AGENT_ORIGIN,
      "/review": AGENT_ORIGIN,
      "/project": AGENT_ORIGIN,
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Monaco intentionally ships large language workers, especially the
    // TypeScript worker. Keep those assets split from Studio application code
    // and set the warning limit to match the editor footprint instead of
    // treating the default 500 kB threshold as actionable noise.
    chunkSizeWarningLimit: 8192,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("monaco-editor") || id.includes("@monaco-editor") || id.includes("monaco-vim")) {
            return "editor";
          }
          if (id.includes("@agape-lang")) return "agape-syntax";
          if (id.includes("react") || id.includes("react-dom")) return "react";
          return "vendor";
        },
      },
    },
  },
  // Vitest: component/unit tests live under src/. The Playwright E2E specs under
  // e2e/ are run by `playwright test`, not Vitest (both claim `*.spec`).
  test: {
    include: ["src/**/*.{test,spec}.{js,jsx,ts,tsx}"],
  },
});
