import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "../src/parser.js";
import { run, TEST_AGENT_INSTANCE_ID } from "./runtime_harness.js";
import {
  LocalMemoryDriver,
  type MemoryConsultRequest,
  type MemoryConsultResult,
  type MemoryDriver,
  type MemoryForgetRequest,
  type MemoryReceipt,
  type MemoryScope,
  type MemoryWriteRequest,
} from "../src/memory.js";
import { createMemoryDriver } from "../src/config.js";
import { MarkdownMemoryDriver } from "../src/memory_markdown.js";
import { LocalTransactionalNamedMemoryDriver } from "../src/named_memory_local.js";

class RecordingMemory implements MemoryDriver {
  readonly capabilities = { retentions: ["session"] as const };
  declared: MemoryScope[] = [];
  writes: MemoryWriteRequest[] = [];
  consults: MemoryConsultRequest[] = [];

  async declare(scope: MemoryScope): Promise<void> {
    this.declared.push(scope);
  }

  async internalize(req: MemoryWriteRequest): Promise<MemoryReceipt> {
    this.writes.push(req);
    return { eventId: "driver-write-1", status: "RECORDED" };
  }

  async consult(req: MemoryConsultRequest): Promise<MemoryConsultResult> {
    this.consults.push(req);
    return {
      hits: [{
        id: "hit-1",
        memory: "from driver",
        score: 0.8,
        value: { kind: "text", v: "from driver", trust: "settled" },
      }],
      recalled: "from driver",
      candidates: [{ id: "hit-1", memory: "from driver", score: 0.8 }],
    };
  }

  async forget(_req: MemoryForgetRequest): Promise<MemoryReceipt> {
    return { status: "FORGOTTEN" };
  }
}

describe("pluggable memory substrate", () => {
  it("routes source store and recall through an injected transactional named-memory driver", async () => {
    const memory = new RecordingMemory();
    const namedDriver = new LocalTransactionalNamedMemoryDriver();
    const calls = { read: 0, mutation: 0 };
    const program = parse(`
      agent A {
        mem notes {
          type text;
          modality opaque;
          scope project;
          retention session;
        }
        on awake {
          notes <- "local write";
          text[] got = notes -> "q";
          say(got);
        }
      }
      spawn A a;
      awake a;
    `);

    const result = await run(program, {
      memory,
      namedMemory: {
        driver: namedDriver,
        onDriverCall: (kind) => { calls[kind] += 1; },
      },
      manifest: { provider: { backend: "mock" }, project: { name: "demo" } },
    });

    expect(result.stdout.join(" ")).toContain("local write");
    expect(memory.declared).toEqual([]);
    expect(memory.writes).toEqual([]);
    expect(memory.consults).toEqual([]);
    expect(result.namedMemoryRecording.operations.map((operation) => operation.kind)).toEqual(["store", "recall"]);
    expect(calls.read).toBe(1);
    expect(calls.mutation).toBeGreaterThan(0);
    const internalized = result.ledger.events.find((e) => e.etype === "Internalized");
    expect((internalized?.payload as any)?.operation).toBe("store");
    expect((internalized?.payload as any)?.memory).toBeUndefined();
    expect((internalized?.payload as any)?.value).toBeUndefined();
    expect((internalized?.payload as any)?.effects).toMatchObject({ cells: { upserted: 1, tombstoned: 0 } });
  });
  it("keeps LocalMemoryDriver declarations idempotent", async () => {
    const memory = new LocalMemoryDriver();
    const scope = { project: "demo", agentInstanceId: "instance-a", agentAlias: "a", mem: "notes" };
    await memory.declare(scope);
    await memory.internalize({
      scope,
      value: { kind: "text", v: "preserved", trust: "settled" },
      memory: "preserved",
      summary: { kind: "text", rendered: "preserved" },
    });

    await memory.declare(scope);
    const recalled = await memory.consult({ scope, query: "preserved" });

    expect(recalled.recalled).toBe("preserved");
    expect(recalled.hits).toHaveLength(1);
  });

});

describe("markdown memory adapter", () => {
  it("persists scoped memory as editable markdown and recalls it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agape-md-memory-"));
    try {
      const now = new Date("2026-01-02T03:04:05.000Z");
      const driver = new MarkdownMemoryDriver({ path: dir, top_k: 2 }, { now: () => now });
      const scope = { project: "demo", agentInstanceId: "instance-a", agentAlias: "a", mem: "notes" };

      const receipt = await driver.internalize({
        scope,
        value: { kind: "text", v: "npm test", trust: "settled" },
        memory: "the build command is npm test",
        summary: { kind: "text", rendered: "npm test" },
        metadata: { source: "test" },
      });
      const consulted = await driver.consult({ scope, query: "build command" });

      expect(receipt.policy).toMatchObject({ driver: "markdown", entrypoint: "MEMORY.md" });
      expect(receipt.effects).toMatchObject({
        cells: { upserted: 1 },
        facts: { upserted: 0 },
        vectors: { chunks_upserted: 0 },
      });
      expect(consulted.recalled).toContain("the build command is npm test");
      expect(consulted.candidates[0]).toMatchObject({ metadata: { markdown_file: "scopes/demo/instance-a/notes.md" } });
      await expect(readFile(join(dir, "MEMORY.md"), "utf8")).resolves.toContain("[demo/a/notes](scopes/demo/instance-a/notes.md)");
      await expect(readFile(join(dir, "scopes", "demo", "instance-a", "notes.md"), "utf8")).resolves.toContain("agape-memory-id");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("recalls only the exact project, agent, and mem scope", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agape-md-isolation-"));
    try {
      const driver = new MarkdownMemoryDriver({ path: dir });
      await driver.internalize({
        scope: { project: "demo", agentInstanceId: "instance-chatbot", agentAlias: "chatbot", mem: "notes" },
        value: { kind: "text", v: "chatbot-only-sentinel", trust: "settled" },
        memory: "chatbot-only-sentinel",
        summary: { kind: "text", rendered: "chatbot-only-sentinel" },
      });

      const verifierRecall = await driver.consult({
        scope: { project: "demo", agentInstanceId: "instance-verifier", agentAlias: "verifier", mem: "notes" },
        query: "chatbot-only-sentinel",
      });

      expect(verifierRecall.hits).toEqual([]);
      expect(verifierRecall.recalled).toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("forgets active markdown memory with an audit tombstone", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agape-md-memory-"));
    try {
      const driver = new MarkdownMemoryDriver({ path: dir, archive_on_forget: false });
      const scope = { project: "demo", agentInstanceId: "instance-a", agentAlias: "a", mem: "notes" };
      await driver.internalize({
        scope,
        value: { kind: "text", v: "private fact", trust: "settled" },
        memory: "private fact to remove",
        summary: { kind: "text", rendered: "private fact" },
      });

      const receipt = await driver.forget({ scope });
      const consulted = await driver.consult({ scope, query: "private fact" });
      const topic = await readFile(join(dir, "scopes", "demo", "instance-a", "notes.md"), "utf8");

      expect(receipt.status).toBe("TOMBSTONED");
      expect(consulted.recalled).not.toContain("private fact to remove");
      expect(topic).toContain("agape-forgotten");
      expect(topic).not.toContain("private fact to remove");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns the configured markdown substrate without implicit cognition wrappers", () => {
    const memory = createMemoryDriver({ provider: { backend: "mock" }, memory: { driver: "markdown" } });
    expect(memory).toBeInstanceOf(MarkdownMemoryDriver);
  });
  it("uses project-rooted markdown memory when configured for raw run()", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agape-run-md-memory-"));
    try {
      const program = parse(`
        agent A {
          mem notes {
            type text;
            modality opaque;
            scope project;
            retention durable;
          }
          on awake {
            notes <- "default markdown write";
          }
        }
        spawn A a;
        awake a;
      `);

      await run(program, {
        projectRoot: dir,
        manifest: { provider: { backend: "mock" }, project: { name: "demo" }, memory: { driver: "markdown" } },
      });

      const root = join(dir, ".agape", "memory");
      const files = await readdir(root, { recursive: true });
      const projections = files.filter((file) => file.endsWith("MEMORY.md"));
      expect(projections).toHaveLength(1);
      await expect(readFile(join(root, projections[0]!), "utf8")).resolves.toContain("default markdown write");
      expect(files.join(" ")).not.toContain("test://agape");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("isolates two users at the same project, lineage, and stable agent instance", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agape-md-user-isolation-"));
    const identity = {
      projectSubject: "project://shared",
      sessionLineageId: "lineage-shared",
      sessionId: "session-shared",
      conversationId: "conversation-shared",
    };
    const program = (awakeBody: string) => parse(`
      agent A {
        mem notes {
          type text;
          modality opaque;
          scope project, user;
          retention durable;
        }
        on awake { ${awakeBody} }
      }
      spawn A a;
      awake a;
    `);
    const manifest = {
      provider: { backend: "mock" as const },
      memory: { driver: "markdown" },
    };
    try {
      const alice = await run(program('notes <- "alice-only-sentinel";'), {
        identity: {
          ...identity,
          user: { issuer: "https://idp.example", subject: "alice", verified: true },
        },
        projectRoot: dir,
        manifest,
      });
      const bob = await run(program('text[] hits = notes -> "alice-only-sentinel"; say(hits);'), {
        identity: {
          ...identity,
          user: { issuer: "https://idp.example", subject: "bob", verified: true },
        },
        projectRoot: dir,
        manifest,
      });

      expect(bob.stdout.join(" ")).not.toContain("alice-only-sentinel");
      const instanceId = String((alice.ledger.events.find((event) => event.etype === "Spawned")?.payload as Record<string, unknown>)?.instance_id);
      const bobInstanceId = String((bob.ledger.events.find((event) => event.etype === "Spawned")?.payload as Record<string, unknown>)?.instance_id);
      expect(bobInstanceId).toBe(instanceId);
      const files = await readdir(join(dir, ".agape", "memory"), { recursive: true });
      expect(files.filter((name) => name.endsWith("MEMORY.md"))).toHaveLength(1);
      expect(files.join(" ")).not.toContain("alice");
      expect(files.join(" ")).not.toContain("bob");
      expect(files.join(" ")).not.toContain("project://shared");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });


  it("resolves relative markdown paths against the configured project root", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agape-md-project-"));
    try {
      const memory = createMemoryDriver({
        provider: { backend: "mock" },
        project: { name: "demo" },
        memory: { driver: "markdown", path: ".agape/memory" },
      }, { cwd: dir });
      await memory.internalize({
        scope: { project: "demo", agentInstanceId: "instance-a", agentAlias: "a", mem: "notes" },
        value: { kind: "text", v: "project rooted", trust: "settled" },
        memory: "project rooted memory",
        summary: { kind: "text", rendered: "project rooted" },
      });

      await expect(readFile(join(dir, ".agape", "memory", "MEMORY.md"), "utf8")).resolves.toContain("demo/a/notes");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("requires a configured runtime driver unless the host injects one", async () => {
    const program = parse(`
      agent A {}
      spawn A a;
      awake a;
    `);

    await expect(run(program)).rejects.toMatchObject({ cls: "ConfigError" });
    await expect(run(program, { memory: new LocalMemoryDriver() })).resolves.toMatchObject({ stdout: [] });
    expect(() => createMemoryDriver({
      provider: { backend: "mock" },
      memory: { driver: "" },
    })).toThrow(/memory requires a configured \[memory\] driver/i);
    expect(() => createMemoryDriver({
      provider: { backend: "mock" },
      memory: { driver: "unknown" },
    })).toThrow(/unknown memory driver/i);
  });
});

describe("direct configured memory substrate", () => {
  it("preserves every explicit write without hidden classification or deduplication", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agape-runtime-memory-"));
    try {
      const driver = new MarkdownMemoryDriver({ path: dir, top_k: 10 });
      const scope = { project: "league", agentInstanceId: "instance-advisor", agentAlias: "advisor", mem: "notes" };
      const write: MemoryWriteRequest = {
        scope,
        value: { kind: "text", v: "User prefers conservative waiver advice in close roster calls.", trust: "settled" },
        memory: "User prefers conservative waiver advice in close roster calls.",
        summary: { kind: "text", rendered: "User prefers conservative waiver advice in close roster calls." },
        metadata: { source: "store" },
      };

      const first = await driver.internalize(write);
      const second = await driver.internalize(write);
      const consulted = await driver.consult({ scope, query: "waiver advice risk preference", topK: 1 });

      expect(first.status).toBe("APPENDED");
      expect(second.status).toBe("APPENDED");
      expect(consulted.hits[0]?.metadata).not.toHaveProperty("memory_kind");
      expect(consulted.recalled).toContain("conservative waiver advice");
      expect(consulted.recalled).not.toContain("```json");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("treats every driver internalize call as an explicit write regardless of source label", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agape-runtime-memory-"));
    try {
      const driver = new MarkdownMemoryDriver({ path: dir });
      const receipt = await driver.internalize({
        scope: { project: "demo", agentInstanceId: "instance-a", agentAlias: "a", mem: "notes" },
        value: { kind: "text", v: "ok", trust: "raw" },
        memory: "ok",
        summary: { kind: "text", rendered: "ok" },
        metadata: { source: "external_import" },
      });

      expect(receipt.status).toBe("APPENDED");
      expect(receipt.effects).toMatchObject({ cells: { upserted: 1 }, facts: { upserted: 0 } });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
