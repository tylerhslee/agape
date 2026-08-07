import { describe, expect, it } from "vitest";
import { parse } from "../src/parser.js";
import { createAdapter } from "../src/runtime_adapter.js";
import { canonicalLedgerHead } from "../src/ledger_hash.js";
import { MockProvider, type LedgerEvent } from "../src/runtime.js";
import { LocalMemoryDriver } from "../src/memory.js";
import { run as runtimeRun } from "./runtime_harness.js";

function run(program: Parameters<typeof runtimeRun>[0], opts: Parameters<typeof runtimeRun>[1] = {}) {
  return runtimeRun(program, { ...opts, memory: opts.memory ?? new LocalMemoryDriver() });
}

function requireLifecycle(
  events: readonly LedgerEvent[],
  subject: string,
  etypes: readonly string[],
): LedgerEvent[] {
  return etypes.map((etype) => {
    const event = events.find((candidate) => candidate.etype === etype && candidate.subject === subject);
    expect(event, `missing ${etype}(${subject})`).toBeDefined();
    return event!;
  });
}

function expectOneCorrelation(events: readonly { corr?: string | number | null }[]): string | number {
  const corr = events[0]?.corr;
  expect(corr).not.toBeNull();
  expect(corr).not.toBeUndefined();
  for (const event of events) expect(event.corr).toBe(corr);
  return corr!;
}

describe("SPEC 16.2 runtime-produced lifecycle correlations", () => {
  const SEND_SOURCE = `
    agent Worker { }
    agent Lead grants { reach Worker } {
      on awake {
        spawn Worker worker;
        awake worker;
        text selfReply = self <- "self ping";
        text agentReply = worker <- "agent ping";
        say(selfReply);
        say(agentReply);
      }
    }
    spawn Lead lead;
    awake lead;
  `;

  it("gives each ordinary self/agent send one non-null Sent/Delivered/Resolved correlation and preserves it through adapter projection", async () => {
    const core = await run(parse(SEND_SOURCE));
    expect(core.ledger.head()).toBe(canonicalLedgerHead(core.ledger.events));

    for (const subject of ["selfReply", "agentReply"]) {
      expectOneCorrelation(requireLifecycle(core.ledger.events, subject, ["Sent", "Delivered", "Resolved"]));
    }

    const projected = await createAdapter().run({ source: SEND_SOURCE });
    expect(projected.ok).toBe(true);
    expect(projected.headHash).toBe(canonicalLedgerHead(projected.events));
    for (const subject of ["selfReply", "agentReply"]) {
      const coreCorr = expectOneCorrelation(
        requireLifecycle(core.ledger.events, subject, ["Sent", "Delivered", "Resolved"]),
      );
      const projectedCorr = expectOneCorrelation(
        requireLifecycle(projected.events as LedgerEvent[], subject, ["Sent", "Delivered", "Resolved"]),
      );
      expect(projectedCorr).toBe(coreCorr);
    }
  });

  it("gives repeated ordinary sends from one prompt handler distinct opening-tick correlations", async () => {
    const result = await run(parse(`
      prompt text request;
      agent Bot {
        when (Prompt p about request) {
          text answer = self <- p.text;
        }
      }
      spawn Bot bot;
      awake bot;
    `), {
      promptInputs: [
        { name: "request", value: "first" },
        { name: "request", value: "second" },
      ],
    });

    const sent = result.ledger.events.filter((event) => event.etype === "Sent" && event.subject === "answer");
    expect(sent).toHaveLength(2);
    expect(sent.map((event) => event.corr)).toEqual(sent.map((event) => event.tick));
    expect(new Set(sent.map((event) => event.corr)).size).toBe(2);
    for (const opening of sent) {
      const lifecycle = result.ledger.events
        .filter((event) => event.subject === "answer" && event.corr === opening.corr)
        .map((event) => event.etype);
      expect(lifecycle).toEqual(["Sent", "Delivered", "Resolved"]);
    }
  });

  it("uses the declared task correlation for progress and successful terminal receipts", async () => {
    const result = await run(parse(`
      agent Worker {
        on assigned {
          emit TaskProgress("working");
          complete 42;
        }
      }
      agent Lead grants { reach Worker } {
        on awake {
          spawn Worker worker;
          awake worker;
          int job = worker <- task {
            objective "produce the number";
            acceptance "return an int";
          } expires 10;
          say(job);
        }
      }
      spawn Lead lead;
      awake lead;
    `));

    expect(result.ledger.head()).toBe(canonicalLedgerHead(result.ledger.events));
    expectOneCorrelation(requireLifecycle(
      result.ledger.events,
      "job",
      ["Sent", "Delivered", "TaskProgress", "Resolved", "TaskCompleted"],
    ));
  });

  it("gives repeated tool invocations distinct stable start/resolve correlations", async () => {
    const result = await run(parse(`
      action Search(text query);
      agent Researcher grants { perform Search } {
        on awake {
          perform Search("agape");
          perform Search("runtime");
        }
      }
      spawn Researcher researcher;
      awake researcher;
    `), {
      manifest: {
        provider: { backend: "mock" },
        tools: { search: { driver: "host" } },
        actions: { Search: { tool: "search" } },
      },
      toolHandlers: { search: async () => "evidence" },
    });

    const started = result.ledger.events.filter((event) => event.etype === "ToolStarted");
    const resolved = result.ledger.events.filter((event) => event.etype === "ToolResolved");
    expect(started).toHaveLength(2);
    expect(resolved).toHaveLength(2);
    expect(started[0]!.corr).toBe(started[0]!.tick);
    expect(started[1]!.corr).toBe(started[1]!.tick);
    expect(resolved[0]!.corr).toBe(started[0]!.corr);
    expect(resolved[1]!.corr).toBe(started[1]!.corr);
    expect(started[1]!.corr).not.toBe(started[0]!.corr);
    expect(result.ledger.head()).toBe(canonicalLedgerHead(result.ledger.events));
  });

  it("correlates a pending principal decision and its terminal ruling to the pending tick", async () => {
    const result = await run(parse(`
      enum Approval { Approve, Decline }
      principal alice;
      agent Clerk {
        on awake {
          Credence<Approval> c = self <- "assess the request";
          Decision<Approval> d = alice decide c by conformal 0.05;
          if (d.committed == Approve) { emit Event("approved"); }
          else { emit Event("not approved"); }
        }
      }
      spawn Clerk clerk;
      awake clerk;
    `), {
      provider: new MockProvider(() => ({ Approve: 0.9, Decline: 0.1 })),
      principal: "grant",
    });

    const pending = result.ledger.events.find((event) => event.etype === "PendingPrincipalDecision");
    const ruling = result.ledger.events.find((event) => event.etype === "PrincipalDecision");
    expect(pending).toBeDefined();
    expect(ruling).toBeDefined();
    expect(pending!.corr).toBe(pending!.tick);
    expect(ruling!.corr).toBe(pending!.tick);
    expect((ruling!.payload as { pending?: number }).pending).toBe(pending!.tick);
    expect(result.ledger.head()).toBe(canonicalLedgerHead(result.ledger.events));
  });

  it("correlates a failed principal terminal to its pending tick", async () => {
    const result = await run(parse(`
      enum Approval { Approve, Decline }
      principal alice;
      agent Clerk {
        on awake {
          Credence<Approval> c = self <- "assess";
          Decision<Approval> d = alice decide c by conformal 0.05;
        }
      }
      spawn Clerk clerk; awake clerk;
    `), {
      provider: new MockProvider(() => ({ Approve: 0.9, Decline: 0.1 })),
      principal: "deny",
    });
    const pending = result.ledger.events.find((event) => event.etype === "PendingPrincipalDecision")!;
    const failed = result.ledger.events.find((event) => event.etype === "FailedPrincipalDecision")!;
    expect(pending.corr).toBe(pending.tick);
    expect(failed.corr).toBe(pending.tick);
    expect((failed.payload as { pending?: number }).pending).toBe(pending.tick);
  });

  it("gives late DeliveryRefused its own tick correlation and records the expired send correlation", async () => {
    const result = await run(parse(`
      agent Worker {}
      agent Sender grants { reach Worker } {
        on awake {
          spawn Worker worker;
          null reply = worker <- "late" expires 1;
          awake worker;
        }
      }
      spawn Sender sender; awake sender;
    `));
    const sent = result.ledger.events.find((event) => event.etype === "Sent" && event.subject === "reply")!;
    const expired = result.ledger.events.find((event) => event.etype === "Expired" && event.subject === "reply")!;
    const refused = result.ledger.events.find((event) => event.etype === "DeliveryRefused")!;
    expect(expired.corr).toBe(sent.corr);
    expect(refused.corr).toBe(refused.tick);
    expect(refused.corr).not.toBe(sent.corr);
    expect((refused.payload as { original_corr?: string | number }).original_corr).toBe(sent.corr);
  });

  it("gives CompletionRefused its own tick correlation and records the cancelled task correlation", async () => {
    const result = await run(parse(`
      agent Worker {
        on assigned { emit TaskProgress("working"); complete 1; }
      }
      agent Lead grants { reach Worker } {
        on awake {
          spawn Worker worker; awake worker;
          Task<int> job = worker <- task {
            objective "work";
            acceptance "an int";
          } expires 10;
          when (TaskProgress p about job) { cancel job; }
        }
      }
      spawn Lead lead; awake lead;
    `));
    const sent = result.ledger.events.find((event) => event.etype === "Sent" && event.subject === "job")!;
    const refused = result.ledger.events.find((event) => event.etype === "CompletionRefused")!;
    expect(refused.subject).toBe("job");
    expect(refused.corr).toBe(refused.tick);
    expect((refused.payload as { original_corr?: string | number }).original_corr).toBe(sent.corr);
  });

  it("correlates statement and expression TaskScopeViolation rows to the active task", async () => {
    for (const perform of [
      `perform Deploy("artifact");`,
      `text response = perform Deploy("artifact") expires 1;`,
    ]) {
      const result = await run(parse(`
        action Deploy(text artifact);
        agent Worker grants { perform Deploy } {
          on assigned { ${perform} complete 1; }
        }
        agent Lead grants { reach Worker } {
          on awake {
            spawn Worker worker; awake worker;
            Task<int> job = worker <- task {
              objective "ship";
              acceptance "an int";
            } expires 10;
          }
        }
        spawn Lead lead; awake lead;
      `));
      const sent = result.ledger.events.find((event) => event.etype === "Sent" && event.subject === "job")!;
      const violation = result.ledger.events.find((event) => event.etype === "TaskScopeViolation")!;
      expect(violation.corr).toBe(sent.corr);
      expect((violation.payload as { task?: string }).task).toBe("job");
    }
  });
});
