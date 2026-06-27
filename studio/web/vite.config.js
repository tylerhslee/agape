import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, the Vite server (5173) proxies the Agape backend's JSON API to the
// Python process on 8765, so the frontend always calls same-origin "/api/...".
// In production, `npm run build` emits dist/, which the Python backend serves.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8765",
      // The somatic agent server (Claude-backed operators today; Agape + MCP later).
      "/agent": "http://127.0.0.1:8799",
      "/learn": "http://127.0.0.1:8799",
      "/review": "http://127.0.0.1:8799",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
