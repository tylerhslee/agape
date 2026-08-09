import { afterEach, describe, expect, it } from "vitest";
import {
  createTempProject, eventsOf, fixture, payloadObject, runCli, runDiagnostic, sentinel,
  type TempProject,
} from "./harness.js";
import { chatCompletion, messagesText, OpenAILoopback, twoVariantCandidates } from "./openai-loopback.js";

describe("P04 production explicit-only typed recall", () => {
  let project: TempProject | undefined;
  let loopback: OpenAILoopback | undefined;

  afterEach(async () => {
    await loopback?.close();
    await project?.cleanup();
  });

  it("[P04.explicit-only-recall] supplies protected exact values only after an explicit mem -> query", async () => {
    const factKey = sentinel("P04_FACT_KEY");
    const factAnswer = sentinel("P04_COBALT_ANSWER");
    const fact = `${factKey} resolves to ${factAnswer}`;
    const query = `What does ${factKey} resolve to?`;
    project = await createTempProject(sentinel("p04-project"));

    loopback = new OpenAILoopback(({ body }) => {
      const data = messagesText(body, "user");
      const hasTypedRecall = data.includes(query) && data.includes(fact);
      return {
        body: chatCompletion({
          content: hasTypedRecall ? "Correct" : "Wrong",
          rawCandidates: hasTypedRecall
            ? twoVariantCandidates("Correct", "Wrong", 0.91)
            : twoVariantCandidates("Wrong", "Correct", 0.91),
        }),
      };
    });
    await loopback.start();
    const file = await project.write("main.ag", await fixture("p04/typed_recall.ag.tmpl", { FACT: fact, QUERY: query }));
    const result = await runCli({ project, file, env: loopback.env() });

    expect(result.json?.ok, runDiagnostic(result)).toBe(true);
    expect(loopback.transcript, "P04: explicit store and typed recall must use one production process").toHaveLength(1);
    const request = loopback.transcript[0]!.body;
    const providerData = messagesText(request, "user");
    expect.soft(providerData, "P04: typed recall omitted the query data").toContain(query);
    expect.soft(providerData, "P04: protected exact value never reached typed cognition data").toContain(fact);
    expect.soft(messagesText(request, "system"), "P04: recalled protected content was promoted into instructions")
      .not.toContain(fact);

    const events = eventsOf(result);
    const recalls = events.filter((event) => event.etype === "MemoryConsulted");
    expect.soft(recalls, "P04: source has exactly one explicit mem -> query operation").toHaveLength(1);
    expect.soft(eventsOf(result, "MemoryWriteEvaluated"),
      "P04: explicit store/recall must not imply an automatic memory write").toHaveLength(0);
    const stores = eventsOf(result, "Internalized");
    expect.soft(stores,
      "P04: the explicit constructor store must be the only Internalized receipt; hidden writes are forbidden")
      .toHaveLength(1);

    const storePayload = payloadObject(stores[0]);
    const recallPayload = payloadObject(recalls[0]);
    expect.soft(storePayload).toMatchObject({
      operation: "store",
      write_source: "explicit_store",
      region: "facts",
      generation: 0,
      descriptor_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      schema_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      scope_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      origin_ref: expect.stringMatching(/^memory-origin-v1:[0-9a-f]{64}$/),
      value_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      refs: expect.any(Array),
    });
    expect.soft(recallPayload).toMatchObject({
      descriptor_hash: storePayload.descriptor_hash,
      schema_hash: storePayload.schema_hash,
      scope_hash: storePayload.scope_hash,
      generation: storePayload.generation,
      region: "facts",
      cap: 10,
      hit_hashes: [storePayload.value_hash],
      origins: [storePayload.origin_ref],
      hit_ids: [expect.stringMatching(/^memory-cell-v1:[0-9a-f]{64}$/)],
    });
    const hitId = (recallPayload.hit_ids as unknown[])[0];
    expect.soft(storePayload.refs, "P04: recalled cell was not named by the canonical store receipt")
      .toEqual(expect.arrayContaining([hitId]));
    for (const publicPayload of [storePayload, recallPayload]) {
      expect.soft(JSON.stringify(publicPayload), "P04: public memory receipt leaked protected fact plaintext")
        .not.toContain(fact);
      expect.soft(JSON.stringify(publicPayload), "P04: public memory receipt leaked protected answer plaintext")
        .not.toContain(factAnswer);
    }

    const resolved = events.find((event) => event.etype === "Resolved"
      && payloadObject(event).kind === "credence");
    expect.soft(resolved, "P04: typed recall cognition must close with a Credence Resolved event").toBeTruthy();
    if (recalls[0] && resolved) {
      expect.soft(recalls[0].tick, "P04: MemoryConsulted must precede provider close").toBeLessThan(resolved.tick);
      const scores = payloadObject(resolved).scores as Record<string, number> | undefined;
      expect.soft(scores?.Correct ?? 0, "P04: enum scores must favor Correct from recalled evidence")
        .toBeGreaterThan(scores?.Wrong ?? 1);
    }
  });
});
