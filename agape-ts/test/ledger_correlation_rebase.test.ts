import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createSession } from "../src/interp.js";
import { LocalMemoryDriver } from "../src/memory.js";
import { parse } from "../src/parser.js";
import { MockProvider, type CognitionContext, type StructuredSchema } from "../src/runtime.js";
import { createAdapter } from "../src/runtime_adapter.js";
import { TEST_RUNTIME_IDENTITY } from "./runtime_harness.js";
const stableJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, member]) => member !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, member]) => `${JSON.stringify(key)}:${stableJson(member)}`)
    .join(",")}}`;
};
const receiptHash = (value: unknown): string => createHash("sha256").update(stableJson(value)).digest("hex");


describe("SPEC 16.2 dynamic correlation identity", () => {
  it("keeps concurrent same-source task handles isolated by opening correlation while preserving their subject", async () => {
    const session = createSession(parse(`
      prompt text request;
      event Finished(text request);
      agent Worker {
        on assigned {
          complete 1;
        }
      }
      agent Lead(Worker worker) grants { reach Worker } {
        when (Prompt p about request) {
          Task<int> job = worker <- task {
            objective "work";
            acceptance "return an int";
          } expires 10;
          when (TaskCompleted done about job) { emit Finished(p.text); }
        }
      }
      spawn Worker worker;
      awake worker;
      spawn Lead lead(worker);
      awake lead;
    `), {
      identity: TEST_RUNTIME_IDENTITY,
      memory: new LocalMemoryDriver(),
    });
    await session.start();

    await Promise.all([
      session.sendPrompt({ name: "request", value: "one" }),
      session.sendPrompt({ name: "request", value: "two" }),
    ]);

    const events = session.snapshot().ledger.events;
    const sent = events.filter((event) => event.etype === "Sent" && event.subject === "job");
    const completed = events.filter((event) => event.etype === "TaskCompleted" && event.subject === "job");
    expect(sent).toHaveLength(2);
    expect(completed).toHaveLength(2);
    expect(sent.map((event) => event.corr)).toEqual(sent.map((event) => event.tick));
    expect(new Set(sent.map((event) => event.corr)).size).toBe(2);
    expect(completed.map((event) => event.corr).sort()).toEqual(sent.map((event) => event.corr).sort());
    expect(events.filter((event) => event.etype === "Finished")).toHaveLength(2);
  });

  it("does not duplicate an awake-hook nested subscription across re-awakenings", async () => {
    const session = createSession(parse(`
      event Ping();
      event Seen();
      agent Listener {
        on awake {
          when (Ping p) { emit Seen(); }
          emit Ping();
        }
      }
      spawn Listener listener;
      awake listener;
      awake listener;
    `), {
      identity: TEST_RUNTIME_IDENTITY,
      memory: new LocalMemoryDriver(),
    });

    await session.start();

    expect(session.snapshot().ledger.events.filter((event) => event.etype === "Seen")).toHaveLength(2);
  });

  it("never arms a nested when in an untaken branch", async () => {
    const session = createSession(parse(`
      event Ping();
      event Seen();
      agent Listener {
        on awake {
          if (false) { when (Ping p) { emit Seen(); } }
          emit Ping();
        }
      }
      spawn Listener listener;
      awake listener;
    `), {
      identity: TEST_RUNTIME_IDENTITY,
      memory: new LocalMemoryDriver(),
    });

    await session.start();

    expect(session.snapshot().ledger.events.filter((event) => event.etype === "Seen")).toHaveLength(0);
  });

  it("deregisters each outer-reaction nested when before the next prompt", async () => {
    const session = createSession(parse(`
      prompt text request;
      event Ping();
      event Seen(text value);
      agent Listener {
        when (Prompt p about request) {
          when (Ping ping) { emit Seen(p.text); }
          emit Ping();
        }
      }
      spawn Listener listener;
      awake listener;
    `), {
      identity: TEST_RUNTIME_IDENTITY,
      memory: new LocalMemoryDriver(),
    });
    await session.start();

    await session.sendPrompt({ name: "request", value: "one" });
    await session.sendPrompt({ name: "request", value: "two" });

    const seen = session.snapshot().ledger.events.filter((event) => event.etype === "Seen");
    expect(seen).toHaveLength(2);
    expect(seen.map((event) => event.payload)).toEqual([["one"], ["two"]]);
  });

  it("keeps a handler-scoped task completion subscription live through its task drain", async () => {
    const session = createSession(parse(`
      prompt text request;
      event Finished(text value);
      agent Worker {
        on assigned { complete 1; }
      }
      agent Lead(Worker worker) grants { reach Worker } {
        when (Prompt p about request) {
          Task<int> job = worker <- task {
            objective "work";
            acceptance "return an int";
          } expires 10;
          when (TaskCompleted done about job) { emit Finished(p.text); }
        }
      }
      spawn Worker worker;
      awake worker;
      spawn Lead lead(worker);
      awake lead;
    `), {
      identity: TEST_RUNTIME_IDENTITY,
      memory: new LocalMemoryDriver(),
    });
    await session.start();

    await session.sendPrompt({ name: "request", value: "one" });

    const finished = session.snapshot().ledger.events.filter((event) => event.etype === "Finished");
    expect(finished).toHaveLength(1);
    expect(finished[0]!.payload).toEqual(["one"]);
  });


  it("creates authenticated principal correlations at final global ticks across adapter runs", async () => {
    const adapter = createAdapter();
    const principalSource = `
      enum Approval { Approve, Decline }
      principal alice;
      action Publish(text value);
      agent Clerk grants { perform Publish } {
        on awake {
          text candidate = "assess";
          Credence<Approval> c = self <- candidate;
          Decision<Approval> d = alice decide c by conformal 0.05;
          if (d.committed == Approve) {
            Endorsement<text> e = endorse candidate by d;
            perform Publish(e);
          }
        }
      }
      spawn Clerk clerk;
      awake clerk;
    `;

    const first = await adapter.run({ source: principalSource, testMode: { principal: "grant" } });
    const second = await adapter.run({ source: principalSource, record: true, testMode: { principal: "grant" } });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.events[0]?.tick).toBe(first.events.length);

    const global = await adapter.ledgerRead();
    const pending = global.filter((event) => event.etype === "PendingPrincipalDecision");
    const ruling = global.filter((event) => event.etype === "PrincipalDecision");
    const decided = global.filter((event) => event.etype === "Decided");
    const endorsed = global.filter((event) => event.etype === "Endorsed");
    const authorized = global.filter((event) => event.etype === "ActionAuthorized");
    expect(pending).toHaveLength(2);
    expect(ruling).toHaveLength(2);
    expect(decided).toHaveLength(2);
    expect(endorsed).toHaveLength(2);
    expect(authorized).toHaveLength(2);
    expect(global.slice(first.events.length)).toEqual(second.events);
    const replay = await adapter.replay(second.recording);
    expect(replay.ok).toBe(true);
    expect(replay.events).toEqual(second.events);
    expect(replay.headHash).toBe(second.headHash);
    expect(pending.map((event) => event.corr)).toEqual(pending.map((event) => event.tick));
    expect(new Set(pending.map((event) => event.corr)).size).toBe(2);
    for (let index = 0; index < 2; index++) {
      expect(ruling[index]!.corr).toBe(pending[index]!.tick);
      expect((ruling[index]!.payload as { pending?: number }).pending).toBe(pending[index]!.tick);
      expect((decided[index]!.payload as { decision_id?: number }).decision_id).toBe(decided[index]!.tick);
      expect((decided[index]!.payload as { principal_event?: number }).principal_event).toBe(ruling[index]!.tick);
      const requestHash = (pending[index]!.payload as { request_hash?: string }).request_hash;
      expect(requestHash).toMatch(/^[0-9a-f]{64}$/);
      const requestPayload = pending[index]!.payload as Record<string, unknown>;
      const request = {
        corr: requestPayload.corr,
        who: requestPayload.who,
        credence_id: requestPayload.credence_id,
        evidence_hash: requestPayload.evidence_hash,
        rule_hash: requestPayload.rule_hash,
        subject_hash: requestPayload.subject_hash,
        governed_operation: requestPayload.governed_operation,
        governed_request_hash: requestPayload.governed_request_hash,
      };
      expect(requestHash).toBe(receiptHash({ domain: "agape/principal-request/v1", request }));
      expect((authorized[index]!.payload as { endorsement_tick?: number }).endorsement_tick)
        .toBe(endorsed[index]!.tick);
      expect((authorized[index]!.payload as { decision_id?: number }).decision_id).toBe(decided[index]!.tick);
      expect((ruling[index]!.payload as { request_hash?: string }).request_hash).toBe(requestHash);
      expect((decided[index]!.payload as { principal_request?: string }).principal_request).toBe(requestHash);
    }
  });
  it("returns second-run tool and refusal correlations at their final global ticks", async () => {
    const adapter = createAdapter();
    const source = `
      action Search(text query);
      agent Worker { }
      agent Lead grants { perform Search, reach Worker } {
        on awake {
          perform Search("one");
          perform Search("two");
          spawn Worker worker;
          null reply = worker <- "late" expires 1;
          awake worker;
        }
      }
      spawn Lead lead;
      awake lead;
    `;
    const testMode = { tools: { Search: { result: null } } };
    const first = await adapter.run({ source, testMode });
    const second = await adapter.run({ source, testMode });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    const offset = first.events.length;
    const absorbed = (await adapter.ledgerRead()).slice(offset);
    expect(absorbed).toHaveLength(second.events.length);
    const localStarts = second.events.filter((event) => event.etype === "ToolStarted");
    const localResolves = second.events.filter((event) => event.etype === "ToolResolved");
    expect(absorbed).toEqual(second.events);
    const starts = absorbed.filter((event) => event.etype === "ToolStarted");
    const resolves = absorbed.filter((event) => event.etype === "ToolResolved");
    expect(starts).toHaveLength(2);
    expect(resolves).toHaveLength(2);

    for (let index = 0; index < starts.length; index++) {
      expect(starts[index]!.tick).toBe(localStarts[index]!.tick);
      expect(starts[index]!.corr).toBe(localStarts[index]!.corr);
      expect(resolves[index]!.tick).toBe(localResolves[index]!.tick);
      expect(resolves[index]!.corr).toBe(starts[index]!.corr);
    }

    const localSent = second.events.find((event) => event.etype === "Sent" && event.subject === "reply")!;
    const localRefused = second.events.find((event) => event.etype === "DeliveryRefused")!;
    const sent = absorbed.find((event) => event.etype === "Sent" && event.subject === "reply")!;
    const refused = absorbed.find((event) => event.etype === "DeliveryRefused")!;
    expect(sent.tick).toBe(localSent.tick);
    expect(sent.corr).toBe(localSent.corr);
    expect(refused.tick).toBe(localRefused.tick);
    expect(refused.corr).toBe(refused.tick);
    expect((refused.payload as { original_corr?: number }).original_corr).toBe(sent.corr);
  });

  it("keeps triggerExternalSource on final ticks after prior absorbed history", async () => {
    const adapter = createAdapter();
    const seeded = await adapter.run({ source: `event Seed(); emit Seed();` });
    expect(seeded.ok).toBe(true);
    const offset = (await adapter.ledgerRead()).length;
    const source = `
      prompt text request;
      event Seen(text value);
      agent Listener {
        when (Prompt p about request) { emit Seen(p.text); }
      }
      spawn Listener listener;
      awake listener;
    `;
    const result = await adapter.triggerExternalSource({
      source,
      sourceName: "request",
      arrival: "hello",
    });
    expect(result.beforeArrival.events[0]?.tick).toBe(offset);
    expect(result.afterArrival.events[0]?.tick).toBe(offset);
    expect(result.afterArrival.events.filter((event) => event.etype === "Seen")).toHaveLength(1);
    expect((await adapter.ledgerRead()).slice(offset)).toEqual(result.afterArrival.events);
  });

  it("keeps idempotencyScenario on final ticks after prior absorbed history", async () => {
    const adapter = createAdapter();
    const seeded = await adapter.run({ source: `event Seed(); emit Seed();` });
    expect(seeded.ok).toBe(true);
    const offset = (await adapter.ledgerRead()).length;
    const source = `
      prompt text request;
      event Seen(text value);
      agent Listener {
        when (Prompt p about request) { emit Seen(p.text); }
      }
      spawn Listener listener;
      awake listener;
    `;
    const result = await adapter.idempotencyScenario({
      source,
      repeatedInput: {
        source: "request",
        idempotencyKey: "same-request",
        body: "hello",
      },
      repetitions: 2,
    });
    expect(result.deduped).toBe(true);
    expect(result.events[0]?.tick).toBe(offset);
    expect(result.events.filter((event) => event.etype === "Seen")).toHaveLength(1);
    expect((await adapter.ledgerRead()).slice(offset)).toEqual(result.events);
  });

  it("preserves user-authored nested record keys that resemble protocol references", async () => {
    const adapter = createAdapter();
    const source = `
      enum Rating { decision_id, pending, corr, original_corr }
      struct UserRecord { decision_id: int, pending: int, corr: int, original_corr: int }
      agent Clerk {
        on awake {
          UserRecord record = UserRecord { decision_id: 7, pending: 11, corr: 13, original_corr: 17 };
          Credence<Rating> c = self <- "rate";
          Decision<Rating> d = decide c by confidence 0;
          if (d.committed == decision_id) {
            Endorsement<UserRecord> e = endorse record by d;
          }
        }
      }
      spawn Clerk clerk;
      awake clerk;
    `;
    const testMode = { provider: { credence: { decision_id: 0.8, pending: 0.1, corr: 0.06, original_corr: 0.04 } } };
    const first = await adapter.run({ source, testMode });
    const second = await adapter.run({ source, testMode });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    const offset = first.events.length;
    const absorbed = (await adapter.ledgerRead()).slice(offset);
    const scoreRecord = (event: { payload?: unknown }) => {
      const payload = event.payload as {
        scores?: Record<string, number>;
        source?: { scores?: Record<string, number> };
        decision?: { source?: { scores?: Record<string, number> } };
      };
      return payload.decision?.source?.scores ?? payload.source?.scores ?? payload.scores;
    };
    for (const etype of ["Decided", "Endorsed"]) {
      const local = second.events.find((event) => event.etype === etype)!;
      const global = absorbed.find((event) => event.etype === etype)!;
      expect(scoreRecord(global), etype).toEqual(scoreRecord(local));
    }
    const localEndorsed = second.events.find((event) => event.etype === "Endorsed")!;
    const globalEndorsed = absorbed.find((event) => event.etype === "Endorsed")!;
    const localSubject = (localEndorsed.payload as { subject_commitment: { fields: Record<string, { value: number }> } })
      .subject_commitment.fields;
    const globalSubject = (globalEndorsed.payload as { subject_commitment: { fields: Record<string, { value: number }> } })
      .subject_commitment.fields;
    expect(globalSubject).toEqual(localSubject);
  });

  it("keeps an assigned-handler subscription live through its owned child completion", async () => {
    const session = createSession(parse(`
      event ChildSeen();
      agent Child { on assigned { complete 7; } }
      agent Parent(Child child) grants { reach Child } {
        on assigned {
          Task<int> childJob = child <- task { objective "child"; acceptance "int"; } expires 10;
          when (TaskCompleted done about childJob) { emit ChildSeen(); }
          complete 1;
        }
      }
      agent Lead(Parent parent) grants { reach Parent } {
        on awake {
          Task<int> parentJob = parent <- task { objective "parent"; acceptance "int"; } expires 10;
        }
      }
      spawn Child child; awake child;
      spawn Parent parent(child); awake parent;
      spawn Lead lead(parent); awake lead;
    `), { identity: TEST_RUNTIME_IDENTITY, memory: new LocalMemoryDriver() });

    await session.start();

    expect(session.snapshot().ledger.events.filter((event) => event.etype === "ChildSeen")).toHaveLength(1);
  });

  it("keeps an assigned-handler subscription live through its owned child expiry", async () => {
    const session = createSession(parse(`
      event ChildExpiredSeen();
      agent Child { on assigned { complete 7; } }
      agent Parent(Child child) grants { reach Child } {
        on assigned {
          Task<int> childJob = child <- task { objective "child"; acceptance "int"; } expires 1;
          when (TaskExpired expired about childJob) { emit ChildExpiredSeen(); }
          complete 1;
        }
      }
      agent Lead(Parent parent) grants { reach Parent } {
        on awake {
          Task<int> parentJob = parent <- task { objective "parent"; acceptance "int"; } expires 10;
        }
      }
      spawn Child child;
      spawn Parent parent(child); awake parent;
      spawn Lead lead(parent); awake lead;
    `), { identity: TEST_RUNTIME_IDENTITY, memory: new LocalMemoryDriver() });

    await session.start();

    expect(session.snapshot().ledger.events.filter((event) => event.etype === "ChildExpiredSeen")).toHaveLength(1);
  });

  it("abandons local subscriptions immediately when their handler faults", async () => {
    const session = createSession(parse(`
      event Ghost();
      agent Worker { on assigned { complete 7; } }
      agent Parent(Worker good, Worker asleep) grants { reach Worker } {
        on assigned {
          Task<int> childJob = good <- task { objective "child"; acceptance "int"; } expires 10;
          when (TaskCompleted done about childJob) { emit Ghost(); }
          int impossible = asleep <- task { objective "fail"; acceptance "int"; } expires 1;
          complete impossible;
        }
      }
      agent Lead(Parent parent) grants { reach Parent } {
        on awake {
          Task<int> parentJob = parent <- task { objective "parent"; acceptance "int"; } expires 10;
        }
      }
      spawn Worker good; awake good;
      spawn Worker asleep;
      spawn Parent parent(good, asleep); awake parent;
      spawn Lead lead(parent); awake lead;
    `), { identity: TEST_RUNTIME_IDENTITY, memory: new LocalMemoryDriver() });

    await session.start();

    const events = session.snapshot().ledger.events;
    expect(events.filter((event) => event.etype === "Ghost")).toHaveLength(0);
    const parentCrash = events.findIndex((event) => event.etype === "AgentCrashed" && event.subject === "parent");
    const childCompletion = events.findIndex((event) => event.etype === "TaskCompleted" && event.subject === "childJob");
    expect(parentCrash).toBeGreaterThanOrEqual(0);
    expect(childCompletion).toBeGreaterThan(parentCrash);
  });
  it("does not assign a persistent handler task to the emitting local scope", async () => {
    const session = createSession(parse(`
      event Trigger();
      event CrossFire();
      agent Worker { on assigned { complete 7; } }
      agent Lead(Worker asleep) grants { reach Worker } {
        on awake {
          when (TaskExpired expired) { emit CrossFire(); }
          emit Trigger();
        }
        when (Trigger trigger) {
          Task<int> job = asleep <- task { objective "child"; acceptance "int"; } expires 1;
        }
      }
      spawn Worker asleep;
      spawn Lead lead(asleep); awake lead;
    `), { identity: TEST_RUNTIME_IDENTITY, memory: new LocalMemoryDriver() });

    await session.start();

    expect(session.snapshot().ledger.events.filter((event) => event.etype === "CrossFire")).toHaveLength(0);
  });


  it("does not assign constructor work to the spawning local scope", async () => {
    const session = createSession(parse(`
      event CrossFire();
      agent Worker { on assigned { complete 7; } }
      agent Maker(Worker asleep) grants { reach Worker } {
        Task<int> job = asleep <- task { objective "child"; acceptance "int"; } expires 1;
      }
      agent Lead(Worker asleep) {
        on awake {
          when (TaskExpired expired) { emit CrossFire(); }
          spawn Maker maker(asleep);
        }
      }
      spawn Worker asleep;
      spawn Lead lead(asleep); awake lead;
    `), { identity: TEST_RUNTIME_IDENTITY, memory: new LocalMemoryDriver() });

    await session.start();

    expect(session.snapshot().ledger.events.filter((event) => event.etype === "CrossFire")).toHaveLength(0);
  });

  it("overlaps sibling task batches independently across parallel function owners", async () => {
    class OwnerOverlapProvider extends MockProvider {
      readonly active = new Map<string, number>();
      readonly maxActive = new Map<string, number>();

      override async structured(prompt: string, schema: StructuredSchema, name?: string, context?: CognitionContext) {
        const task = context?.data.find((segment) => segment.kind === "task");
        const group = task?.kind === "task" ? task.objective.split("-")[0]! : "unknown";
        const active = (this.active.get(group) ?? 0) + 1;
        this.active.set(group, active);
        this.maxActive.set(group, Math.max(this.maxActive.get(group) ?? 0, active));
        await new Promise((resolve) => setTimeout(resolve, 20));
        try {
          return await super.structured(prompt, schema, name, context);
        } finally {
          this.active.set(group, active - 1);
        }
      }
    }

    const provider = new OwnerOverlapProvider();
    const session = createSession(parse(`
      struct Finding { verdict: text }
      event Landed(int owner);
      agent Worker {
        on assigned {
          Finding finding = self <- "assess";
          complete finding;
        }
      }
      int launch(int owner) {
        Worker first = spawn Worker; awake first;
        Worker second = spawn Worker; awake second;
        Task<Finding> left = first <- task { objective f"\${owner}-left"; acceptance "finding"; } expires 100;
        Task<Finding> right = second <- task { objective f"\${owner}-right"; acceptance "finding"; } expires 100;
        when (TaskCompleted done about left) { emit Landed(owner); }
        when (TaskCompleted done about right) { emit Landed(owner); }
        return owner;
      }
      agent Lead grants { reach Worker } {
        on awake {
          int[] owners = [1, 2];
          int[] done = owners |> launch;
        }
      }
      spawn Lead lead; awake lead;
    `), { identity: TEST_RUNTIME_IDENTITY, memory: new LocalMemoryDriver(), provider });

    await session.start();

    expect(provider.maxActive.get("1")).toBeGreaterThanOrEqual(2);
    expect(provider.maxActive.get("2")).toBeGreaterThanOrEqual(2);
    const landed = session.snapshot().ledger.events
      .filter((event) => event.etype === "Landed")
      .map((event) => (event.payload as unknown[])[0]);
    expect(landed.sort()).toEqual(["1", "1", "2", "2"]);
  });

});
