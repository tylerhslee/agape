import { afterEach, describe, expect, it } from "vitest";
import {
  createTempProject, eventsOf, fixture, payloadObject, runCli, runDiagnostic, sentinel,
  type TempProject,
} from "./harness.js";
import { chatCompletion, messagesText, OpenAILoopback, twoVariantCandidates } from "./openai-loopback.js";

describe("P04 production typed recall", () => {
  let project: TempProject | undefined;
  let loopback: OpenAILoopback | undefined;

  afterEach(async () => {
    await loopback?.close();
    await project?.cleanup();
  });

  it("[P04.typed-recall] preserves exact typed values while storage identity stays runtime-derived", async () => {
    const factKey = sentinel("P04_FACT_KEY");
    const factAnswer = sentinel("P04_COBALT_ANSWER");
    const fact = `${factKey} resolves to ${factAnswer}`;
    const query = `What does ${factKey} resolve to?`;
    project = await createTempProject(sentinel("p04-project"));

    loopback = new OpenAILoopback(({ body }) => {
      const data = messagesText(body, "user");
      const noStorageEnvelope = !/memory-(?:cell|origin|operation|region)-v1:/i.test(data);
      const hasTypedEvidence = data.includes(query) && data.includes(fact) && noStorageEnvelope;
      return {
        body: chatCompletion({
          content: hasTypedEvidence ? "Correct" : "Wrong",
          rawCandidates: hasTypedEvidence
            ? twoVariantCandidates("Correct", "Wrong", 0.91)
            : twoVariantCandidates("Wrong", "Correct", 0.91),
        }),
      };
    });
    await loopback.start();
    const file = await project.write("main.ag", await fixture("p04/typed_recall.ag.tmpl", { FACT: fact, QUERY: query }));
    const result = await runCli({ project, file, env: loopback.env() });

    expect(result.json?.ok, runDiagnostic(result)).toBe(true);
    expect(loopback.transcript, "P04: explicit constructor store and typed recall must use one process").toHaveLength(1);
    const request = loopback.transcript[0]!.body;
    const providerData = messagesText(request, "user");
    expect.soft(providerData, "P04: typed recall omitted the query").toContain(query);
    expect.soft(providerData, "P04: typed recall did not preserve the exact protected text value").toContain(fact);
    expect.soft(providerData, "P04: storage envelope identifiers leaked into the recalled source value")
      .not.toMatch(/memory-(?:cell|origin|operation|region)-v1:/i);
    expect.soft(messagesText(request, "system"), "P04: recalled protected content was promoted into instructions")
      .not.toContain(fact);

    const stores = eventsOf(result, "Internalized");
    const recalls = eventsOf(result, "MemoryConsulted");
    expect.soft(stores, "P04: exactly one explicit typed value must be stored").toHaveLength(1);
    expect.soft(recalls, "P04: exactly one explicit typed recall must run").toHaveLength(1);
    expect.soft(eventsOf(result, "MemoryWriteEvaluated"), "P04: no implicit write evaluation may run")
      .toHaveLength(0);
    const storePayload = payloadObject(stores[0]);
    const recallPayload = payloadObject(recalls[0]);
    const hitIds = Array.isArray(recallPayload.hit_ids) ? recallPayload.hit_ids : [];
    expect.soft(hitIds).toHaveLength(1);
    expect.soft(storePayload.refs, "P04: recall hit must be a canonical store ref")
      .toEqual(expect.arrayContaining(hitIds));
    expect.soft(recallPayload).toMatchObject({
      descriptor_hash: storePayload.descriptor_hash,
      schema_hash: storePayload.schema_hash,
      scope_hash: storePayload.scope_hash,
      generation: storePayload.generation,
      hit_hashes: [storePayload.value_hash],
      origins: [storePayload.origin_ref],
      retrieval: { algorithm: expect.any(String), version: expect.any(Number) },
    });
    for (const id of [storePayload.operation_id, storePayload.origin_ref, ...hitIds]) {
      expect.soft(id, "P04: canonical runtime identity is not opaque and domain-separated")
        .toMatch(/^memory-(?:operation|origin|cell)-v1:[0-9a-f]{64}$/);
    }
    expect.soft(JSON.stringify(recallPayload), "P04: public MemoryConsulted leaked protected plaintext")
      .not.toContain(fact);

    const resolved = eventsOf(result, "Resolved").find((event) => payloadObject(event).kind === "credence");
    expect.soft(resolved, "P04: typed recall cognition must close with judgment evidence").toBeTruthy();
    if (recalls[0] && resolved) {
      expect.soft(recalls[0].tick).toBeLessThan(resolved.tick);
      const resolvedPayload = payloadObject(resolved);
      const scores = resolvedPayload.scores as Record<string, number> | undefined;
      expect.soft(scores?.Correct ?? 0).toBeGreaterThan(scores?.Wrong ?? 1);
      expect.soft(resolvedPayload).toMatchObject({
        prompt: { content_hash: expect.stringMatching(/^[0-9a-f]{64}$/), protected_ref: expect.any(String) },
        reply: { content_hash: expect.stringMatching(/^[0-9a-f]{64}$/), protected_ref: expect.any(String) },
        top: { variant: "Correct", score: expect.any(Number) },
      });
    }
  });
});
