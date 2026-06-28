import { defineConfig, devices } from "@playwright/test";

const PORT = 8920;

// E2E against the real studio: serve.mjs scaffolds a project and starts the
// agent-server serving the built web app; tests drive the browser against it.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["junit", { outputFile: "../../test-results/e2e.xml" }], ["html", { open: "never" }]] : "list",
  timeout: 30_000,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1280, height: 800 }, // wide → desktop 3-pane layout
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node e2e/serve.mjs",
    url: `http://127.0.0.1:${PORT}/agent/health`,
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
    env: { PORT: String(PORT) },
  },
});
