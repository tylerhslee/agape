// Unit tests for the gate seam's logprobs→mass math (no API key needed).
import { describe, it, expect } from "vitest";
import { massFromTopLogprobs } from "./gate.ts";

const ln = Math.log;

describe("massFromTopLogprobs", () => {
  it("reads a bool distribution from token logprobs and renormalizes", () => {
    const dist = massFromTopLogprobs(
      [
        { token: "true", logprob: ln(0.8) },
        { token: "false", logprob: ln(0.2) },
      ],
      ["true", "false"],
    );
    const m = Object.fromEntries(dist);
    expect(m.true).toBeCloseTo(0.8, 5);
    expect(m.false).toBeCloseTo(0.2, 5);
  });

  it("renormalizes over the variant set, ignoring off-set tokens", () => {
    // 0.5 / 0.3 on-set, 0.2 on a stray token → renormalize to 0.5/0.8, 0.3/0.8.
    const dist = massFromTopLogprobs(
      [
        { token: "yes", logprob: ln(0.5) },
        { token: "\n", logprob: ln(0.2) },
        { token: "no", logprob: ln(0.3) },
      ],
      ["yes", "no"],
    );
    const m = Object.fromEntries(dist);
    expect(m.yes).toBeCloseTo(0.5 / 0.8, 5);
    expect(m.no).toBeCloseTo(0.3 / 0.8, 5);
    expect(m.yes + m.no).toBeCloseTo(1, 5);
  });

  it("matches a multi-token label via its distinct leading token (case-insensitive)", () => {
    // 'Contradicts' tokenizes with a leading 'Contrad'; it should still register.
    const dist = massFromTopLogprobs(
      [
        { token: "Contrad", logprob: ln(0.7) },
        { token: "Ent", logprob: ln(0.2) },
        { token: "Neutral", logprob: ln(0.1) },
      ],
      ["Entails", "Contradicts", "Neutral"],
    );
    const m = Object.fromEntries(dist);
    expect(m.Contradicts).toBeCloseTo(0.7, 5);
    expect(m.Entails).toBeCloseTo(0.2, 5);
    expect(m.Neutral).toBeCloseTo(0.1, 5);
  });

  it("returns a uniform distribution when no token matches the variant set", () => {
    const dist = massFromTopLogprobs(
      [{ token: "maybe", logprob: ln(0.9) }],
      ["true", "false"],
    );
    const m = Object.fromEntries(dist);
    expect(m.true).toBeCloseTo(0.5, 5);
    expect(m.false).toBeCloseTo(0.5, 5);
  });
});
