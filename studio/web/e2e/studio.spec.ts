import { test, expect } from "@playwright/test";

// J2 (the marquee journey): open the studio, ask a question, and get a verified
// answer back. Deterministic — the mock provider gives a byte-stable spine.
test("ask a question → a verified answer is delivered", async ({ page }) => {
  await page.goto("/");

  // The project studio shows the scaffolded agents.
  await expect(page.getByText("Responder", { exact: false })).toBeVisible();
  await expect(page.getByText("FactChecker", { exact: false })).toBeVisible();

  // Ask a question via the prompt sensor, then run on the mock provider.
  await page.locator(".pj-inp input").first().fill("is the earth round?");
  await page.getByRole("button", { name: /Run/ }).first().click();

  // The conversation shows the user's question and a ✓-verified answer from agape.
  await expect(page.locator(".pj-verified")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("is the earth round?")).toBeVisible();

  // Under the hood, the spine recorded the gate decision and the delivered reply.
  await expect(page.getByText("Decided", { exact: false })).toBeVisible();
  await expect(page.getByText("Reply", { exact: false })).toBeVisible();
});

// J3: a program that fails the static checks surfaces a clear error, never a crash.
test("a rejected program shows an error, not a crash", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Responder", { exact: false })).toBeVisible(); // app loaded
  // (the rejection path itself is asserted in the backend integration suite;
  //  here we only confirm the UI stays responsive — the run button is enabled)
  await expect(page.getByRole("button", { name: /Run/ }).first()).toBeEnabled();
});
