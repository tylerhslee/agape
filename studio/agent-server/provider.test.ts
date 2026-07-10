import { describe, it, expect } from "vitest";
import { HashingEmbedder, cosine, parseDecomposition } from "./provider.ts";
import { chunkSpec } from "./learner.ts";

describe("HashingEmbedder (the embed seam)", () => {
  const e = new HashingEmbedder();
  it("is deterministic and L2-normalized", async () => {
    const a = await e.embed("the endorse gate collapses a credence");
    const b = await e.embed("the endorse gate collapses a credence");
    expect(a).toEqual(b);
    expect(cosine(a, a)).toBeCloseTo(1, 5);
    expect(a).toHaveLength(e.dim);
  });
  it("ranks related text above unrelated", async () => {
    const q = await e.embed("how does the endorse gate work");
    const near = cosine(q, await e.embed("endorse gate collapses a credence into a decision"));
    const far = cosine(q, await e.embed("the weather in paris is sunny today"));
    expect(near).toBeGreaterThan(far);
  });
});

describe("parseDecomposition (internalization shape)", () => {
  it("parses clean JSON", () => {
    const d = parseDecomposition('{"facts":[{"key":"a","value":"b"}],"triples":[{"s":"x","p":"is-a","o":"y"}]}');
    expect(d.facts).toEqual([{ key: "a", value: "b" }]);
    expect(d.triples).toEqual([{ s: "x", p: "is-a", o: "y" }]);
  });
  it("recovers JSON wrapped in fences or prose", () => {
    const d = parseDecomposition('Sure!\n```json\n{"facts":[{"key":"k","value":"v"}],"triples":[]}\n```');
    expect(d.facts).toHaveLength(1);
  });
  it("drops malformed entries and never throws", () => {
    expect(parseDecomposition("not json at all")).toEqual({ facts: [], triples: [] });
    const d = parseDecomposition('{"facts":[{"key":"ok","value":"v"},{"nope":1}],"triples":[{"s":"x"}]}');
    expect(d.facts).toEqual([{ key: "ok", value: "v" }]);
    expect(d.triples).toEqual([]);
  });
});

describe("chunkSpec", () => {
  const spec = `# Title\nintro paragraph that is long enough to be kept as a real chunk of content here.\n\n## Section A\n${"a".repeat(120)}\n\n## Tiny\nx\n\n## Section B\n${"b".repeat(120)}\n`;
  it("splits on headings and drops trivially short sections", () => {
    const chunks = chunkSpec(spec);
    const titles = chunks.map((c) => c.title);
    expect(titles).toContain("Section A");
    expect(titles).toContain("Section B");
    expect(titles).not.toContain("Tiny");
  });
  it("honors a max-chunk cap", () => {
    expect(chunkSpec(spec, 1)).toHaveLength(1);
  });
});
