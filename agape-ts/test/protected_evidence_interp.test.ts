import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LocalMemoryDriver } from "../src/memory.js";
import { parse } from "../src/parser.js";
import { FileProtectedEvidenceStore, type JudgmentEvidence } from "../src/protected_evidence.js";
import { MockProvider } from "../src/runtime.js";
import { run } from "./runtime_harness.js";

const PRINCIPAL = "principal:evidence-adversary";
const KEY = Buffer.alloc(32, 0x6c);
const SOURCE = `
enum Verdict { Zebra, Alpha }
agent Auditor {
  on awake {
    Credence<Verdict> evidence = self <- "classify";
    Decision<Verdict> decision = decide evidence by confidence 0.5;
  }
}
spawn Auditor auditor;
awake auditor;
`;

function exactEvidence(
  enumName = "Verdict",
  enumVariants = ["Zebra", "Alpha"],
  scores: Record<string, number> = { Zebra: 0.6, Alpha: 0.4 },
): JudgmentEvidence {
  return {
    version: 1,
    method: "bounded-complete-sequence-logprobs",
    connector: "adversarial-test",
    enum_name: enumName,
    enum_variants: enumVariants,
    candidate_bound: 2,
    candidates: ["Zebra", "Alpha"].map((variant) => ({
      content: variant,
      variant,
      tokens: [{ token: variant, logprob: Math.log(scores[variant]!), bytes: null }],
      aggregate_logprob: Math.log(scores[variant]!),
      aggregate_score: scores[variant]!,
      finish_reason: "stop",
    })),
    mapping_version: "exact-enum-v1",
    normalization_version: "matched-sequence-mass-v1",
    gate_scores: scores,
  };
}

class AdversarialEvidenceProvider extends MockProvider {
  constructor(private readonly suppliedEvidence: JudgmentEvidence) { super(); }
  override async judge() {
    return { scores: { Zebra: 0.6, Alpha: 0.4 }, evidence: this.suppliedEvidence };
  }
}

describe("provider judgment evidence request/result binding", () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  for (const adversary of [
    { name: "wrong enum name", evidence: exactEvidence("OtherVerdict") },
    { name: "reordered variants", evidence: exactEvidence("Verdict", ["Alpha", "Zebra"]) },
    { name: "different score vector", evidence: exactEvidence("Verdict", ["Zebra", "Alpha"], { Zebra: 0.7, Alpha: 0.3 }) },
  ]) {
    it(`fails closed before retaining ${adversary.name}`, async () => {
      root = await mkdtemp(join(tmpdir(), "agape-evidence-binding-"));
      const store = await FileProtectedEvidenceStore.open({ root, key: KEY, authenticatedPrincipal: PRINCIPAL });
      try {
        const retain = vi.spyOn(store, "retain");
        await expect(run(parse(SOURCE), {
          provider: new AdversarialEvidenceProvider(adversary.evidence),
          protectedEvidence: { store, principal: PRINCIPAL },
          memory: new LocalMemoryDriver(),
        })).rejects.toThrow(/evidence does not exactly match the requested enum and resolved gate scores/i);
        expect(retain).not.toHaveBeenCalled();
      } finally {
        await store.close();
      }
    });
  }
});
