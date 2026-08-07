import { afterEach, describe, expect, it } from "vitest";
import { createTempProject, eventsOf, fixture, payloadObject, runCli, runDiagnostic, sentinel, type TempProject } from "./harness.js";
import { chatCompletion, messagesText, OpenAILoopback, twoVariantCandidates } from "./openai-loopback.js";

function distinctiveOriginTokens(value: unknown): string[] {
  if (typeof value === "string") {
    return value.match(/(?:protected|sha256|origin|tick|event|md):[A-Za-z0-9._:-]{4,}|[a-f0-9]{32,}/gi) ?? [];
  }
  if (Array.isArray(value)) return value.flatMap(distinctiveOriginTokens);
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap(distinctiveOriginTokens);
  }
  return [];
}

describe("P04 production typed recall", () => {
  let project: TempProject | undefined;
  let loopback: OpenAILoopback | undefined;

  afterEach(async () => {
    await loopback?.close();
    await project?.cleanup();
  });

  it("[P04.typed-recall] judges protected retrieved content and provenance in one process and one agent", async () => {
    const factKey = sentinel("P04_FACT_KEY");
    const factAnswer = sentinel("P04_COBALT_ANSWER");
    const fact = `${factKey} resolves to ${factAnswer}`;
    const query = `What does ${factKey} resolve to?`;
    project = await createTempProject(sentinel("p04-project"));
    let requestCellId: string | undefined;
    let requestOriginMarkers: string[] = [];

    loopback = new OpenAILoopback(({ body }) => {
      const data = messagesText(body, "user");
      requestCellId = data.match(/\bmd:[A-Za-z0-9._:-]+\b/)?.[0];
      requestOriginMarkers = data.match(/(?:protected|sha256|origin|tick|event|md):[A-Za-z0-9._:-]{4,}|[a-f0-9]{32,}/gi) ?? [];
      const hasNonCellOriginMarker = requestOriginMarkers.some((marker) => !marker.toLowerCase().startsWith("md:"));
      const hasTypedEvidence = data.includes(query) && data.includes(fact)
        && Boolean(requestCellId) && hasNonCellOriginMarker;
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
    expect(loopback.transcript, "P04: explicit constructor store and typed recall must use one production process").toHaveLength(1);
    const request = loopback.transcript[0]!.body;
    const providerData = messagesText(request, "user");
    expect.soft(providerData, "P04: typed recall omitted the query data").toContain(query);
    expect.soft(providerData, "P04: typed recall sent only the query; protected retrieved content never reached cognition")
      .toContain(fact);
    expect.soft(messagesText(request, "system"), "P04: recalled protected content was promoted into instructions")
      .not.toContain(fact);

    const events = eventsOf(result);
    const automaticConsults = events.filter((event) => event.etype === "MemoryConsulted"
      && payloadObject(event).consult_kind === "automatic_reaction");
    const explicitRecalls = events.filter((event) => event.etype === "MemoryConsulted"
      && payloadObject(event).consult_kind === "explicit_recall");
    expect.soft(automaticConsults, "P04: awake reaction requires its separate automatic consultation").toHaveLength(1);
    expect.soft(explicitRecalls, "P04: typed mem -> query requires one explicit-recall consultation").toHaveLength(1);
    const recalled = explicitRecalls[0];
    if (automaticConsults[0] && recalled) {
      const automaticPayload = payloadObject(automaticConsults[0]);
      const recallPayload = payloadObject(recalled);
      expect(requestCellId, "P04: provider request contained no typed memory cell id").toBeTruthy();
      if (!requestCellId) return;
      const hitIds = Array.isArray(recallPayload.hit_ids) ? recallPayload.hit_ids : [];
      expect.soft(hitIds, "P04: explicit recall hit ids must include the exact cell id sent to cognition")
        .toContain(requestCellId);
      const originTokens = distinctiveOriginTokens(recallPayload.origin_refs);
      expect.soft(originTokens, "P04: explicit recall must expose at least one distinctive origin hash/ref token")
        .not.toHaveLength(0);
      for (const token of originTokens) {
        expect.soft(providerData, "P04: recalled origin token was not supplied to cognition: " + token).toContain(token);
        expect.soft(requestOriginMarkers, "P04: loopback did not recognize recalled origin marker: " + token).toContain(token);
      }
      expect.soft(recallPayload.reaction_event, "P04: explicit recall must correlate to the enclosing reaction")
        .toBe(automaticPayload.reaction_event);
      expect.soft(recallPayload).toMatchObject({
        consult_kind: "explicit_recall",
        reaction_event: expect.any(Number),
        query_hash: expect.any(String),
        budget: expect.anything(),
        empty: false,
        limited: expect.any(Boolean),
        hit_ids: expect.arrayContaining([requestCellId]),
        content_hashes: expect.arrayContaining([expect.any(String)]),
        scores: expect.anything(),
        origin_refs: expect.arrayContaining([expect.anything()]),
      });
      const publicPayload = JSON.stringify(recallPayload);
      expect.soft(publicPayload, "P04: public MemoryConsulted leaked protected fact plaintext").not.toContain(fact);
      expect.soft(publicPayload, "P04: public MemoryConsulted leaked protected answer plaintext").not.toContain(factAnswer);
    }

    const resolved = events.find((event) => event.etype === "Resolved"
      && payloadObject(event).kind === "credence");
    expect.soft(resolved, "P04: typed recall cognition must close with JudgmentEvidence-linked Resolved").toBeTruthy();
    if (recalled && resolved) {
      expect.soft(recalled.tick, "P04: explicit MemoryConsulted must precede the provider close").toBeLessThan(resolved.tick);
      const resolvedPayload = payloadObject(resolved);
      const scores = resolvedPayload.gate_scores as Record<string, number> | undefined;
      expect.soft(scores?.Correct ?? 0, "P04: enum gate scores must favor Correct only from recalled evidence")
        .toBeGreaterThan(scores?.Wrong ?? 1);
      expect.soft(resolvedPayload).toMatchObject({
        evidence_id: expect.any(String),
        evidence_hash: expect.any(String),
        evidence_ref: expect.any(String),
      });
    }
  });
});
