import { test, expect } from "@playwright/test";

// The studio boots into the "Agape Studio" command surface (MissionControl): a
// wordmark, the Plan/Build/Inspect/Run/Review intents, and a project map built
// from the scaffolded source. Navigation into the Run space happens from the
// quick-actions rail on that surface. serve.mjs copies the repository's
// fact_checker.ag proof application and binds Search to the deterministic mock
// tool, so this tests shipped language source rather than a UI lookalike.

// J1: the studio loads and shows the scaffolded project — the command surface
// mounts and both declared agents from main.ag are surfaced.
test("the studio loads and shows the scaffolded project", async ({ page }) => {
  await page.goto("/");

  // The command surface mounted (wordmark + the intent buttons).
  await expect(page.locator(".agape-wordmark")).toContainText("Agape Studio");
  await expect(page.locator(".agent-intents button", { hasText: "Run" })).toBeVisible();

  // The scaffolded project is reflected: its name heads the surface and both
  // authored proof-app agents show up in the live agent-state panel.
  await expect(page.getByRole("heading", { name: "E2E Fixture" })).toBeVisible();
  await expect(page.locator(".agent-state-row", { hasText: "Chatbot" })).toBeVisible();
  await expect(page.locator(".agent-state-row", { hasText: "Verifier" })).toBeVisible();
});

// J2 (the marquee journey): open the studio, go to the Run space, ask the
// program's `prompt` sensor (`question`) a question, run it on the mock provider,
// and truthfully show the proof app withholding the downstream response when the mock
// chooses the source-invalid Pending outcome.
test("ask the repository fact checker → withheld response is shown truthfully", async ({ page }) => {
  test.setTimeout(60_000); // a run cold-spawns the agape CLI (tsx) subprocess

  await page.goto("/");
  await expect(page.locator(".agape-wordmark")).toContainText("Agape Studio");

  // Select the proof app explicitly; other fixtures may sort before it.
  await page.locator(".agent-quick button", { hasText: "Code" }).click();
  await page.locator(".pj-file", { hasText: "fact_checker.ag" }).click();
  await page.locator(".context-actions button", { hasText: "Run" }).click();

  // The Run panel exposes the program's `prompt` sensors (here: `question`) as
  // inputs; fill one and run on the mock provider.
  const runPanel = page.locator(".pj-run-panel");
  await expect(runPanel).toBeVisible();
  const question = runPanel.locator(".pj-inp input").first();
  await expect(question).toBeVisible();
  await question.fill("is the earth round?");
  await runPanel.locator(".pj-run-btn").click();

  await expect(runPanel).toContainText("fact_checker.ag");
  await expect(page.locator(".pj-spine").getByText("CertificateWithheld", { exact: false }).first()).toBeVisible({ timeout: 45_000 });
  await expect(page.locator(".pj-qa").getByText("is the earth round?").first()).toBeVisible();
  await expect(page.locator(".pj-qa")).toContainText("No certificate-bearing response was emitted.");
  await expect(page.locator(".pj-qa .pj-certificate-state")).toHaveCount(0);
  await expect(page.locator(".pj-certificate .pj-certificate-state").first()).toBeVisible();
  await expect(page.locator(".pj-proof-note")).toContainText("Kernel authorization proof");

  // Under the hood, the ledger records the decision and no publication is invented.
  await expect(page.locator(".pj-spine").getByText("Decided", { exact: false }).first()).toBeVisible();
  await expect(page.locator(".pj-spine").getByText("PublishResponseWithCertificate", { exact: false })).toHaveCount(0);
});

// J11: exercise the shipped Monaco worker/import path and the editor save seam.
test("open Code -> edit and save through Monaco", async ({ page }) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await page.goto("/");
  await expect(page.locator(".agape-wordmark")).toContainText("Agape Studio");
  await page.locator(".agent-quick button", { hasText: "Code" }).click();
  await page.locator(".pj-file", { hasText: "main.ag" }).click();


  const editor = page.locator(".monaco-editor");
  await expect(editor).toBeVisible();
  await expect(editor).toContainText("Responder");
  await expect(editor.locator(".view-lines")).toBeVisible();
  const input = page.getByRole("textbox", { name: "Editor content" });
  await input.focus();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("// monaco runtime smoke");
  await expect(editor).toContainText("// monaco runtime smoke");
  await page.keyboard.press("Control+s");

  await expect.poll(async () => {
    const response = await page.request.get("/project/file?rel=main.ag");
    if (!response.ok()) return "";
    return ((await response.json()) as { body?: string }).body || "";
  }).toContain("// monaco runtime smoke");
  expect(browserErrors).toEqual([]);
});

// J16: a Flow source edit closes the old parsed runtime before writing. The
// replacement session keeps conversation lineage but must parse and execute the
// new source, never the program object retained by the closed session.
test("Run -> Flow edit -> Run closes stale runtime and executes the new source", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/");
  await page.locator(".agent-quick button", { hasText: "Code" }).click();
  await page.locator(".pj-file", { hasText: "main.ag" }).click();
  await page.locator(".context-actions button", { hasText: "Run" }).click();

  const runPanel = page.locator(".pj-run-panel");
  await expect(runPanel).toBeVisible();
  await runPanel.locator(".pj-inp input").first().fill("first run");
  const firstCreatedResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/runtime/sessions" && response.request().method() === "POST";
  });
  await runPanel.locator(".pj-run-btn").click();
  const firstResponse = await firstCreatedResponse;
  const first = await firstResponse.json();
  await expect(page.locator(".pj-spine").first()).toBeVisible({ timeout: 45_000 });
  expect(first.stdout).toContain("fact checker ready");

  await page.locator(".context-actions button", { hasText: "Builder" }).click();
  const program = page.locator(".flow-file-select select");
  await expect(program).toBeVisible();
  await program.selectOption("main.ag");
  const output = page.locator('.flow-node[data-kind="output"]', { hasText: "Say output" }).first();
  await expect(output).toBeVisible();
  await output.click();
  const template = page.locator(".flow-inspector textarea");
  await expect(template).toHaveValue("fact checker ready");
  await template.fill("fresh parser ready");

  const lifecycle: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === `/runtime/sessions/${first.sessionId}/close` && request.method() === "POST") lifecycle.push("close");
    if (url.pathname === "/project/flow" && request.method() === "PUT") lifecycle.push("write");
  });
  const closeResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === `/runtime/sessions/${first.sessionId}/close`
      && response.request().method() === "POST";
  });
  const sourceWrite = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/project/flow" && response.request().method() === "PUT";
  });
  await page.locator(".flow-toolbar-actions .primary").click();
  expect((await closeResponse).ok()).toBe(true);
  expect((await sourceWrite).ok()).toBe(true);
  expect(lifecycle).toEqual(["close", "write"]);
  await expect(page.locator(".flow-banner")).toContainText("Saved to Agape source");

  await page.locator(".context-actions button", { hasText: "Code" }).click();
  await page.locator(".pj-file", { hasText: "main.ag" }).click();
  await page.locator(".context-actions button", { hasText: "Run" }).click();
  const secondCreatedResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/runtime/sessions" && response.request().method() === "POST";
  });
  await page.locator(".pj-run-panel .pj-run-btn").click();
  const secondResponse = await secondCreatedResponse;
  const second = await secondResponse.json();
  const secondRequest = secondResponse.request().postDataJSON();
  expect(second.sessionId).not.toBe(first.sessionId);
  expect(second.conversationId).toBe(first.conversationId);
  expect(second.sessionLineageId).toBe(first.sessionLineageId);
  expect(secondRequest.conversationId).toBe(first.conversationId);
  expect(second.stdout).toContain("fresh parser ready");
  expect(second.stdout).not.toContain("fact checker ready");
  const closed = await page.request.post(`/runtime/sessions/${second.sessionId}/close`, {
    headers: { authorization: `Bearer ${second.accessToken}` },
    data: {},
  });
  expect(closed.ok()).toBe(true);
});

// J17: neither property nor structural Flow edits may abandon a principal
// ruling. Reset fails before PUT, source stays byte-identical, and the property
// draft remains available for the user to finish after resolving the ruling.
test("pending ruling blocks Flow writes and preserves the draft", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/");
  await page.locator(".agent-quick button", { hasText: "Code" }).click();
  await page.locator(".pj-file", { hasText: "attestation.ag" }).click();
  await page.locator(".context-actions button", { hasText: "Run" }).click();
  const runPanel = page.locator(".pj-run-panel");
  await runPanel.locator(".pj-inp input").first().fill("please review this answer");
  await runPanel.locator(".pj-run-btn").click();
  await expect(page.locator(".pj-ruling")).toBeVisible({ timeout: 45_000 });

  const beforeResponse = await page.request.get("/project/file?rel=attestation.ag");
  const before = (await beforeResponse.json()).body;
  let writes = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/project/flow" && request.method() === "PUT") writes++;
  });

  await page.locator(".context-actions button", { hasText: "Builder" }).click();
  await page.locator(".flow-file-select select").selectOption("attestation.ag");
  await expect(page.locator(".flow-file-select select")).toHaveValue("attestation.ag");
  const eventStep = page.locator('.flow-node[data-kind="action"]').filter({
    has: page.locator(".flow-reorder-handle"),
  }).first();
  await expect(eventStep).toBeVisible();
  await eventStep.click();
  await page.locator(".flow-structural-actions button", { hasText: "Remove handoff" }).click();
  await expect(page.locator(".flow-banner.error")).toContainText("pending ruling");

  const model = page.locator('.flow-node[data-kind="model"]', { hasText: "Model: answer" }).first();
  await expect(model).toBeVisible();
  await model.click();
  const instruction = page.locator(".flow-inspector textarea");
  await expect(instruction).toBeVisible();
  const draftValue = "answer the user carefully: ${p.text}";
  await instruction.fill(draftValue);
  await page.locator(".flow-toolbar-actions .primary").click();
  await expect(page.locator(".flow-banner.error")).toContainText("pending ruling");
  await expect(instruction).toHaveValue(draftValue);

  await model.click();
  await expect(page.locator(".flow-inspector textarea")).toHaveValue(draftValue);
  const afterResponse = await page.request.get("/project/file?rel=attestation.ag");
  expect((await afterResponse.json()).body).toBe(before);
  expect(writes).toBe(0);
});
