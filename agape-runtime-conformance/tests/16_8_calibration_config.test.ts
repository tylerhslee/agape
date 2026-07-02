import { beforeEach, describe, expect, it } from "vitest";
import { loadAdapter } from "../src/loader.js";

const adapter = await loadAdapter();
const suite = adapter ? describe : describe.skip;

suite("SPEC 16.8 and 17 configuration/calibration pipeline", () => {
  beforeEach(async () => {
    await adapter!.reset();
  });

  it("derives exposes_logprobs from provider backend and applies config precedence", async () => {
    const resolved = await adapter!.resolveConfig({
      specDefaults: { provider: { backend: "anthropic", sampling_fallback: true, fallback_samples: 10 } },
      globalConfig: { provider: { backend: "openai", model: "global-model" } },
      projectManifest: { provider: { model: "project-model" } },
      env: { OPENAI_API_KEY: "present" },
    });

    expect((resolved.resolved as any).provider.backend).toBe("openai");
    expect((resolved.resolved as any).provider.model).toBe("project-model");
    expect((resolved.resolved as any).provider.exposes_logprobs).toBe(true);
    expect(resolved.sources["provider.backend"]).toBe("global");
    expect(resolved.sources["provider.model"]).toBe("project");
    expect(resolved.sources["provider.exposes_logprobs"]).toBe("derived");
    expect(JSON.stringify(resolved.resolved)).not.toContain("OPENAI_API_KEY");
  });

  it("uses sampling fallback with at least ten draws when logprobs are unavailable", async () => {
    const result = await adapter!.calibrationScenario({
      gateSite: "FallbackGate",
      enumVariants: ["Yes", "No"],
      provider: { backend: "anthropic", model: "claude-test", exposesLogprobs: false },
      policy: { basis: "threshold", threshold: 0.7 },
      labels: [],
      judgment: { samples: ["Yes", "Yes", "Yes", "Yes", "Yes", "Yes", "Yes", "Yes", "No", "Yes"] },
    });

    expect(result.fallbackDraws).toBeGreaterThanOrEqual(10);
    expect(result.decision.basis).toBe("Threshold");
    expect(result.decision.committed).toBe("Yes");
  });

  it("forms warm conformal prediction sets from the compatible gate-site label pool", async () => {
    const result = await adapter!.calibrationScenario({
      gateSite: "ReviewGate",
      enumVariants: ["Approve", "Reject"],
      provider: { backend: "openai", model: "gpt-test", exposesLogprobs: true },
      policy: { basis: "conformal", alpha: 0.1, readiness: 4 },
      labels: [
        { scores: { Approve: 0.95, Reject: 0.05 }, label: "Approve" },
        { scores: { Approve: 0.9, Reject: 0.1 }, label: "Approve" },
        { scores: { Approve: 0.08, Reject: 0.92 }, label: "Reject" },
        { scores: { Approve: 0.12, Reject: 0.88 }, label: "Reject" },
      ],
      judgment: { scores: { Approve: 0.93, Reject: 0.07 } },
    });

    expect(result.profile.status).toBe("active");
    expect(result.profile.gateSite).toBe("ReviewGate");
    expect(result.decision.basis).toBe("Conformal");
    expect(result.decision.predictionSet).toEqual(["Approve"]);
    expect(result.decision.committed).toBe("Approve");
  });

  it("stales a GateProfile when provider/model/schema/prompt/policy scope changes", async () => {
    const result = await adapter!.calibrationScenario({
      gateSite: "ReviewGate",
      enumVariants: ["Approve", "Reject"],
      provider: { backend: "openai", model: "gpt-test", exposesLogprobs: true },
      policy: { basis: "conformal", alpha: 0.1, readiness: 2 },
      labels: [
        { scores: { Approve: 0.9, Reject: 0.1 }, label: "Approve" },
        { scores: { Approve: 0.1, Reject: 0.9 }, label: "Reject" },
      ],
      judgment: { scores: { Approve: 0.9, Reject: 0.1 } },
      drift: { model: "gpt-other" },
    });

    expect(result.profile.status).toBe("stale");
    expect(result.decision.committed).toBe("abstained");
    expect(result.diagnostics.some((d) => d.category === "ProfileStale")).toBe(true);
  });
});
