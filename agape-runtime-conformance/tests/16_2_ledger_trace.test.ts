import { beforeEach, describe, expect, it } from "vitest";
import { loadAdapter } from "../src/loader.js";
import { expectGapFreeTicks } from "../src/assertions.js";

const adapter = await loadAdapter();
const suite = adapter ? describe : describe.skip;

suite("SPEC 16.2 ledger journal and trace validity", () => {
  beforeEach(async () => {
    await adapter!.reset();
  });

  it("assigns monotonic gap-free ticks and supports ledger.read filters", async () => {
    const run = await adapter!.run({
      source: `
        event Ping(text id);
        emit Ping("one");
        emit Ping("two");
      `,
    });

    expect(run.ok).toBe(true);
    expectGapFreeTicks(run.events);

    const pings = await adapter!.ledgerRead({ etype: "Ping" });
    expect(pings.length).toBe(2);
    expect(pings.every((e) => e.etype === "Ping")).toBe(true);

    const range = await adapter!.ledgerRead({ fromTick: 1, toTick: 1 });
    expect(range.length).toBe(1);
    expect(range[0].tick).toBe(1);
  });

  it("rejects illegal message lifecycle traces in test mode", async () => {
    const deliveredWithoutSent = await adapter!.validateLedgerTrace([
      { tick: 0, etype: "Delivered", subject: "corr-1", payload: {}, corr: "corr-1", agent: "a" },
    ]);
    expect(deliveredWithoutSent.ok).toBe(false);
    expect(deliveredWithoutSent.diagnostics.some((d) => d.category === "TraceViolation")).toBe(true);

    const resolvedWithoutDelivered = await adapter!.validateLedgerTrace([
      { tick: 0, etype: "Sent", subject: "corr-1", payload: {}, corr: "corr-1", agent: "a" },
      { tick: 1, etype: "Resolved", subject: "corr-1", payload: {}, corr: "corr-1", agent: "a" },
    ]);
    expect(resolvedWithoutDelivered.ok).toBe(false);
    expect(resolvedWithoutDelivered.diagnostics.some((d) => d.category === "TraceViolation")).toBe(true);

    const deliveredAfterExpired = await adapter!.validateLedgerTrace([
      { tick: 0, etype: "Sent", subject: "corr-1", payload: {}, corr: "corr-1", agent: "a" },
      { tick: 1, etype: "Expired", subject: "corr-1", payload: {}, corr: "corr-1", agent: "a" },
      { tick: 2, etype: "Delivered", subject: "corr-1", payload: {}, corr: "corr-1", agent: "a" },
    ]);
    expect(deliveredAfterExpired.ok).toBe(false);
    expect(deliveredAfterExpired.diagnostics.some((d) => d.category === "TraceViolation")).toBe(true);
  });

  it("chain-head changes with canonical content but not with non-canonical storage fields", async () => {
    const base = { tick: 0, etype: "Event", subject: "s", payload: { x: 1 }, corr: "c", agent: "a" };
    const sameWithStorage = { ...base, ts: 100, prev_hash: "ignored", hash: "ignored" };
    const changedPayload = { ...base, payload: { x: 2 }, ts: 100 };

    expect(await adapter!.canonicalHash([base])).toBe(await adapter!.canonicalHash([sameWithStorage]));
    expect(await adapter!.canonicalHash([base])).not.toBe(await adapter!.canonicalHash([changedPayload]));
  });
});
