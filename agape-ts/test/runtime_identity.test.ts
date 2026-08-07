import { describe, expect, it } from "vitest";
import { parse } from "../src/parser.js";
import {
  createSession,
  deriveStableAgentInstanceId,
  run,
  deriveUserMemoryScopeId,
  type RuntimeIdentityContext,
} from "../src/interp.js";
import { MockProvider } from "../src/runtime.js";
import { LocalMemoryDriver, type MemoryScope } from "../src/memory.js";

const IDENTITY: RuntimeIdentityContext = {
  projectSubject: "project://release/agape",
  sessionLineageId: "lineage-alpha",
  sessionId: "session-alpha",
  conversationId: "conversation-alpha",
};

class ScopeSpyMemory extends LocalMemoryDriver {
  readonly declared: MemoryScope[] = [];
  override async declare(scope: MemoryScope): Promise<void> {
    this.declared.push(scope);
    await super.declare(scope);
  }
}

describe("authenticated runtime identity and spawn allocation", () => {
  it("rejects blank required identity dimensions before execution or seam access", () => {
    const fields = ["projectSubject", "sessionLineageId", "sessionId", "conversationId"] as const;
    for (const field of fields) {
      const events: string[] = [];
      const identity = { ...IDENTITY, [field]: "   " };
      expect(() => createSession(parse('say("must not execute");'), {
        identity,
        provider: new MockProvider(() => {
          throw new Error("provider seam accessed");
        }),
        memory: new LocalMemoryDriver(),
        onEvent: (event) => events.push(event.etype),
      })).toThrow(/identity|nonblank|blank/i);
      expect(events).toEqual([]);
    }
  });

  it("commits Spawned with its stable instance id before constructor effects", async () => {
    const result = await run(parse(`
      event Constructed(text status);
      agent Worker {
        emit Constructed("done");
      }
      spawn Worker worker;
    `), {
      identity: IDENTITY,
      memory: new LocalMemoryDriver(),
    });

    expect(result.ledger.events.map((event) => event.etype)).toEqual(["Spawned", "Constructed"]);
    const spawned = result.ledger.events[0]!;
    const payload = spawned.payload as Record<string, unknown>;
    const expected = deriveStableAgentInstanceId(
      IDENTITY.projectSubject,
      IDENTITY.sessionLineageId,
      spawned.tick,
    );
    expect(payload.instance_id).toBe(expected);
    expect(spawned.subject).toBe(expected);
    expect(payload.alias).toBe("worker");
    expect(expected).toMatch(/^agent-instance-v1:[a-f0-9]{64}$/);
  });

  it("isolates stable IDs by project, lineage, and Spawned tick without NUL-boundary collisions", () => {
    const base = deriveStableAgentInstanceId("project", "lineage", 0);
    expect(deriveStableAgentInstanceId("other-project", "lineage", 0)).not.toBe(base);
    expect(deriveStableAgentInstanceId("project", "other-lineage", 0)).not.toBe(base);
    expect(deriveStableAgentInstanceId("project", "lineage", 1)).not.toBe(base);
    expect(deriveStableAgentInstanceId("a\0b", "c", 1))
      .not.toBe(deriveStableAgentInstanceId("a", "b\0c", 1));
  });

  it("derives opaque user scopes without delimiter-boundary collisions", () => {
    const first = deriveUserMemoryScopeId("https://idp.example", "alice");
    expect(first).toMatch(/^user-scope-v1:[a-f0-9]{64}$/);
    expect(deriveUserMemoryScopeId("https://idp.example", "bob")).not.toBe(first);
    expect(deriveUserMemoryScopeId("a\0b", "c"))
      .not.toBe(deriveUserMemoryScopeId("a", "b\0c"));
    expect(first).not.toContain("alice");
  });

  it("is alias-independent while two Spawned ticks remain unique", async () => {
    const source = (left: string, right: string) => `
      agent Worker {}
      spawn Worker ${left};
      spawn Worker ${right};
    `;
    const first = await run(parse(source("alpha", "beta")), {
      identity: IDENTITY,
      memory: new LocalMemoryDriver(),
    });
    const renamed = await run(parse(source("renamed_alpha", "renamed_beta")), {
      identity: IDENTITY,
      memory: new LocalMemoryDriver(),
    });
    const ids = (events: typeof first.ledger.events) => events
      .filter((event) => event.etype === "Spawned")
      .map((event) => (event.payload as { instance_id: string }).instance_id);
    expect(ids(first.ledger.events)).toEqual(ids(renamed.ledger.events));
    expect(new Set(ids(first.ledger.events)).size).toBe(2);
  });

  it("uses stable instance identity for constructor memory scope and alias only for display", async () => {
    const memory = new ScopeSpyMemory();
    const result = await run(parse(`
      agent Writer {
        mem notes {
          type text;
          modality opaque;
          scope project;
          retention session;
        }
        notes <- "constructor write";
      }
      spawn Writer writer;
    `), {
      identity: IDENTITY,
      memory,
    });
    const spawned = result.ledger.events.find((event) => event.etype === "Spawned")!;
    const instanceId = (spawned.payload as { instance_id: string }).instance_id;
    expect(memory.declared).toHaveLength(1);
    expect(memory.declared[0]).toMatchObject({
      agentInstanceId: instanceId,
      agentAlias: "writer",
      project: IDENTITY.projectSubject,
      mem: "notes",
    });
    expect(memory.declared[0]).not.toHaveProperty("agent");
  });

  it("crashes a user-scoped operation before any driver access when kappa lacks user", async () => {
    const memory = new ScopeSpyMemory();
    let writes = 0;
    const originalInternalize = memory.internalize.bind(memory);
    memory.internalize = async (request) => {
      writes += 1;
      return originalInternalize(request);
    };
    const result = await run(parse(`
      agent Writer {
        mem notes {
          type text;
          modality opaque;
          scope project, user;
          retention session;
        }
        on awake { notes <- "must not persist"; }
      }
      spawn Writer writer;
      awake writer;
    `), {
      identity: IDENTITY,
      memory,
    });
    expect(memory.declared).toEqual([]);
    expect(writes).toBe(0);
    const crashed = result.ledger.events.find((event) => event.etype === "AgentCrashed");
    expect(crashed).toBeDefined();
    expect((crashed?.payload as { reason?: string }).reason).toMatch(/verified user scope/);
  });

  it("records constructor fault phase after Spawned and exposes no constructed lifecycle", async () => {
    const memory = new ScopeSpyMemory();
    const session = createSession(parse(`
      agent Broken {
        mem notes {
          type text;
          modality opaque;
          scope user;
          retention session;
        }
        notes <- "must not persist";
        on crash { say("must not run"); }
      }
      spawn Broken broken;
    `), {
      identity: IDENTITY,
      memory,
    });
    await expect(session.start()).rejects.toThrow(/verified user scope/);
    const snapshot = session.snapshot();
    expect(snapshot.ledger.events.map((event) => event.etype)).toEqual(["Spawned", "AgentCrashed"]);
    expect(snapshot.ledger.events[1]?.payload).toMatchObject({ phase: "constructor" });
    expect(snapshot.stdout).toEqual([]);
    expect(memory.declared).toEqual([]);
  });
});

