import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
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
});
