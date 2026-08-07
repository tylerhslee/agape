import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTempProject,
  eventsOf,
  fixture,
  payloadObject,
  readTree,
  runCli,
  runDiagnostic,
  sentinel,
  type TempProject,
} from "./harness.js";
import { chatCompletion, messagesText, OpenAILoopback } from "./openai-loopback.js";

interface OriginRef {
  cell_id?: unknown;
  authenticated?: unknown;
  source?: unknown;
  attester?: unknown;
  prompt_name?: unknown;
  payload_hash?: unknown;
  reason?: unknown;
  [key: string]: unknown;
}

function originRefs(event: Parameters<typeof payloadObject>[0]): OriginRef[] {
  const value = payloadObject(event).origin_refs;
  return Array.isArray(value)
    ? value.filter((entry): entry is OriginRef => entry !== null && typeof entry === "object")
    : [];
}

function attestationOf(event: Parameters<typeof payloadObject>[0]): Record<string, unknown> {
  const value = payloadObject(event).attestation;
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

describe("P07 production immutable explicit-memory provenance", () => {
  let project: TempProject | undefined;
  let loopback: OpenAILoopback | undefined;

  afterEach(async () => {
    await loopback?.close();
    await project?.cleanup();
  });

  it("[P07.prompt-origin-recall] preserves an attested prompt origin and marks copied manual metadata unauthenticated", async () => {
    const original = sentinel("P07_ORIGINAL_PRIVATE");
    const manual = sentinel("P07_MANUAL_PRIVATE");
    const query = `Find ${manual} and report its origin`;
    const manualId = `md:${sentinel("P07_MANUAL_ID")}`;
    project = await createTempProject(sentinel("p07-project"));

    const storeFile = await project.write("main.ag", await fixture("p07/prompt_store.ag.tmpl"));
    const stored = await runCli({
      project,
      file: storeFile,
      extraArgs: ["--prompt", `question=${original}`],
    });
    expect(stored.json?.ok, runDiagnostic(stored)).toBe(true);

    const prompt = eventsOf(stored, "Prompt")[0];
    const internalized = eventsOf(stored, "Internalized")[0];
    expect(prompt, "P07: prompt input did not append its attested ingress event").toBeTruthy();
    expect(internalized, "P07: explicit prompt-derived store did not append Internalized").toBeTruthy();
    const attestation = attestationOf(prompt);
    expect.soft(attestation).toMatchObject({
      attester: expect.any(String),
      payload_hash: expect.any(String),
      signature: expect.any(String),
    });
    const genuine = originRefs(internalized).find((ref) => ref.authenticated === true);
    expect.soft(genuine, "P07: explicit store omitted its authenticated prompt origin").toMatchObject({
      authenticated: true,
      source: "prompt",
      attester: attestation.attester,
      prompt_name: "question",
      payload_hash: attestation.payload_hash,
      cell_id: expect.any(String),
    });
    expect.soft(JSON.stringify(internalized), "P07: public Internalized leaked private plaintext")
      .not.toContain(original);

    const memoryRoot = join(project.root, ".agape", "memory");
    const beforeEdit = await readTree(memoryRoot);
    const topicEntry = Object.entries(beforeEdit).find(([path]) =>
      path.includes("/remembered_agent/") && path.endsWith("/notes.md") && !path.includes("/.archive/"));
    expect(topicEntry, "P07: configured Markdown topic was not materialized").toBeTruthy();
    if (!topicEntry) return;

    const copiedProvenance = {
      attester: attestation.attester,
      prompt_name: "question",
      payload_hash: attestation.payload_hash,
      signature: attestation.signature,
    };
    const forgedMetadata = {
      metadata: {
        id: manualId,
        created_at: "2026-01-01T00:00:00.000Z",
        project: "copied-by-editor",
        agent: "remembered_agent",
        mem: "notes",
        provenance: copiedProvenance,
      },
      summary: { kind: "text", trust: "raw", rendered: manual },
    };
    const manualEntry = [
      "",
      "## 2026-01-01T00:00:00.000Z",
      "",
      `<!-- agape-memory-id: ${manualId} -->`,
      "",
      manual,
      "",
      "```json",
      JSON.stringify(forgedMetadata, null, 2),
      "```",
      "",
    ].join("\n");
    await project.write(join(".agape", "memory", topicEntry[0]), topicEntry[1] + manualEntry);

    loopback = new OpenAILoopback(() => ({ body: chatCompletion({ content: "origin observed" }) }));
    await loopback.start();
    const recallFile = await project.write(
      "main.ag",
      await fixture("p07/restart_recall_forget.ag.tmpl", { QUERY: query }),
    );
    const recalled = await runCli({ project, file: recallFile, env: loopback.env() });

    expect(recalled.json?.ok, runDiagnostic(recalled)).toBe(true);
    expect(loopback.transcript, "P07: restart recall did not reach cognition").toHaveLength(1);
    const providerData = messagesText(loopback.transcript[0]!.body, "user");
    expect.soft(providerData, "P07: edited cell was not recalled from the configured driver").toContain(manual);

    const consulted = eventsOf(recalled, "MemoryConsulted").find((event) =>
      payloadObject(event).consult_kind === "explicit_recall");
    expect(consulted, "P07: explicit recall did not append MemoryConsulted").toBeTruthy();
    const consultPayload = payloadObject(consulted);
    expect.soft(consultPayload.hit_ids, "P07: recall omitted the edited cell id")
      .toEqual(expect.arrayContaining([manualId]));
    expect.soft(JSON.stringify(consultPayload), "P07: public recall receipt leaked original private plaintext")
      .not.toContain(original);
    expect.soft(JSON.stringify(consultPayload), "P07: public recall receipt leaked edited private plaintext")
      .not.toContain(manual);

    const refs = originRefs(consulted);
    const copied = refs.find((ref) => ref.cell_id === manualId);
    expect.soft(copied, "P07: recall omitted an origin result for the manually edited cell").toMatchObject({
      cell_id: manualId,
      authenticated: false,
      source: "external_edit",
      reason: expect.stringMatching(/manual|external|unverified|tamper/i),
    });
    const retained = refs.find((ref) =>
      ref.authenticated === true && ref.payload_hash === attestation.payload_hash);
    expect.soft(retained, "P07: restart recall lost the original immutable prompt origin").toMatchObject({
      authenticated: true,
      source: "prompt",
      attester: attestation.attester,
      prompt_name: "question",
      payload_hash: attestation.payload_hash,
    });
    expect.soft(providerData, "P07: cognition did not receive safe origin authentication context")
      .toMatch(/authenticated["']?\s*[:=]\s*true/i);
    expect.soft(providerData, "P07: cognition did not receive the immutable prompt payload hash")
      .toContain(String(attestation.payload_hash));

    const afterForget = await readTree(memoryRoot);
    const liveTopic = Object.entries(afterForget).find(([path]) => path === topicEntry[0]);
    expect.soft(liveTopic?.[1], "P07: forget did not leave an auditable live tombstone").toContain("agape-forgotten");
    expect.soft(liveTopic?.[1], "P07: forgotten live topic retained original plaintext").not.toContain(original);
    expect.soft(liveTopic?.[1], "P07: forgotten live topic retained edited plaintext").not.toContain(manual);
    expect.soft(Object.entries(afterForget).some(([path, contents]) =>
      path.includes("/.archive/") && contents.includes(original) && contents.includes(manual)),
    "P07: configured archive did not preserve the historical bytes behind the forget receipt").toBe(true);
  });
});
