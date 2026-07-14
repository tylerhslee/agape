import { test, expect } from "@playwright/test";

// The studio boots into the "Agape Studio" command surface (MissionControl): a
// wordmark, the Plan/Build/Inspect/Run/Review intents, and a project map built
// from the scaffolded source. Navigation into the Run space happens from the
// quick-actions rail on that surface. serve.mjs scaffolds a deterministic project
// (main.ag: a FactChecker + a Responder that decides, endorses, and delivers a
// verified Reply) on the mock provider, so the whole journey is byte-stable.

// J1: the studio loads and shows the scaffolded project — the command surface
// mounts and both declared agents from main.ag are surfaced.
test("the studio loads and shows the scaffolded project", async ({ page }) => {
  await page.goto("/");

  // The command surface mounted (wordmark + the intent buttons).
  await expect(page.locator(".agape-wordmark")).toContainText("Agape Studio");
  await expect(page.locator(".agent-intents button", { hasText: "Run" })).toBeVisible();

  // The scaffolded project is reflected: its name heads the surface and both
  // agents declared in main.ag show up in the live agent-state panel.
  await expect(page.getByRole("heading", { name: "E2E Fixture" })).toBeVisible();
  await expect(page.locator(".agent-state-row", { hasText: "Responder" })).toBeVisible();
  await expect(page.locator(".agent-state-row", { hasText: "FactChecker" })).toBeVisible();
});

// J2 (the marquee journey): open the studio, go to the Run space, ask the
// program's `prompt` sensor (`question`) a question, run it on the mock provider,
// and get a ✓-verified answer back with the decision recorded in the ledger.
test("ask a question → a verified answer is delivered", async ({ page }) => {
  test.setTimeout(60_000); // a run cold-spawns the agape CLI (tsx) subprocess

  await page.goto("/");
  await expect(page.locator(".agape-wordmark")).toContainText("Agape Studio");

  // Enter the Run space from the command surface's quick-actions rail.
  await page.locator(".agent-quick button", { hasText: "Run" }).click();

  // The Run panel exposes the program's `prompt` sensors (here: `question`) as
  // inputs; fill one and run on the mock provider.
  const runPanel = page.locator(".pj-run-panel");
  await expect(runPanel).toBeVisible();
  const question = runPanel.locator(".pj-inp input").first();
  await expect(question).toBeVisible();
  await question.fill("is the earth round?");
  await runPanel.locator(".pj-run-btn").click();

  // The Q&A panel shows a ✓-verified answer from agape whose f-string
  // interpolated the asked question.
  await expect(page.locator(".pj-verified")).toBeVisible({ timeout: 45_000 });
  await expect(page.locator(".pj-qa").getByText("is the earth round?").first()).toBeVisible();
  await expect(page.locator(".pj-qa").getByText("verified answer: is the earth round?").first()).toBeVisible();

  // Under the hood, the ledger recorded the gate decision and the delivered reply.
  await expect(page.locator(".pj-spine").getByText("Decided", { exact: false }).first()).toBeVisible();
  await expect(page.locator(".pj-spine").getByText("Reply", { exact: false }).first()).toBeVisible();
});
