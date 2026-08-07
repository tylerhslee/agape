import { describe, expect, it } from "vitest";
import { parse } from "../src/parser.js";
import { run, TEST_AGENT_INSTANCE_ID } from "./runtime_harness.js";
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
    const scope = { project: "test://agape", agentInstanceId: TEST_AGENT_INSTANCE_ID, agentAlias: "reviewer", mem: "examples" };
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

  it("keeps assigned, indexed, and interpolated recalled text private at the send ledger boundary", async () => {
    const provider = new ContextProvider();
    const secret = "private-transform-sentinel";
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
          facts <- "${secret}";
          text[] recalled = facts -> "q";
          text indexed = recalled[0];
          text assigned = indexed;
          text message = f"wrapped \${assigned}";
          Credence<Answer> answer = self <- message;
          Decision<Answer> decision = decide answer by confidence 0.8;
          if (decision.committed == Correct) {
            Endorsement<text> approved = endorse message by decision;
          }
        }
      }

      spawn Rememberer rememberer;
      awake rememberer;
    `), { provider, memory: new LocalMemoryDriver() });

    expect(provider.judgments[0]?.prompt).toContain(secret);
    expect(JSON.stringify(result.ledger.events)).not.toContain(secret);
    const sent = result.ledger.events.find((event) => event.etype === "Sent");
    expect((sent?.payload as Record<string, unknown>)?.prompt).toMatchObject({
      content_hash: expect.any(String),
      protected_ref: expect.stringMatching(/^blob:sha256:/),
    });
    const endorsed = result.ledger.events.find((event) => event.etype === "Endorsed");
    expect(endorsed?.subject).not.toContain(secret);
    expect(((endorsed?.payload as Record<string, any>)?.endorsement?.subject)).toMatchObject({
      content_hash: expect.any(String),
      protected_ref: expect.stringMatching(/^blob:sha256:/),
    });
  });

  it("keeps nested, sliced, piped, function-returned, and binary-derived recalled text private", async () => {
    const provider = new ContextProvider();
    const secret = "private-function-sentinel";
    const result = await run(parse(`
      enum Answer { Correct, Wrong }
      struct SecretBox { body: text }
      pure text relay(text input) { return input + "!"; }

      agent Rememberer {
        mem facts {
          type text;
          modality opaque;
          scope project;
          retention session;
        }
        on awake {
          facts <- "${secret}";
          text[] recalled = facts -> "q";
          SecretBox box = SecretBox { body: recalled[0] };
          text[] nested = [box.body];
          text[] clipped = take(nested, 1);
          text[] piped = clipped |> relay;
          Credence<Answer> answer = self <- piped[0];
        }
      }
      spawn Rememberer rememberer;
      awake rememberer;
    `), { provider, memory: new LocalMemoryDriver() });

    expect(provider.judgments[0]?.prompt).toContain(secret);
    expect(JSON.stringify(result.ledger.events)).not.toContain(secret);
  });

  it("protects private-derived event, tool journal, and result-event fields without hiding structural metadata", async () => {
    const secret = "private-tool-sentinel";
    const result = await run(parse(`
      event Leak(text body);
      event Echoed(text body);
      agent Rememberer {
        mem facts {
          type text;
          modality opaque;
          scope project;
          retention session;
        }
        on awake {
          facts <- "${secret}";
          text[] recalled = facts -> "q";
          emit Leak(recalled[0]);
        }
      }
      spawn Rememberer rememberer;
      awake rememberer;
    `), {
      memory: new LocalMemoryDriver(),
      manifest: {
        provider: { backend: "mock" },
        tools: { echo: { driver: "host" } },
        events: { Leak: { tool: "echo", result_event: "Echoed" } },
      },
      toolHandlers: { echo: ({ args }) => args[0]! },
    });

    expect(JSON.stringify(result.ledger.events)).not.toContain(secret);
    const leak = result.ledger.events.find((event) => event.etype === "Leak");
    const started = result.ledger.events.find((event) => event.etype === "ToolStarted");
    const resolved = result.ledger.events.find((event) => event.etype === "ToolResolved");
    const echoed = result.ledger.events.find((event) => event.etype === "Echoed");
    expect(leak?.payload).toEqual([expect.objectContaining({ protected_ref: expect.stringMatching(/^blob:sha256:/) })]);
    expect(started).toMatchObject({ subject: "echo", payload: { binding: { driver: "host" } } });
    expect((started?.payload as Record<string, unknown>)?.args).toEqual([
      expect.objectContaining({ protected_ref: expect.stringMatching(/^blob:sha256:/) }),
    ]);
    expect((resolved?.payload as Record<string, unknown>)?.result).toMatchObject({
      protected_ref: expect.stringMatching(/^blob:sha256:/),
    });
    expect((echoed?.payload as Record<string, unknown>)?.body).toMatchObject({
      protected_ref: expect.stringMatching(/^blob:sha256:/),
    });
  });

  it("protects private-derived task progress, completion, failure, and contained-crash reasons", async () => {
    const completeSecret = "private-task-complete-sentinel";
    const failSecret = "private-task-fail-sentinel";
    const result = await run(parse(`
      agent CompletingWorker {
        mem facts { type text; modality opaque; scope project; retention session; }
        on assigned {
          facts <- "${completeSecret}";
          text[] recalled = facts -> "q";
          emit TaskProgress(recalled[0]);
          complete recalled[0];
        }
      }
      agent FailingWorker {
        mem facts { type text; modality opaque; scope project; retention session; }
        on assigned {
          facts <- "${failSecret}";
          text[] recalled = facts -> "q";
          fail recalled[0];
        }
      }
      agent Lead grants { reach CompletingWorker, reach FailingWorker } {
        on awake {
          spawn CompletingWorker completing;
          awake completing;
          text completed = completing <- task {
            objective "complete privately";
            acceptance "return one result";
          } expires 10;
          spawn FailingWorker failing;
          awake failing;
          text failed = failing <- task {
            objective "fail privately";
            acceptance "return one failure";
          } expires 10;
        }
      }
      spawn Lead lead;
      awake lead;
    `), { memory: new LocalMemoryDriver() });

    const ledgerJson = JSON.stringify(result.ledger.events);
    expect(ledgerJson).not.toContain(completeSecret);
    expect(ledgerJson).not.toContain(failSecret);
    expect((result.ledger.events.find((event) => event.etype === "TaskProgress")?.payload as Record<string, unknown>)?.note)
      .toMatchObject({ protected_ref: expect.stringMatching(/^blob:sha256:/) });
    expect((result.ledger.events.find((event) => event.etype === "TaskCompleted")?.payload as Record<string, unknown>)?.result)
      .toMatchObject({ protected_ref: expect.stringMatching(/^blob:sha256:/) });
    expect((result.ledger.events.find((event) => event.etype === "TaskFailed")?.payload as Record<string, unknown>)?.reason)
      .toMatchObject({ protected_ref: expect.stringMatching(/^blob:sha256:/) });
    expect((result.ledger.events.find((event) => event.etype === "AgentCrashed")?.payload as Record<string, unknown>)?.reason)
      .toEqual(expect.stringContaining("protected"));
  });

  it("sanitizes connector errors that echo private-memory-derived prompts", async () => {
    const secret = "private-connector-sentinel";
    class EchoingFailureProvider extends ContextProvider {
      override async structured(prompt: string): Promise<unknown> {
        throw new Error(`remote rejected payload: ${prompt}`);
      }
    }
    const result = await run(parse(`
      agent Rememberer {
        mem facts { type text; modality opaque; scope project; retention session; }
        on awake {
          facts <- "${secret}";
          text[] recalled = facts -> "q";
          text answer = self <- f"use \${recalled[0]}";
        }
      }
      spawn Rememberer rememberer;
      awake rememberer;
    `), { provider: new EchoingFailureProvider(), memory: new LocalMemoryDriver() });

    expect(JSON.stringify(result.ledger.events)).not.toContain(secret);
    const crashed = result.ledger.events.find((event) => event.etype === "AgentCrashed");
    expect(crashed?.payload).toMatchObject({ reason: expect.stringContaining("protected") });
  });

  it("protects a recalled external prompt in public warnings while preserving provider input", async () => {
    const provider = new ContextProvider();
    const secret = "private-warning-sentinel";
    const result = await run(parse(`
      prompt text request;
      agent Rememberer {
        mem facts { type text; modality opaque; scope project; retention session; }
        when (Prompt p about request) {
          text remembered = p.text;
          facts <- remembered;
          text[] recalled = facts -> "q";
          text answer = self <- f"use \${recalled[0]}";
        }
      }
      spawn Rememberer rememberer;
      awake rememberer;
    `), {
      provider,
      memory: new LocalMemoryDriver(),
      promptInputs: [{ name: "request", value: secret }],
      manifest: {
        provider: { backend: "mock" },
        security: { tainted_ingress_to_provider: "warn" },
      },
    });

    expect(provider.structuredCalls[0]?.prompt).toContain(secret);
    expect(result.warnings).toHaveLength(1);
    expect(JSON.stringify(result.ledger.events)).not.toContain(secret);
    expect(JSON.stringify(result.warnings)).not.toContain(secret);
    expect((result.warnings[0] as any)?.prompt).toMatchObject({
      content_hash: expect.any(String),
      protected_ref: expect.stringMatching(/^blob:sha256:/),
    });
  });

});
