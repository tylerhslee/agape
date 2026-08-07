import { describe, expect, it } from "vitest";
import { parse } from "../src/parser.js";
import { run } from "../src/interp.js";
import { LocalMemoryDriver } from "../src/memory.js";
import {
  MockProvider,
  type CognitionContext,
  type StructuredSchema,
  type Variant,
} from "../src/runtime.js";

class ContextProvider extends MockProvider {
  replies: Array<{ prompt: string; context?: CognitionContext }> = [];
  judgments: Array<{ prompt: string; context?: CognitionContext }> = [];
  structuredCalls: Array<{ prompt: string; context?: CognitionContext }> = [];

  override async reply(prompt: string, context?: CognitionContext): Promise<string> {
    this.replies.push({ prompt, context });
    return "ok";
  }

  override async structured(prompt: string, _schema: StructuredSchema, _name?: string, context?: CognitionContext): Promise<unknown> {
    this.structuredCalls.push({ prompt, context });
    return "ok";
  }

  override async judge(
    prompt: string,
    _enumName: string,
    variants: Variant[],
    context?: CognitionContext,
  ): Promise<{ scores: Record<Variant, number> }> {
    this.judgments.push({ prompt, context });
    return { scores: Object.fromEntries(variants.map((variant, index) => [variant, index === 0 ? 0.9 : 0.1])) };
  }
}

describe("provider-neutral cognition context", () => {
  it("composes global and inherited instructions once while retaining delegated task data", async () => {
    const provider = new ContextProvider();
    await run(parse(`
      instruction "global guardrail";

      agent Parent {
        instruction "parent guardrail";
      }

      agent Worker {
        extend Parent();
        instruction "worker guardrail";
        on assigned {
          text answer = self <- "worker stimulus";
          complete answer;
        }
      }

      agent Lead grants { reach Worker } {
        on awake {
          spawn Worker worker;
          awake worker;
          text result = worker <- task {
            objective "objective data";
            acceptance "acceptance data";
          } expires 10;
        }
      }

      spawn Lead lead;
      awake lead;
    `), { provider, memory: new LocalMemoryDriver() });

    expect(provider.structuredCalls).toHaveLength(1);
    const context = provider.structuredCalls[0]!.context!;
    expect(context.instructions.filter((item) => item === "global guardrail")).toHaveLength(1);
    expect(context.instructions.filter((item) => item === "parent guardrail")).toHaveLength(1);
    expect(context.instructions.filter((item) => item === "worker guardrail")).toHaveLength(1);
    expect(context.instructions.indexOf("global guardrail")).toBeLessThan(context.instructions.indexOf("parent guardrail"));
    expect(context.instructions.indexOf("parent guardrail")).toBeLessThan(context.instructions.indexOf("worker guardrail"));
    expect(context.instructions.join("\n")).not.toContain("objective data");
    expect(context.data).toContainEqual({ kind: "stimulus", content: "worker stimulus" });
    expect(context.data).toContainEqual({
      kind: "task",
      objective: "objective data",
      acceptance: "acceptance data",
    });
  });

  it("passes recalled content only through an explicit send while keeping the consult receipt plaintext-free", async () => {
    const provider = new ContextProvider();
    const fact = "cobalt-key resolves to cobalt-answer";
    const result = await run(parse(`
      enum Answer { Correct, Wrong }

      agent Rememberer {
        mem facts {
          type text;
          modality opaque;
          scope project;
          retention session;
        }
        on awake {
          facts <- "${fact}";
          text[] hits = facts -> "what does cobalt-key resolve to?";
          Credence<Answer> answer = self <- f"answer from recalled facts: \${hits}";
        }
      }

      spawn Rememberer rememberer;
      awake rememberer;
    `), { provider, memory: new LocalMemoryDriver() });

    expect(provider.judgments).toHaveLength(1);
    const context = provider.judgments[0]!.context!;
    const stimulus = context.data.find((segment) => segment.kind === "stimulus");
    expect(stimulus).toMatchObject({ kind: "stimulus", content: expect.stringContaining(fact) });
    expect(context.data.find((segment) => segment.kind === "recalled_memory")).toBeUndefined();

    const consultation = result.ledger.events.find((event) =>
      event.etype === "MemoryConsulted"
      && (event.payload as Record<string, unknown>)?.consult_kind === "explicit_recall");
    expect(consultation).toBeTruthy();
    expect(JSON.stringify(consultation?.payload)).not.toContain(fact);
    const resolved = result.ledger.events.find((event) => event.etype === "Resolved");
    expect(resolved?.payload).toMatchObject({ kind: "credence", scores: expect.any(Object) });
    expect(resolved?.payload).not.toHaveProperty("evidence_ref");
    expect(JSON.stringify(resolved?.payload)).not.toContain(fact);
    expect(JSON.stringify(result.ledger.events)).not.toContain(fact);
    const sent = result.ledger.events.find((event) => event.etype === "Sent");
    const sentPrompt = (sent?.payload as Record<string, unknown>)?.prompt;
    expect(sentPrompt).toMatchObject({
      content_hash: expect.any(String),
      protected_ref: expect.stringMatching(/^blob:sha256:/),
      redaction_policy_hash: expect.any(String),
    });
    expect((resolved?.payload as Record<string, unknown>)?.prompt).toEqual(sentPrompt);
    expect((resolved?.payload as Record<string, unknown>)?.reply).toMatchObject({
      content_hash: expect.any(String),
      protected_ref: expect.stringMatching(/^blob:sha256:/),
      redaction_policy_hash: expect.any(String),
    });
  });
  it("preserves typed outcome labels and provenance for recalled counterexamples", async () => {
    const provider = new ContextProvider();
    const memory = new LocalMemoryDriver();
    const scope = { project: "demo", agent: "reviewer", mem: "examples" };
    await memory.declare(scope);
    await memory.internalize({
      scope,
      value: {
        kind: "struct",
        typeName: "DraftMemory",
        fields: new Map([
          ["outcome", { kind: "enumval", enumName: "Outcome", variant: "Rejected", trust: "settled" }],
          ["draft", { kind: "text", v: "counterexample draft", trust: "raw" }],
        ]),
        trust: "raw",
      },
      memory: "counterexample draft",
      summary: {
        kind: "struct",
        type: "DraftMemory",
        trust: "raw",
        fields: {
          outcome: { kind: "enumval", enum: "Outcome", variant: "Rejected", trust: "settled" },
          draft: { kind: "text", value: "counterexample draft", trust: "raw" },
        },
      },
      metadata: {
        provenance: { attester: "review-ledger", prompt_name: "review-result" },
      },
    });

    const result = await run(parse(`
      enum Usefulness { Useful, NotUseful }
      enum Outcome { Accepted, Rejected }
      struct DraftMemory { outcome: Outcome, draft: text }
      agent Reviewer {
        mem examples {
          type DraftMemory;
          modality episodic;
          scope project;
          retention session;
        }
        on awake {
          DraftMemory[] hits = examples -> "find prior rejected drafts";
          Credence<Usefulness> result = self <- f"judge recalled counterexamples: \${hits}";
        }
      }
      spawn Reviewer reviewer;
      awake reviewer;
    `), {
      provider,
      memory,
      manifest: { provider: { backend: "mock" }, project: { name: "demo" } },
    });

    const context = provider.judgments[0]!.context!;
    const stimulus = context.data.find((segment) => segment.kind === "stimulus");
    expect(stimulus).toMatchObject({ kind: "stimulus", content: expect.stringContaining("counterexample draft") });
    expect(stimulus).toMatchObject({ content: expect.stringContaining("Rejected") });
    expect(context.data.find((segment) => segment.kind === "recalled_memory")).toBeUndefined();
    expect(JSON.stringify(result.ledger.events)).not.toContain("counterexample draft");
    expect(JSON.stringify(result.ledger.events)).not.toContain("Rejected");
  });

});
