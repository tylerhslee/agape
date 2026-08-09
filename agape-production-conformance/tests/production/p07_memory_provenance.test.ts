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

function attestationOf(event: Parameters<typeof payloadObject>[0]): Record<string, unknown> {
  const value = payloadObject(event).attestation;
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

describe("P07 production canonical-memory provenance", () => {
  let project: TempProject | undefined;
  let loopback: OpenAILoopback | undefined;

  afterEach(async () => {
    await loopback?.close();
    await project?.cleanup();
  });

  it("[P07.prompt-origin-recall] ignores manual derived-Markdown edits and retains canonical origin identity", async () => {
    const original = sentinel("P07_ORIGINAL_PRIVATE");
    const manual = sentinel("P07_MANUAL_PRIVATE");
    const lineage = sentinel("P07_RESUMABLE_LINEAGE");
    project = await createTempProject(sentinel("p07-project"));

    const storeFile = await project.write("main.ag", await fixture("p07/prompt_store.ag.tmpl"));
    const invalidResume = await runCli({
      project,
      file: storeFile,
      extraArgs: ["--session-lineage-id", ""],
    });
    expect.soft(invalidResume.exitCode, "P07: CLI accepted a blank host resume lineage").toBe(2);
    expect.soft(eventsOf(invalidResume), "P07: invalid resume identity produced runtime effects")
      .toHaveLength(0);

    const stored = await runCli({
      project,
      file: storeFile,
      extraArgs: ["--session-lineage-id", lineage, "--prompt", `question=${original}`],
    });
    expect(stored.json?.ok, runDiagnostic(stored)).toBe(true);

    const prompt = eventsOf(stored, "Prompt")[0];
    const internalized = eventsOf(stored, "Internalized")[0];
    expect(prompt, "P07: prompt input did not append its attested ingress event").toBeTruthy();
    expect(internalized, "P07: explicit prompt-derived store did not append Internalized").toBeTruthy();
    expect.soft(attestationOf(prompt)).toMatchObject({
      attester: expect.any(String),
      payload_hash: expect.any(String),
      signature: expect.any(String),
    });
    const storeReceipt = payloadObject(internalized);
    expect.soft(storeReceipt, "P07: explicit store omitted canonical receipt identity").toMatchObject({
      operation: "store",
      write_source: "explicit_store",
      region: "notes",
      generation: 0,
      operation_id: expect.any(String),
      descriptor_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      schema_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      scope_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      origin_ref: expect.any(String),
      value_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect.soft(JSON.stringify(internalized), "P07: public Internalized leaked private plaintext")
      .not.toContain(original);

    const memoryRoot = join(project.root, ".agape", "memory");
    const beforeEdit = await readTree(memoryRoot);
    const topicEntry = Object.entries(beforeEdit).find(([path]) =>
      path.startsWith("regions/") && path.includes("/generation-0/") && path.endsWith("/MEMORY.md"));
    expect(topicEntry, "P07: derived Markdown projection was not materialized").toBeTruthy();
    if (!topicEntry) return;
    expect.soft(topicEntry[1], "P07: derived projection omitted the canonical exact value").toContain(original);

    const copiedAttestation = attestationOf(prompt);
    const manualEntry = [
      "",
      "<!-- Untrusted manual edit with copied attestation: projections are not an import channel. -->",
      `## ${manual}`,
      manual,
      "```json",
      JSON.stringify({
        metadata: {
          provenance: {
            attester: copiedAttestation.attester,
            payload_hash: copiedAttestation.payload_hash,
            signature: copiedAttestation.signature,
          },
        },
      }),
      "```",
      "",
    ].join("\n");
    await project.write(join(".agape", "memory", topicEntry[0]), topicEntry[1] + manualEntry);

    loopback = new OpenAILoopback(() => ({ body: chatCompletion({ content: "canonical origin observed" }) }));
    await loopback.start();
    const recallFile = await project.write(
      "main.ag",
      await fixture("p07/restart_recall_forget.ag.tmpl", { QUERY: `Find ${manual}` }),
    );
    const recalled = await runCli({
      project,
      file: recallFile,
      env: loopback.env(),
      extraArgs: ["--session-lineage-id", lineage],
    });

    expect(recalled.json?.ok, runDiagnostic(recalled)).toBe(true);
    expect(loopback.transcript, "P07: restart recall did not reach cognition").toHaveLength(1);
    const providerData = messagesText(loopback.transcript[0]!.body, "user");
    expect.soft(providerData, "P07: canonical cell was not recalled after restart").toContain(original);
    expect.soft(providerData, "P07: manual projection edit entered canonical recall").not.toContain(manual);

    const consulted = eventsOf(recalled, "MemoryConsulted")[0];
    expect(consulted, "P07: explicit recall did not append MemoryConsulted").toBeTruthy();
    const consultPayload = payloadObject(consulted);
    expect.soft(consultPayload, "P07: recall did not retain canonical store identity").toMatchObject({
      descriptor_hash: storeReceipt.descriptor_hash,
      schema_hash: storeReceipt.schema_hash,
      scope_hash: storeReceipt.scope_hash,
      generation: 0,
      region: "notes",
      origins: [storeReceipt.origin_ref],
      hit_hashes: [storeReceipt.value_hash],
    });
    expect.soft(consultPayload.hit_ids).toEqual([expect.any(String)]);
    const recalledCell = (consultPayload.hit_ids as unknown[])[0];
    expect.soft(storeReceipt.refs, "P07: recalled cell id is not a canonical store reference")
      .toEqual(expect.arrayContaining([recalledCell]));
    expect.soft(JSON.stringify(consultPayload), "P07: public recall receipt leaked original private plaintext")
      .not.toContain(original);
    expect.soft(JSON.stringify(consultPayload), "P07: public recall receipt leaked edited private plaintext")
      .not.toContain(manual);

    const forgotten = eventsOf(recalled, "Forgotten")[0];
    expect.soft(payloadObject(forgotten), "P07: explicit forget did not close the canonical generation")
      .toMatchObject({ operation: "forget", region: "notes", generation: 0 });
    const afterForget = await readTree(memoryRoot);
    const archives = Object.entries(afterForget).filter(([path]) => path.includes("/.archive/") && path.endsWith(".md"));
    expect.soft(archives, "P07: configured forget did not create a canonical archive projection")
      .toHaveLength(1);
    expect.soft(archives[0]?.[1], "P07: archive lost the canonical value").toContain(original);
    expect.soft(archives[0]?.[1], "P07: archive trusted manually edited projection bytes").not.toContain(manual);
  });
});
