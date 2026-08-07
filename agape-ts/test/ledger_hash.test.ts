import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { canonicalLedgerEventJson } from "../src/ledger_hash.js";
import { Ledger, type LedgerEvent } from "../src/runtime.js";

const GENESIS_HEX = createHash("sha256").update("agape/v1", "utf8").digest("hex");

function expectedHead(...canonicalEvents: string[]): string {
  let previous = Buffer.from(GENESIS_HEX, "hex");
  for (const event of canonicalEvents) {
    previous = createHash("sha256")
      .update(previous)
      .update(Buffer.from(event, "utf8"))
      .digest();
  }
  return previous.toString("hex");
}

describe("SPEC 16.2 canonical ledger SHA-256 chain", () => {
  it("uses SHA-256('agape/v1') as the empty-ledger genesis head", () => {
    expect(new Ledger(0).head()).toBe(GENESIS_HEX);
    expect(GENESIS_HEX).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashes one exact six-field record and fills absent fields deterministically", () => {
    const ledger = new Ledger(0);
    ledger.append("Booted", "runtime");

    const canonical =
      '{"tick":0,"etype":"Booted","subject":"runtime","payload":null,"corr":null,"agent":""}';
    expect(ledger.head()).toBe(expectedHead(canonical));
    expect(ledger.head()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("feeds previous digest bytes, not hex text, into the second link", () => {
    const ledger = new Ledger(0);
    ledger.append("One", "s", { n: 1 });
    ledger.append("Two", "s", { n: 2 }, "a");

    const one =
      '{"tick":0,"etype":"One","subject":"s","payload":{"n":1},"corr":null,"agent":""}';
    const two =
      '{"tick":1,"etype":"Two","subject":"s","payload":{"n":2},"corr":null,"agent":"a"}';
    expect(ledger.head()).toBe(expectedHead(one, two));
  });

  it("canonicalizes nested payload key order, numbers, strings, and UTF-8", () => {
    const ledger = new Ledger(0);
    ledger.append("Observed", "subject-\u96ea", {
      z: true,
      list: [1, 1.5, -2.25e-7],
      a: { b: 0.000001, a: "line\n\u96ea" },
    }, "agent-1", "corr-1");

    const canonical =
      '{"tick":0,"etype":"Observed","subject":"subject-\u96ea","payload":{"a":{"a":"line\\n\u96ea","b":1e-6},"list":[1,1.5,-225e-9],"z":true},"corr":"corr-1","agent":"agent-1"}';
    expect(ledger.head()).toBe(expectedHead(canonical));
  });

  it("excludes latency metadata by content-equivalent journals with different origins", () => {
    const earlyOrigin = new Ledger(0);
    const lateOrigin = new Ledger(Date.now() + 1_000_000);
    earlyOrigin.append("Event", "s", { x: 1 }, "a", "c");
    lateOrigin.append("Event", "s", { x: 1 }, "a", "c");

    expect(earlyOrigin.events[0]!.elapsed_ms).not.toBe(lateOrigin.events[0]!.elapsed_ms);
    expect(earlyOrigin.head()).toBe(lateOrigin.head());
  });

  it("changes the head when corr or payload changes", () => {
    const base = new Ledger(0);
    const changedCorr = new Ledger(0);
    const changedPayload = new Ledger(0);
    base.append("Event", "s", { x: 1 }, "a", "c-1");
    changedCorr.append("Event", "s", { x: 1 }, "a", "c-2");
    changedPayload.append("Event", "s", { x: 2 }, "a", "c-1");

    expect(changedCorr.head()).not.toBe(base.head());
    expect(changedPayload.head()).not.toBe(base.head());
  });

  it("freezes committed events and nested payloads before notifying observers", () => {
    let eventMutation: boolean | undefined;
    let nestedMutation: boolean | undefined;
    const payload = { nested: { a: 1 } };
    const ledger = new Ledger(0, (observed) => {
      eventMutation = Reflect.set(observed, "tick", 99);
      nestedMutation = Reflect.set((observed.payload as typeof payload).nested, "a", 999);
    });
    const event = ledger.append("Observed", "stable", payload, "agent");

    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.payload)).toBe(true);
    expect(Object.isFrozen((event.payload as typeof payload).nested)).toBe(true);
    expect(eventMutation).toBe(false);
    expect(nestedMutation).toBe(false);
    expect(event).toMatchObject({
      tick: 0,
      etype: "Observed",
      subject: "stable",
      payload: { nested: { a: 1 } },
      agent: "agent",
    });
  });

  it("reproduces the same head for identical replayed journal content", () => {
    const record = (ledger: Ledger): void => {
      ledger.append("First", "\u03b1", { b: 2, a: "\u00e9" }, "agent", "join");
      ledger.append("Second", "\u03b2");
    };
    const live = new Ledger(1);
    const replay = new Ledger(9_999_999);
    record(live);
    record(replay);

    expect(replay.head()).toBe(live.head());
    expect(replay.head()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("uses shortest round-trip number spelling without an optional positive exponent sign", () => {
    const json = canonicalLedgerEventJson({
      tick: 0,
      etype: "Numbers",
      subject: "boundary",
      payload: {
        positiveExponentBoundary: 1e21,
        largerPositiveExponent: 1e30,
        negativeExponent: 1e-7,
        fixedLower: 1e-6,
        fixedUpper: 1e20,
        shorterScientificLarge: 1230000,
        shorterScientificSmall: 0.0000123,
        negativeShorterScientific: -0.0000123,
        negativeZero: -0,
      },
    });

    expect(json).toBe(
      '{"tick":0,"etype":"Numbers","subject":"boundary","payload":{"fixedLower":1e-6,"fixedUpper":1e20,"largerPositiveExponent":1e30,"negativeExponent":1e-7,"negativeShorterScientific":-123e-7,"negativeZero":0,"positiveExponentBoundary":1e21,"shorterScientificLarge":123e4,"shorterScientificSmall":123e-7},"corr":null,"agent":""}',
    );
    const parsed = JSON.parse(json) as { payload: Record<string, number> };
    const original: Record<string, number> = {
      positiveExponentBoundary: 1e21,
      largerPositiveExponent: 1e30,
      negativeExponent: 1e-7,
      fixedLower: 1e-6,
      fixedUpper: 1e20,
      shorterScientificLarge: 1230000,
      shorterScientificSmall: 0.0000123,
      negativeShorterScientific: -0.0000123,
    };
    for (const [key, value] of Object.entries(original)) {
      expect(Object.is(parsed.payload[key], value), key).toBe(true);
    }
    expect(Object.is(parsed.payload.negativeZero, 0)).toBe(true);

  });
  it("chooses the shortest valid mantissa placement across exponent digit boundaries", () => {
    const values = {
      positiveCross: 1.2e10,
      positiveSingle: 1.2e9,
      negativeTie: 1.2e-9,
      negativeShorter: 1.2e-8,
    };
    const json = canonicalLedgerEventJson({
      tick: 0,
      etype: "Numbers",
      subject: "mantissa",
      payload: values,
    });

    expect(json).toBe(
      '{"tick":0,"etype":"Numbers","subject":"mantissa","payload":{"negativeShorter":12e-9,"negativeTie":1.2e-9,"positiveCross":12e9,"positiveSingle":12e8},"corr":null,"agent":""}',
    );
    const parsed = (JSON.parse(json) as { payload: Record<string, number> }).payload;
    for (const [key, value] of Object.entries(values)) {
      expect(Object.is(parsed[key], value), key).toBe(true);
    }
  });

  it("publishes the same normalized absent canonical fields that it hashes", () => {
    let observed: LedgerEvent | undefined;
    const ledger = new Ledger(0, (event) => { observed = event; });
    const event = ledger.append("Booted", "runtime");

    expect(event.payload).toBeNull();
    expect(event.corr).toBeNull();
    expect(event.agent).toBe("");
    expect(observed).toBe(event);
    expect(canonicalLedgerEventJson(event)).toBe(
      '{"tick":0,"etype":"Booted","subject":"runtime","payload":null,"corr":null,"agent":""}',
    );
  });
  const validRestoredEvent = (overrides: Partial<LedgerEvent> = {}): LedgerEvent => ({
    tick: 0, latency_ms: 0, elapsed_ms: 0,
    etype: "Booted", subject: "runtime", payload: null, corr: null, agent: "",
    ...overrides,
  });

  it("restores exact immutable event metadata and continues at the next tick", () => {
    const source: LedgerEvent[] = [
      {
        tick: 0, latency_ms: 11, elapsed_ms: 11,
        etype: "Spawned", subject: "agent-1", payload: { b: 2, a: { nested: 1 } }, corr: null, agent: "agent-1",
      },
      {
        tick: 1, latency_ms: 5, elapsed_ms: 16,
        etype: "Internalized", subject: "memory-1", payload: { ok: true }, corr: "corr-1", agent: "agent-1",
      },
    ];
    const observed: LedgerEvent[] = [];
    const restored = Ledger.restore(source, (event) => observed.push(event));

    expect(restored.events).toEqual(source);
    expect(restored.events[0]).not.toBe(source[0]);
    expect(Object.isFrozen(restored.events)).toBe(true);
    expect(restored.events.every(Object.isFrozen)).toBe(true);
    expect(observed).toEqual([]);
    expect(restored.events[0]!.payload).not.toBe(source[0]!.payload);
    expect(Object.isFrozen(restored.events[0]!.payload)).toBe(true);
    expect(Object.isFrozen((restored.events[0]!.payload as { a: object }).a)).toBe(true);
    (source[0]!.payload as { a: { nested: number } }).a.nested = 99;
    expect(restored.events[0]!.payload).toEqual({ a: { nested: 1 }, b: 2 });

    const equivalent = new Ledger(0);
    equivalent.append("Spawned", "agent-1", { a: { nested: 1 }, b: 2 }, "agent-1", null);
    equivalent.append("Internalized", "memory-1", { ok: true }, "agent-1", "corr-1");
    expect(restored.head()).toBe(equivalent.head());

    const appended = restored.append("Continued", "runtime");
    expect(appended.tick).toBe(2);
    expect(appended.elapsed_ms).toBeGreaterThanOrEqual(16);
    expect(observed).toEqual([appended]);
  });

  it("rejects malformed restored ledger order and timing metadata", () => {
    const valid = validRestoredEvent();
    expect(() => Ledger.restore([{ ...valid, tick: 1 }])).toThrow("ticks are not contiguous");
    expect(() => Ledger.restore([{ ...valid, elapsed_ms: -1 }])).toThrow("timing metadata is invalid");
    expect(() => Ledger.restore([{ ...valid, latency_ms: 0.5 }])).toThrow("timing metadata is invalid");
    expect(() => Ledger.restore([
      validRestoredEvent({ latency_ms: 4, elapsed_ms: 4 }),
      validRestoredEvent({ tick: 1, elapsed_ms: 3 }),
    ])).toThrow("elapsed timing is not nondecreasing");
    expect(() => Ledger.restore([{ ...valid, latency_ms: 2, elapsed_ms: 1 }]))
      .toThrow("latency exceeds elapsed timing");
    expect(() => Ledger.restore([
      validRestoredEvent({ latency_ms: 10, elapsed_ms: 10 }),
      validRestoredEvent({ tick: 1, latency_ms: 1, elapsed_ms: 20 }),
    ])).toThrow("latency does not match elapsed timing delta");
  });

  it("rejects non-ordinary, sparse, accessor-backed, and decorated event arrays", () => {
    const valid = validRestoredEvent();
    const sparse = new Array<LedgerEvent>(1);
    const custom = [valid];
    Object.setPrototypeOf(custom, Object.create(Array.prototype));
    const decorated = [valid] as LedgerEvent[] & { extra?: boolean };
    decorated.extra = true;
    const symbolic = [valid];
    Object.defineProperty(symbolic, Symbol("hidden"), { value: true });
    let reads = 0;
    const accessor = [valid];
    Object.defineProperty(accessor, "0", {
      get() { reads += 1; return valid; }, enumerable: true, configurable: true,
    });

    expect(() => Ledger.restore({ 0: valid, length: 1 } as unknown as LedgerEvent[]))
      .toThrow("ordinary array");
    expect(() => Ledger.restore(custom)).toThrow("ordinary array");
    expect(() => Ledger.restore(sparse)).toThrow("dense");
    expect(() => Ledger.restore(decorated)).toThrow("dense");
    expect(() => Ledger.restore(symbolic)).toThrow("symbol");
    expect(() => Ledger.restore(accessor)).toThrow("enumerable data property");
    expect(reads).toBe(0);
  });

  it("rejects Proxy containers before invoking reflective traps", () => {
    const valid = validRestoredEvent();
    let traps = 0;
    const handler: ProxyHandler<object> = {
      getPrototypeOf() { traps += 1; return Object.prototype; },
      ownKeys(target) { traps += 1; return Reflect.ownKeys(target); },
      getOwnPropertyDescriptor(target, property) {
        traps += 1; return Reflect.getOwnPropertyDescriptor(target, property);
      },
    };
    const arrayProxy = new Proxy([valid], handler as ProxyHandler<LedgerEvent[]>);
    expect(() => Ledger.restore(arrayProxy)).toThrow("must not be a Proxy");
    expect(traps).toBe(0);

    const eventProxy = new Proxy(valid, handler as ProxyHandler<LedgerEvent>);
    expect(() => Ledger.restore([eventProxy])).toThrow("must not be a Proxy");
    expect(traps).toBe(0);

    const nestedProxy = new Proxy({ safe: true }, handler);
    expect(() => Ledger.restore([validRestoredEvent({ payload: { nested: nestedProxy } })]))
      .toThrow("must not contain Proxies");
    expect(traps).toBe(0);
  });

  it("validates exact plain eight-field records before reading any field", () => {
    const valid = validRestoredEvent();
    const { payload: _payload, ...missingPayload } = valid;
    const extra = { ...valid, extra: true };
    const hidden = { ...valid };
    Object.defineProperty(hidden, "subject", { value: "runtime", enumerable: false });
    const symbolic = { ...valid };
    Object.defineProperty(symbolic, Symbol("hidden"), { value: true });
    const polluted = Object.assign(Object.create({ polluted: true }), valid) as LedgerEvent;
    let reads = 0;
    const accessor = { ...valid };
    Object.defineProperty(accessor, "tick", {
      get() { reads += 1; return 0; }, enumerable: true, configurable: true,
    });

    expect(() => Ledger.restore([missingPayload as LedgerEvent])).toThrow("exactly the eight ledger fields");
    expect(() => Ledger.restore([extra])).toThrow("exactly the eight ledger fields");
    expect(() => Ledger.restore([hidden])).toThrow("enumerable data property");
    expect(() => Ledger.restore([symbolic])).toThrow("symbol");
    expect(() => Ledger.restore([polluted])).toThrow("plain data record");
    expect(() => Ledger.restore([accessor])).toThrow("enumerable data property");
    expect(reads).toBe(0);
  });

  it("rejects undefined, accessor, hidden, symbolic, cyclic, and custom-prototype payload data", () => {
    const undefinedRoot = validRestoredEvent({ payload: undefined });
    const undefinedMember = validRestoredEvent({ payload: { missing: undefined } });
    const hiddenPayload = {};
    Object.defineProperty(hiddenPayload, "hidden", { value: true, enumerable: false });
    const symbolicPayload = {};
    Object.defineProperty(symbolicPayload, Symbol("hidden"), { value: true });
    const pollutedPayload = Object.create({ polluted: true }) as Record<string, unknown>;
    pollutedPayload.safe = true;
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    let reads = 0;
    const accessorPayload = {};
    Object.defineProperty(accessorPayload, "secret", {
      get() { reads += 1; return "not-read"; }, enumerable: true, configurable: true,
    });

    expect(() => Ledger.restore([undefinedRoot])).toThrow("payload must be present and defined");
    expect(() => Ledger.restore([undefinedMember])).toThrow("defined JSON data");
    expect(() => Ledger.restore([validRestoredEvent({ payload: hiddenPayload })])).toThrow("enumerable data property");
    expect(() => Ledger.restore([validRestoredEvent({ payload: symbolicPayload })])).toThrow("symbol");
    expect(() => Ledger.restore([validRestoredEvent({ payload: pollutedPayload })])).toThrow("plain JSON objects");
    expect(() => Ledger.restore([validRestoredEvent({ payload: cyclic })])).toThrow("cycle");
    expect(() => Ledger.restore([validRestoredEvent({ payload: accessorPayload })])).toThrow("enumerable data property");
    expect(reads).toBe(0);
  });

  it("rejects recursively tampered payload arrays without invoking accessors", () => {
    const sparse = new Array<unknown>(1);
    const decorated = [true] as unknown[] & { extra?: boolean };
    decorated.extra = true;
    const custom = [true];
    Object.setPrototypeOf(custom, Object.create(Array.prototype));
    let reads = 0;
    const accessor = [true];
    Object.defineProperty(accessor, "0", {
      get() { reads += 1; return true; }, enumerable: true, configurable: true,
    });

    expect(() => Ledger.restore([validRestoredEvent({ payload: { nested: sparse } })])).toThrow("dense");
    expect(() => Ledger.restore([validRestoredEvent({ payload: { nested: decorated } })])).toThrow("dense");
    expect(() => Ledger.restore([validRestoredEvent({ payload: { nested: custom } })])).toThrow("ordinary arrays");
    expect(() => Ledger.restore([validRestoredEvent({ payload: { nested: accessor } })]))
      .toThrow("enumerable data property");
    expect(reads).toBe(0);
  });

  it("anchors appended timing to hydration without replaying restored events", () => {
    const clock = vi.spyOn(Date, "now")
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(900)
      .mockReturnValueOnce(1_025);
    try {
      const observed: LedgerEvent[] = [];
      const restored = Ledger.restore([
        validRestoredEvent({ latency_ms: 40, elapsed_ms: 40 }),
      ], (event) => observed.push(event));
      expect(observed).toEqual([]);

      const duringRollback = restored.append("ClockRolledBack", "runtime");
      expect(duringRollback).toMatchObject({ tick: 1, latency_ms: 0, elapsed_ms: 40 });
      const afterRecovery = restored.append("Continued", "runtime");
      expect(afterRecovery).toMatchObject({ tick: 2, latency_ms: 25, elapsed_ms: 65 });
      expect(observed).toEqual([duringRollback, afterRecovery]);
    } finally {
      clock.mockRestore();
    }
  });

});
