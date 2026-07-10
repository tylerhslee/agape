// The learning loop: read the spec → internalize it (§10) → retrieve grounded
// context → write Agape → run it → reflect on failures → repeat. Everything the
// agent knows is a fold of its spine memory.

import { Memory } from "./memory.ts";
import type { Cognition } from "./provider.ts";
import type { Runner, RunResult } from "./runner.ts";
import { createHash } from "node:crypto";

export interface SpecChunk {
  title: string;
  text: string;
}
export interface KnowledgeSource {
  kind: string;
  uri: string;
  title: string;
}
export interface RetrieveOptions {
  recordConsult?: boolean;
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
    private agent = "agent"
  ) {}

  // §10 internalization over the spec — each chunk becomes facts + triples + an
  // embedding pinned to its spine event.
  async ingest(
    spec: string,
    maxChunks = 8,
    source: KnowledgeSource = { kind: "spec", uri: "SPEC.md", title: "Agape language specification" }
  ): Promise<{ chunks: number; skipped: number; summary: string; sourceHash: string; counts: any }> {
    const sourceHash = hashText(spec);
    const existing = this.mem.source(this.agent, source.kind, source.uri, sourceHash);
    const summary = existing?.summary || await this.summarizeArtifact(source, spec);
    const sourceState = this.mem.ensureSource(this.agent, source.kind, source.uri, source.title, summary, sourceHash);
    const chunks = chunkSpec(spec, maxChunks);
    let written = 0;
    let skipped = 0;
    for (const c of chunks) {
      const text = c.text.slice(0, 4000);
      const chunkHash = hashText(`${source.kind}\n${source.uri}\n${c.title}\n${text}`);
      if (this.mem.sourceChunk(this.agent, source.kind, source.uri, chunkHash)) {
        skipped++;
        continue;
      }
      const decomp = await this.cog.decompose(`## ${c.title}\n${text}`);
      const tick = await this.mem.internalize(this.agent, "Internalized", c.title, text, decomp, "P");
      this.mem.recordSourceChunk(this.agent, sourceState.source.id, source.kind, source.uri, c.title, chunkHash, tick);
      written++;
    }
    return { chunks: written, skipped, summary, sourceHash, counts: this.mem.counts(this.agent) };
  }

  // Pull grounded context for a task across all three modalities.
  async retrieve(task: string, options: RetrieveOptions = {}) {
    const hits = await this.mem.match(this.agent, task, 0.12, 5);
    const toks = new Set(task.toLowerCase().match(/[a-z_<>-]+/g) || []);
    const triples = this.mem
      .find(this.agent)
      .filter((t) => toks.has(t.s.toLowerCase()) || toks.has(t.o.toLowerCase()))
      .slice(0, 12);
    const lessons = this.mem.select(this.agent, { key: "lesson" });
    const summaries = this.mem.sourceSummaries(this.agent, 4);
    const context = [
      summaries.length ? "Knowledge artifact summaries:\n" + summaries.map((s) => `- ${s.title} (${s.uri}): ${trunc(s.summary, 650)}`).join("\n") : "",
      hits.length ? "Relevant spec passages:\n" + hits.map((h) => `- ${trunc(h.text, 380)} (ledger #${h.origin_tick})`).join("\n") : "",
      triples.length ? "Known relationships:\n" + triples.map((t) => `- ${t.s} —${t.p}→ ${t.o}`).join("\n") : "",
      lessons.length ? "Lessons learned:\n" + lessons.map((l) => `- ${l.value}`).join("\n") : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    const consultTick = options.recordConsult
      ? this.mem.append(
          this.agent,
          "MemoryConsulted",
          task,
          JSON.stringify({
            task,
            summaries: summaries.length,
            hits: hits.map((h) => h.origin_tick),
            triples: triples.length,
            lessons: lessons.length,
          })
        )
      : null;
    return { context, hits, triples, lessons, summaries, consultTick };
  }

  async codingContext(task: string, options: RetrieveOptions = {}) {
    const retrieved = await this.retrieve(task, options);
    const rules = [
      "Every agent turn must consult private memory; an empty memory packet is still a recorded observation.",
      "For implementation work, write or identify tests first, implement against those tests, run checks, then learn from pass/fail evidence.",
      "Prefer `decide ... default ... defer` for application workflows; use `endorse` for lower-level/manual gates.",
      "Bind model testimony as `Credence<E>` over a closed enum, then gate before any consequential sink.",
      "`perform` and write tools need explicit grants plus settled, endorsed inputs.",
      "`prompt` inputs are settled by origin; private `mem ->` recall is always tainted and must be re-gated before action.",
      "`sync` code may emit and collapse in-hand credences, but may not reach provider, principal, memory recall, or tools.",
      "Run `agape check` first, then inspect the ledger with `agape run`.",
    ];
    return {
      task,
      agent: this.agent,
      runner: this.runner.name,
      rules,
      ...retrieved,
      counts: this.mem.counts(this.agent),
    };
  }

  async writeCode(task: string, context: string): Promise<string> {
    const system =
      "You write Agape source code. Output ONLY Agape code — no prose, no fences. " +
      "Write or identify the relevant tests first, then implement against those tests. " +
      "Ground every construct in the provided spec context; if unsure, keep it minimal and correct over clever.";
    const user = `Task: ${task}\n\nGrounded context from memory:\n${context || "(memory empty — write the simplest plausible Agape program)"}`;
    return stripFences(await this.cog.complete(system, [{ role: "user", content: user }], 1200));
  }

  async reflect(task: string, code: string, result: RunResult): Promise<string | null> {
    if (result.ok) {
      await this.mem.internalize(
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
    await this.mem.internalize(
      this.agent,
      "Failed",
      task,
      `Error: ${result.error}`,
      { facts: [{ key: "lesson", value: lesson }], triples: [] },
      "P"
    );
    return lesson;
  }

  async summarizeArtifact(source: KnowledgeSource, text: string): Promise<string> {
    const system =
      "Summarize a knowledge artifact for an Agape agent's persistent private memory. " +
      "Preserve the artifact's purpose, main concepts, constraints, and how it should guide future coding. " +
      "Output one compact paragraph, no bullets, no code fences.";
    const user = `Artifact: ${source.title} (${source.uri})\n\n${text.slice(0, 12000)}`;
    return trunc((await this.cog.complete(system, [{ role: "user", content: user }], 700, 0)).trim(), 1800);
  }

  async internalizeExperience(kind: string, subject: string, text: string, meta: Record<string, unknown> = {}): Promise<number> {
    const status = typeof meta.ok === "boolean" ? (meta.ok ? "passed" : "failed") : "observed";
    const safeSubject = slug(subject);
    const body = [
      `Experience kind: ${kind}`,
      `Subject: ${subject}`,
      `Status: ${status}`,
      Object.keys(meta).length ? `Metadata: ${JSON.stringify(meta)}` : "",
      "",
      text,
    ].filter(Boolean).join("\n");
    return this.mem.internalize(
      this.agent,
      "Experienced",
      subject,
      body,
      {
        facts: [
          { key: "experience", value: `${kind}: ${subject}` },
          { key: `${kind}-status`, value: status },
        ],
        triples: [
          { s: safeSubject, p: "experienced-as", o: kind },
          { s: safeSubject, p: "resulted-in", o: status },
        ],
      },
      "P"
    );
  }

  state() {
    return {
      agent: this.agent,
      runner: this.runner.name,
      counts: this.mem.counts(this.agent),
      lessons: this.mem.select(this.agent, { key: "lesson" }).map((f) => f.value),
    };
  }

  async recall(q: string) {
    return this.mem.match(this.agent, q, 0.1, 8);
  }

  // Full read-only snapshot for the inspector — no cognition, costs nothing.
  inspect(limit = 80) {
    return {
      agent: this.agent,
      runner: this.runner.name,
      counts: this.mem.counts(this.agent),
      spine: this.mem.spineRecent(this.agent, limit),
      facts: this.mem.select(this.agent).slice(-limit),
      triples: this.mem.find(this.agent).slice(-limit),
      embeddings: this.mem.listEmbeddings(this.agent, limit),
      lessons: this.mem.select(this.agent, { key: "lesson" }).map((f) => f.value),
    };
  }

  // One full pass of the loop.
  async step(task: string) {
    const { context, hits, triples, lessons } = await this.retrieve(task, { recordConsult: true });
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

function hashText(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function slug(s: string): string {
  return (s.toLowerCase().match(/[a-z0-9_.-]+/g) || ["experience"]).slice(0, 5).join("-");
}
