import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "../src/parser.js";
import {
  createSession,
  resolveMarkdownMemoryPathBinding,
  run,
  type RuntimeIdentityContext,
} from "../src/interp.js";
import { LocalMemoryDriver } from "../src/memory.js";
import {
  DurableTransactionalNamedMemoryDriver,
  LocalTransactionalNamedMemoryDriver,
  LocalTransactionalNamedMemoryJournal,
} from "../src/named_memory_local.js";
import type { TransactionalNamedMemoryDriver } from "../src/named_memory_coordinator.js";

const identity = (
  overrides: Partial<RuntimeIdentityContext> = {},
): RuntimeIdentityContext => ({
  projectSubject: "project://source-memory",
  sessionLineageId: "lineage-source-memory",
  sessionId: "session-source-memory",
  conversationId: "conversation-source-memory",
  user: { issuer: "https://issuer.example", subject: "alice", verified: true },
  ...overrides,
});

const source = (body: string, descriptor = `
  mem episodes {
    type text;
    modality episodic;
    scope project, user;
    retention session;
  }
`) => `
  agent Chatbot {
    ${descriptor}
    ${body}
  }
  spawn Chatbot chatbot;
`;

const legacyMemory = () => new LocalMemoryDriver();

describe("qualified source memory uses the production coordinator", () => {
  it("stores exact canonical values and preserves distinct equal episodic origins", async () => {
    const result = await run(parse(source(`
      episodes <- "same private episode";
      episodes <- "same private episode";
      text[] hits = episodes -> "same";
    `)), {
      identity: identity(),
      memory: legacyMemory(),
      namedMemory: { driver: new LocalTransactionalNamedMemoryDriver() },
    });

    const stored = result.ledger.events.filter((event) => event.etype === "Internalized");
    expect(stored).toHaveLength(2);
    expect(stored[0]!.payload).toMatchObject({
      operation: "store",
      write_source: "explicit_store",
      region: "episodes",
      generation: 0,
    });
    const first = stored[0]!.payload as Record<string, unknown>;
    const second = stored[1]!.payload as Record<string, unknown>;
    expect(first.operation_id).not.toBe(second.operation_id);
    expect(first.origin_ref).not.toBe(second.origin_ref);
    expect(JSON.stringify(result.ledger.events)).not.toContain("same private episode");

    const recording = result.namedMemoryRecording;
    expect(recording.operations.map((operation) => operation.kind)).toEqual([
      "store", "store", "recall",
    ]);
    const recalled = recording.operations[2];
    expect(recalled?.kind).toBe("recall");
    if (recalled?.kind !== "recall") throw new Error("expected a recall recording");
    expect(recalled.hits).toHaveLength(2);
    expect(recalled.hits.map((hit) => hit.cell.originId).sort()).toEqual([
      first.origin_ref,
      second.origin_ref,
    ].sort());
    expect(recalled.hits.map((hit) => hit.cell.value.valueHash)).toEqual([
      first.value_hash,
      second.value_hash,
    ]);
  });

  it("closes one generation and reopens exactly the next generation", async () => {
    const result = await run(parse(source(`
      episodes <- "generation zero";
      forget episodes;
      episodes <- "generation one";
      text[] hits = episodes -> "generation";
    `)), {
      identity: identity(),
      memory: legacyMemory(),
      namedMemory: { driver: new LocalTransactionalNamedMemoryDriver() },
    });

    const memoryEvents = result.ledger.events.filter((event) =>
      ["Internalized", "Forgotten", "MemoryConsulted"].includes(event.etype));
    expect(memoryEvents.map((event) => [
      event.etype,
      (event.payload as Record<string, unknown>).generation,
    ])).toEqual([
      ["Internalized", 0],
      ["Forgotten", 0],
      ["Internalized", 1],
      ["MemoryConsulted", 1],
    ]);
    const recording = result.namedMemoryRecording;
    const recall = recording.operations.at(-1);
    if (recall?.kind !== "recall") throw new Error("expected a recall recording");
    expect(recall.hits).toHaveLength(1);
    expect(recall.hits[0]!.cell.value.value.value).toBe("generation one");
  });

  it("isolates durable cells across project, user, and concrete agent instance", async () => {
    const journal = new LocalTransactionalNamedMemoryJournal();
    const descriptor = `
      mem episodes {
        type text;
        modality episodic;
        scope project, user;
        retention durable;
      }
    `;
    const writer = await run(parse(source(`episodes <- "private durable episode";`, descriptor)), {
      identity: identity({ sessionId: "writer-session" }),
      memory: legacyMemory(),
      namedMemory: {
        driver: new DurableTransactionalNamedMemoryDriver({ journal }),
      },
    });
    expect(writer.ledger.events.some((event) => event.etype === "Internalized")).toBe(true);

    const read = async (runtimeIdentity: RuntimeIdentityContext) => run(parse(source(`
      text[] hits = episodes -> "private";
    `, descriptor)), {
      identity: runtimeIdentity,
      memory: legacyMemory(),
      namedMemory: {
        driver: new DurableTransactionalNamedMemoryDriver({ journal }),
      },
    });
    const otherProject = await read(identity({
      projectSubject: "project://other",
      sessionId: "other-project-session",
    }));
    const otherUser = await read(identity({
      sessionId: "other-user-session",
      user: { issuer: "https://issuer.example", subject: "bob", verified: true },
    }));
    for (const result of [otherProject, otherUser]) {
      const recall = result.namedMemoryRecording.operations.at(-1);
      if (recall?.kind !== "recall") throw new Error("expected a recall recording");
      expect(recall.hits).toEqual([]);
    }

    const instanceResult = await run(parse(`
      agent Writer {
        ${descriptor}
        episodes <- "instance-private";
      }
      agent Reader {
        ${descriptor}
        text[] hits = episodes -> "instance";
      }
      spawn Writer writer;
      spawn Reader reader;
    `), {
      identity: identity({ sessionId: "instance-session" }),
      memory: legacyMemory(),
      namedMemory: { driver: new DurableTransactionalNamedMemoryDriver({ journal }) },
    });
    const instanceRecall = instanceResult.namedMemoryRecording.operations.at(-1);
    if (instanceRecall?.kind !== "recall") throw new Error("expected a recall recording");
    expect(instanceRecall.hits).toEqual([]);
  });

  it("domains same-source durable operations by authenticated session across restarts", async () => {
    const journal = new LocalTransactionalNamedMemoryJournal();
    const program = parse(`
      prompt text question;
      agent Chatbot {
        mem episodes {
          type text;
          modality episodic;
          scope project, user;
          retention durable;
        }
        when (Prompt p about question) {
          text stored = "session one";
          if (p.text == "session two") {
            stored = "session two";
          }
          episodes <- stored;
          text[] hits = episodes -> "session";
        }
      }
      spawn Chatbot chatbot;
      awake chatbot;
    `);
    const execute = (sessionId: string, value: string) => run(program, {
      identity: identity({ sessionId }),
      memory: legacyMemory(),
      promptInputs: [{ name: "question", value }],
      namedMemory: {
        driver: new DurableTransactionalNamedMemoryDriver({ journal }),
      },
    });

    const first = await execute("durable-session-one", "session one");
    const second = await execute("durable-session-two", "session two");
    const firstStore = first.namedMemoryRecording.operations.find((operation) => operation.kind === "store");
    const secondStore = second.namedMemoryRecording.operations.find((operation) => operation.kind === "store");
    expect(firstStore?.kind).toBe("store");
    expect(secondStore?.kind).toBe("store");
    if (firstStore?.kind !== "store" || secondStore?.kind !== "store") {
      throw new Error("expected one durable store per fresh session");
    }
    expect(secondStore.stage.operationId).not.toBe(firstStore.stage.operationId);

    const secondRecall = second.namedMemoryRecording.operations.find((operation) => operation.kind === "recall");
    expect(secondRecall?.kind).toBe("recall");
    if (secondRecall?.kind !== "recall") throw new Error("expected the second session to recall durable memory");
    expect(secondRecall.hits.map((hit) => hit.cell.value.value.value).sort()).toEqual([
      "session one",
      "session two",
    ].sort());
  });

  it("contains a missing-user scope fault once before any driver access", async () => {
    const calls = { read: 0, mutation: 0 };
    const result = await run(parse(`
      agent Chatbot {
        mem episodes {
          type text;
          modality episodic;
          scope project, user;
          retention session;
        }
        on awake { episodes <- "must not persist"; }
      }
      spawn Chatbot chatbot;
      awake chatbot;
    `), {
      identity: identity({ user: undefined }),
      memory: legacyMemory(),
      namedMemory: {
        driver: new LocalTransactionalNamedMemoryDriver(),
        onDriverCall: (kind) => { calls[kind] += 1; },
      },
    });

    expect(calls).toEqual({ read: 0, mutation: 0 });
    const crashes = result.ledger.events.filter((event) => event.etype === "AgentCrashed");
    expect(crashes).toHaveLength(1);
    expect(crashes[0]!.payload).toMatchObject({
      reason: expect.stringMatching(/verified user|resolved user|user scope/i),
    });
    expect(result.ledger.events.some((event) => event.etype === "Internalized")).toBe(false);
  });

  it("replays source memory without constructing or invoking a live driver", async () => {
    const program = parse(source(`
      episodes <- "replay private episode";
      text[] hits = episodes -> "replay";
      forget episodes;
    `));
    const live = await run(program, {
      identity: identity(),
      memory: legacyMemory(),
      namedMemory: { driver: new LocalTransactionalNamedMemoryDriver() },
    });
    let factories = 0;
    const replayed = await run(program, {
      identity: identity(),
      memory: legacyMemory(),
      namedMemory: {
        replay: live.namedMemoryRecording,
        driverFactory: () => {
          factories += 1;
          throw new Error("replay must not construct a live named-memory driver");
        },
      },
    });

    expect(factories).toBe(0);
    expect(replayed.ledger.head()).toBe(live.ledger.head());
    expect(replayed.ledger.events.map((event) => ({
      tick: event.tick,
      etype: event.etype,
      subject: event.subject,
      payload: event.payload,
      corr: event.corr,
      agent: event.agent,
    }))).toEqual(live.ledger.events.map((event) => ({
      tick: event.tick,
      etype: event.etype,
      subject: event.subject,
      payload: event.payload,
      corr: event.corr,
      agent: event.agent,
    })));
  });

  it("never falls back to an interpreter MemRegion.writes overlay", async () => {
    const base = new LocalTransactionalNamedMemoryDriver();
    const driver: TransactionalNamedMemoryDriver = {
      capabilities: base.capabilities,
      prepareStore: (request) => base.prepareStore(request),
      prepareForget: (request) => base.prepareForget(request),
      finalize: (operationId, binding) => base.finalize(operationId, binding),
      abort: (operationId) => base.abort(operationId),
      status: (operationId) => base.status(operationId),
      reconcile: (operationId, binding) => base.reconcile(operationId, binding),
      recall: async () => ({ generation: 0, state: "open", cells: [], values: [] }),
      snapshot: () => base.snapshot(),
    };
    const result = await run(parse(source(`
      episodes <- "must not come from an overlay";
      text[] hits = episodes -> "overlay";
    `)), {
      identity: identity(),
      memory: legacyMemory(),
      namedMemory: { driver },
    });
    const recall = result.namedMemoryRecording.operations.at(-1);
    if (recall?.kind !== "recall") throw new Error("expected a recall recording");
    expect(recall.hits).toEqual([]);
    const consulted = result.ledger.events.find((event) => event.etype === "MemoryConsulted");
    expect(consulted?.payload).toMatchObject({ hit_ids: [], hit_hashes: [] });
  });

  it("resolves Markdown static roots while preserving operation-scoped placeholders", () => {
    expect(resolveMarkdownMemoryPathBinding("state/memory", "/workspace/project")).toEqual({
      root: resolvePath("/workspace/project", "state/memory"),
    });
    expect(resolveMarkdownMemoryPathBinding("~/agape-memory", "/ignored/project")).toEqual({
      root: resolvePath(homedir(), "agape-memory"),
    });
    expect(resolveMarkdownMemoryPathBinding(
      "/safe/memory/{project}/{lineage}/{agent}/{mem}/{user}/{generation}",
      "/ignored/project",
    )).toEqual({
      root: resolvePath("/safe/memory"),
      pathTemplate: "{project}/{lineage}/{agent}/{mem}/{user}/{generation}",
    });
    expect(() => resolveMarkdownMemoryPathBinding(
      "/safe/{project}/../escape",
      "/workspace/project",
    )).toThrow(/traverse/i);
    expect(() => resolveMarkdownMemoryPathBinding(
      "/safe/{raw_subject}",
      "/workspace/project",
    )).toThrow(/unsupported placeholder/i);
    expect(() => resolveMarkdownMemoryPathBinding(
      "/safe/prefix-{project}/memory",
      "/workspace/project",
    )).toThrow(/complete path segments/i);
  });

  it.each([
    [-50, 1],
    [0, 1],
    [1.9, 1],
    [37, 37],
    [2_000, 1_000],
  ])("clamps manifest top_k=%s to the normative source recall cap %s", async (configured, expected) => {
    const result = await run(parse(source(`
      episodes <- "one";
      text[] hits = episodes -> "one";
    `)), {
      identity: identity({ sessionId: `top-k-${configured}` }),
      memory: legacyMemory(),
      manifest: {
        provider: { backend: "mock" },
        memory: { driver: "local", top_k: configured },
      },
      namedMemory: { driver: new LocalTransactionalNamedMemoryDriver() },
    });
    const consulted = result.ledger.events.find((event) => event.etype === "MemoryConsulted");
    expect(consulted?.payload).toMatchObject({ cap: expected });
  });

  it("retries failed interpreter close and rejects all use after successful close", async () => {
    const base = new LocalTransactionalNamedMemoryDriver();
    let closes = 0;
    const driver = {
      capabilities: base.capabilities,
      prepareStore: (request: Parameters<TransactionalNamedMemoryDriver["prepareStore"]>[0]) =>
        base.prepareStore(request),
      prepareForget: (request: Parameters<TransactionalNamedMemoryDriver["prepareForget"]>[0]) =>
        base.prepareForget(request),
      finalize: (
        operationId: Parameters<TransactionalNamedMemoryDriver["finalize"]>[0],
        binding: Parameters<TransactionalNamedMemoryDriver["finalize"]>[1],
      ) => base.finalize(operationId, binding),
      abort: (operationId: string) => base.abort(operationId),
      status: (operationId: string) => base.status(operationId),
      reconcile: (
        operationId: Parameters<TransactionalNamedMemoryDriver["reconcile"]>[0],
        binding?: Parameters<TransactionalNamedMemoryDriver["reconcile"]>[1],
      ) => base.reconcile(operationId, binding),
      recall: (request: Parameters<TransactionalNamedMemoryDriver["recall"]>[0]) => base.recall(request),
      snapshot: () => base.snapshot(),
      close: async () => {
        closes += 1;
        if (closes === 1) throw new Error("lost interpreter close acknowledgement");
      },
    };
    const session = createSession(parse(`say("ready");`), {
      identity: identity({ sessionId: "close-retry-session" }),
      memory: legacyMemory(),
      namedMemory: { driver },
    });
    await session.start();
    await expect(session.close()).rejects.toThrow(/lost interpreter close acknowledgement/);
    await expect(session.start()).resolves.toMatchObject({ stdout: ["ready"] });
    await expect(session.close()).resolves.toBeDefined();
    expect(closes).toBe(2);
    const before = session.snapshot().ledger.events.length;
    await expect(session.start()).rejects.toThrow(/closed/);
    await expect(session.sendPrompt({ name: "question", value: "late" })).rejects.toThrow(/closed/);
    expect(session.snapshot().ledger.events).toHaveLength(before);
  });
});
