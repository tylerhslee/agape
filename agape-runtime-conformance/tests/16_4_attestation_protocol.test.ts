import { describe, expect, it } from "vitest";
import { loadAdapter } from "../src/loader.js";
import { payloadObject, requireEvent } from "../src/assertions.js";

const adapter = await loadAdapter();
const suite = adapter ? describe : describe.skip;

// SPEC §13 (the attestation protocol) + §16.4 (the identity seam): a principal-prefixed `p decide c by r`
// that cannot commit DEFERS — it appends a durable PendingPrincipalDecision receipt whose tick is the
// correlation id, and the subsequent attested ruling (PrincipalDecision / FailedPrincipalDecision)
// references that correlation id. The pending decision is adapter-visible so a host can render an
// awaiting-decision and route an out-of-band attested response back to it (§17.7).
suite("SPEC 13/16.4 the attestation protocol — pending decision + correlated ruling", () => {
  const SOURCE = `
    enum Approval { Approve, Decline }
    action ReleaseFunds(int cents);
    principal alice;
    agent Clerk grants { perform ReleaseFunds } {
      on awake {
        Credence<Approval> c = self <- "assess this refund request";
        Decision<Approval> d = alice decide c by conformal 0.05;
        if (d.committed == Approve) { Endorsement<Credence<Approval>> e = endorse c by d; perform ReleaseFunds(10000); }
        else if (d.committed == Decline) { emit Event("declined"); }
        else { emit Event("awaiting attestation"); }
      }
    }
    spawn Clerk a; awake a;
  `;

  it("appends a PendingPrincipalDecision receipt before the ruling, correlated by its tick", async () => {
    const run = await adapter!.run({ source: SOURCE, testMode: { principal: "grant" } });
    expect(run.ok).toBe(true);

    const pending = requireEvent(run.events, "PendingPrincipalDecision");
    const ruling = requireEvent(run.events, "PrincipalDecision");

    // the deferral is recorded BEFORE the ruling that resolves it
    expect(pending.tick).toBeLessThan(ruling.tick);
    // the ruling references the pending receipt's tick as its correlation id
    expect(payloadObject(ruling).pending).toBe(pending.tick);
  });

  it("a declined principal records a FailedPrincipalDecision correlated to the same pending decision", async () => {
    const run = await adapter!.run({ source: SOURCE, testMode: { principal: "deny" } });
    expect(run.ok).toBe(true);

    const pending = requireEvent(run.events, "PendingPrincipalDecision");
    const failed = requireEvent(run.events, "FailedPrincipalDecision");
    expect(pending.tick).toBeLessThan(failed.tick);
    expect(payloadObject(failed).pending).toBe(pending.tick);
    // fail-closed: no endorsement, no sink
    expect(run.events.some((e) => e.etype === "PrincipalDecision")).toBe(false);
    expect(run.events.some((e) => e.etype === "ReleaseFunds")).toBe(false);
  });
});
