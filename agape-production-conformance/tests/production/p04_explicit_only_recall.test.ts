import { afterEach, describe, expect, it } from "vitest";
import { createTempProject, eventsOf, fixture, payloadObject, runCli, runDiagnostic, sentinel, type TempProject } from "./harness.js";
import { chatCompletion, messagesText, OpenAILoopback, twoVariantCandidates } from "./openai-loopback.js";

describe("P04 production explicit-only typed recall", () => {
  let project: TempProject | undefined;
  let loopback: OpenAILoopback | undefined;

  afterEach(async () => {
    await loopback?.close();
    await project?.cleanup();
  });

  it("[P04.explicit-only-recall] supplies protected recalled content to typed cognition only after mem -> query", async () => {
    const factKey = sentinel("P04_FACT_KEY");
    const factAnswer = sentinel("P04_COBALT_ANSWER");
    const fact = `${factKey} resolves to ${factAnswer}`;
    const query = `What does ${factKey} resolve to?`;
    project = await createTempProject(sentinel("p04-project"));
    let requestCellId: string | undefined;

    loopback = new OpenAILoopback(({ body }) => {
      const data = messagesText(body, "user");
      requestCellId = data.match(/\bmd:[A-Za-z0-9._:-]+\b/)?.[0];
      const hasTypedRecall = data.includes(query) && data.includes(fact) && Boolean(requestCellId);
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
    expect.soft(providerData, "P04: protected retrieved content never reached typed cognition data").toContain(fact);
    expect.soft(messagesText(request, "system"), "P04: recalled protected content was promoted into instructions")
      .not.toContain(fact);

    const events = eventsOf(result);
    const explicitRecalls = events.filter((event) => event.etype === "MemoryConsulted"
      && payloadObject(event).consult_kind === "explicit_recall");
    expect.soft(explicitRecalls, "P04: typed mem -> query requires one explicit-recall receipt").toHaveLength(1);
    const automaticConsults = events.filter((event) => event.etype === "MemoryConsulted"
      && payloadObject(event).consult_kind === "automatic_reaction");
    expect.soft(automaticConsults, "P04: an explicit recall must not imply an ambient automatic consultation").toHaveLength(0);
    const automaticEvaluations = events.filter((event) => event.etype === "MemoryWriteEvaluated"
      && (payloadObject(event).closure_kind === "automatic_reaction"
        || payloadObject(event).write_source === "automatic_reaction"));
    expect.soft(automaticEvaluations, "P04: explicit recall must not imply an automatic memory write").toHaveLength(0);
    const automaticWrites = events.filter((event) => event.etype === "Internalized"
      && payloadObject(event).write_source === "automatic_reaction");
    expect.soft(automaticWrites, "P04: only the fixture's explicit store may mutate memory").toHaveLength(0);

    const recalled = explicitRecalls[0];
    if (recalled) {
      const recallPayload = payloadObject(recalled);
      expect(requestCellId, "P04: provider request contained no typed memory cell id").toBeTruthy();
      if (!requestCellId) return;
      expect.soft(recallPayload).toMatchObject({
        consult_kind: "explicit_recall",
        query_hash: expect.any(String),
        budget: expect.anything(),
        empty: false,
        limited: expect.any(Boolean),
        hit_ids: expect.arrayContaining([requestCellId]),
        content_hashes: expect.arrayContaining([expect.any(String)]),
        scores: expect.anything(),
      });
      const publicPayload = JSON.stringify(recallPayload);
      expect.soft(publicPayload, "P04: public MemoryConsulted leaked protected fact plaintext").not.toContain(fact);
      expect.soft(publicPayload, "P04: public MemoryConsulted leaked protected answer plaintext").not.toContain(factAnswer);
    }

    const resolved = events.find((event) => event.etype === "Resolved"
      && payloadObject(event).kind === "credence");
    expect.soft(resolved, "P04: typed recall cognition must close with a Credence Resolved event").toBeTruthy();
    if (recalled && resolved) {
      expect.soft(recalled.tick, "P04: explicit MemoryConsulted must precede the provider close").toBeLessThan(resolved.tick);
      const scores = payloadObject(resolved).gate_scores as Record<string, number> | undefined;
      expect.soft(scores?.Correct ?? 0, "P04: enum gate scores must favor Correct only from recalled evidence")
        .toBeGreaterThan(scores?.Wrong ?? 1);
    }
  });
});
