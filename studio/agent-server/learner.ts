// The learning loop: read the spec → internalize it (§10) → retrieve grounded
// context → write Agape → run it → reflect on failures → repeat. Everything the
// agent knows is a fold of its spine memory.

import { Memory } from "./memory.ts";
import type { Cognition } from "./provider.ts";
import type { Runner, RunResult } from "./runner.ts";

export interface SpecChunk {
  title: string;
  text: string;
}

// Split the spec on its headings; drop trivially short sections.
export function chunkSpec(spec: string, max = 0): SpecChunk[] {
  const chunks: SpecChunk[] = [];
  let cur: SpecChunk | null = null;
  for (const line of spec.split("\n")) {
    const m = line.match(/^#{1,3}\s+(.*)/);
    if (m) {
      if (cur && cur.text.trim().length > 80) chunks.push(cur);
      cur = { title: m[1].trim(), text: line + "\n" };
    } else if (cur) {
      cur.text += line + "\n";
    }
  }
  if (cur && cur.text.trim().length > 80) chunks.push(cur);
  return max > 0 ? chunks.slice(0, max) : chunks;
}

export class Learner {
  constructor(
    private mem: Memory,
    private cog: Cognition,
    private runner: Runner,
    private agent = "builder"
  ) {}

  // §10 internalization over the spec — each chunk becomes facts + triples + an
  // embedding pinned to its spine event.
  async ingest(spec: string, maxChunks = 8): Promise<{ chunks: number; counts: any }> {
    const chunks = chunkSpec(spec, maxChunks);
    for (const c of chunks) {
      const text = c.text.slice(0, 4000);
      const decomp = await this.cog.decompose(`## ${c.title}\n${text}`);
      this.mem.internalize(this.agent, "Internalized", c.title, text, decomp, "P");
    }
    return { chunks: chunks.length, counts: this.mem.counts(this.agent) };
  }

  // Pull grounded context for a task across all three modalities.
  retrieve(task: string) {
    const hits = this.mem.match(this.agent, task, 0.12, 5);
    const toks = new Set(task.toLowerCase().match(/[a-z_<>-]+/g) || []);
    const triples = this.mem
      .find(this.agent)
      .filter((t) => toks.has(t.s.toLowerCase()) || toks.has(t.o.toLowerCase()))
      .slice(0, 12);
    const lessons = this.mem.select(this.agent, { key: "lesson" });
    const context = [
      hits.length ? "Relevant spec passages:\n" + hits.map((h) => `- ${trunc(h.text, 380)} (spine #${h.origin_tick})`).join("\n") : "",
      triples.length ? "Known relationships:\n" + triples.map((t) => `- ${t.s} —${t.p}→ ${t.o}`).join("\n") : "",
      lessons.length ? "Lessons learned:\n" + lessons.map((l) => `- ${l.value}`).join("\n") : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    return { context, hits, triples, lessons };
  }

  async writeCode(task: string, context: string): Promise<string> {
    const system =
      "You write Agape source code. Output ONLY Agape code — no prose, no fences. " +
      "Ground every construct in the provided spec context; if unsure, keep it minimal and correct over clever.";
    const user = `Task: ${task}\n\nGrounded context from memory:\n${context || "(memory empty — write the simplest plausible Agape program)"}`;
    return stripFences(await this.cog.complete(system, [{ role: "user", content: user }], 1200));
  }

  async reflect(task: string, code: string, result: RunResult): Promise<string | null> {
    if (result.ok) {
      this.mem.internalize(
        this.agent,
        "Worked",
        task,
        `Accepted: ${task}`,
        { facts: [{ key: "working-pattern", value: `${task} → accepted` }], triples: [] },
        "P"
      );
      return null;
    }
    const lesson = (
      await this.cog.complete(
        "Distill ONE reusable lesson (a single sentence) from this Agape error so the next attempt avoids it. Output only the sentence.",
        [{ role: "user", content: `Task: ${task}\n\nCode:\n${code}\n\nError:\n${result.error}` }],
        200
      )
    ).trim();
    this.mem.internalize(
      this.agent,
      "Failed",
      task,
      `Error: ${result.error}`,
      { facts: [{ key: "lesson", value: lesson }], triples: [] },
      "P"
    );
    return lesson;
  }

  state() {
    return {
      agent: this.agent,
      runner: this.runner.name,
      counts: this.mem.counts(this.agent),
      lessons: this.mem.select(this.agent, { key: "lesson" }).map((f) => f.value),
    };
  }

  recall(q: string) {
    return this.mem.match(this.agent, q, 0.1, 6);
  }

  // One full pass of the loop.
  async step(task: string) {
    const { context, hits, triples, lessons } = this.retrieve(task);
    const code = await this.writeCode(task, context);
    const result = await this.runner.run(code);
    const lesson = await this.reflect(task, code, result);
    return {
      task,
      code,
      result,
      lesson,
      retrieved: { hits: hits.length, triples: triples.length, lessons: lessons.length },
      counts: this.mem.counts(this.agent),
    };
  }
}

function trunc(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n) + "…" : flat;
}

function stripFences(s: string): string {
  const m = s.match(/```(?:agape)?\s*([\s\S]*?)```/);
  return (m ? m[1] : s).trim();
}
