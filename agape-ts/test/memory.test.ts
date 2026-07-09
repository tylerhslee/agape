import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "../src/parser.js";
import { run } from "../src/interp.js";
import {
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

class RecordingMemory implements MemoryDriver {
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
      hits: [{ id: "hit-1", memory: "from driver", score: 0.8 }],
      recalled: "from driver",
      candidates: [{ id: "hit-1", memory: "from driver", score: 0.8 }],
    };
  }

  async forget(_req: MemoryForgetRequest): Promise<MemoryReceipt> {
    return { status: "FORGOTTEN" };
  }
}

describe("pluggable memory substrate", () => {
  it("routes memory store and recall through an injected MemoryDriver", async () => {
    const memory = new RecordingMemory();
    const program = parse(`
      agent A {
        on awake {
          mem notes <- "local write";
          text got = notes -> "q";
          say(got);
        }
      }
      spawn A a;
      awake a;
    `);

    const result = await run(program, { memory, manifest: { provider: { backend: "mock" }, project: { name: "demo" } } });

    expect(result.stdout).toEqual(["from driver"]);
    expect(memory.declared).toEqual([{ project: "demo", agent: "a", mem: "notes" }]);
    expect(memory.writes[0]?.scope).toEqual({ project: "demo", agent: "a", mem: "notes" });
    expect(memory.consults[0]?.query).toBe("q");
    const internalized = result.ledger.events.find((e) => e.etype === "Internalized");
    expect((internalized?.payload as any)?.refs?.driver_event).toBe("driver-write-1");
  });
});

describe("markdown memory adapter", () => {
  it("persists scoped memory as editable markdown and recalls it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agape-md-memory-"));
    try {
      const now = new Date("2026-01-02T03:04:05.000Z");
      const driver = new MarkdownMemoryDriver({ path: dir, top_k: 2 }, { now: () => now });
      const scope = { project: "demo", agent: "a", mem: "notes" };

      const receipt = await driver.internalize({
        scope,
        value: { kind: "text", v: "npm test", trust: "settled" },
        memory: "the build command is npm test",
        summary: { kind: "text", rendered: "npm test" },
        metadata: { source: "test" },
      });
      const consulted = await driver.consult({ scope, query: "build command" });

      expect(receipt.policy).toMatchObject({ driver: "markdown", entrypoint: "MEMORY.md" });
      expect(consulted.recalled).toContain("the build command is npm test");
      expect(consulted.candidates[0]).toMatchObject({ metadata: { markdown_file: "scopes/demo/a/notes.md" } });
      await expect(readFile(join(dir, "MEMORY.md"), "utf8")).resolves.toContain("[demo/a/notes](scopes/demo/a/notes.md)");
      await expect(readFile(join(dir, "scopes", "demo", "a", "notes.md"), "utf8")).resolves.toContain("agape-memory-id");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("forgets active markdown memory with an audit tombstone", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agape-md-memory-"));
    try {
      const driver = new MarkdownMemoryDriver({ path: dir, archive_on_forget: false });
      const scope = { project: "demo", agent: "a", mem: "notes" };
      await driver.internalize({
        scope,
        value: { kind: "text", v: "private fact", trust: "settled" },
        memory: "private fact to remove",
        summary: { kind: "text", rendered: "private fact" },
      });

      const receipt = await driver.forget({ scope });
      const consulted = await driver.consult({ scope, query: "private fact" });
      const topic = await readFile(join(dir, "scopes", "demo", "a", "notes.md"), "utf8");

      expect(receipt.status).toBe("TOMBSTONED");
      expect(consulted.recalled).not.toContain("private fact to remove");
      expect(topic).toContain("agape-forgotten");
      expect(topic).not.toContain("private fact to remove");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("is the default configured memory substrate", () => {
    expect(createMemoryDriver({ provider: { backend: "mock" } })).toBeInstanceOf(MarkdownMemoryDriver);
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
        scope: { project: "demo", agent: "a", mem: "notes" },
        value: { kind: "text", v: "project rooted", trust: "settled" },
        memory: "project rooted memory",
        summary: { kind: "text", rendered: "project rooted" },
      });

      await expect(readFile(join(dir, ".agape", "memory", "MEMORY.md"), "utf8")).resolves.toContain("demo/a/notes");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
