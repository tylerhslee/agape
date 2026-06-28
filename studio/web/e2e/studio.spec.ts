import { test, expect } from "@playwright/test";

// The studio is one app shell with a persistent activity rail; each project space
// (Overview / Work / Files / Run) is reached by clicking its rail item.
function railItem(page, label: string) {
  return page.locator(".app-rail .rail-item", { hasText: label });
}

// J2 (the marquee journey): open the studio, ask the program's `prompt` sensor a
// question, run it on the mock provider, and get a ✓-verified answer back. The mock
// provider gives a byte-stable spine, so this is deterministic.
test("ask a question → a verified answer is delivered", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".app-rail")).toBeVisible(); // the shell mounted

  // The scaffolded project's two agents are listed in the Files explorer.
  await railItem(page, "Files").click();
  await expect(page.getByText("Responder", { exact: false })).toBeVisible();
  await expect(page.getByText("FactChecker", { exact: false })).toBeVisible();

  // The Run space exposes the program's `prompt` sensors (here: `question`) as
  // inputs; fill one and run on the mock provider.
  await railItem(page, "Run").click();
  const question = page.locator(".pj-inp input").first();
  await expect(question).toBeVisible();
  await question.fill("is the earth round?");
  await page.locator(".pj-run-btn").click();

  // The conversation (scoped to the Q&A panel) shows the question and a ✓-verified
  // answer from agape.
  await expect(page.locator(".pj-verified")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".pj-qa").getByText("is the earth round?").first()).toBeVisible();

  // Under the hood, the spine recorded the gate decision and the delivered reply.
  await expect(page.locator(".pj-spine").getByText("Decided", { exact: false }).first()).toBeVisible();
  await expect(page.locator(".pj-spine").getByText("Reply", { exact: false }).first()).toBeVisible();
});

// J3: the studio loads and a run can be launched — the UI stays responsive, never a
// crash. (The static-rejection path itself is asserted in the backend suite.)
test("the studio loads and a run can be launched", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".app-rail")).toBeVisible(); // app loaded
  await railItem(page, "Run").click();
  await expect(page.locator(".pj-run-btn")).toBeEnabled();
});
