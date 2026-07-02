import { beforeEach, describe, expect, it } from "vitest";
import { loadAdapter } from "../src/loader.js";

const adapter = await loadAdapter();
const suite = adapter ? describe : describe.skip;

suite("SPEC 16.7a projections, stale state, and conflicts", () => {
  beforeEach(async () => {
    await adapter!.reset();
  });

  it("tracks basisHead, validThrough, dependencyScope, and stales affected projection cells", async () => {
    const initial = await adapter!.seedProjection({
      name: "single-valued-status",
      facts: [{ subject: "ticket-1", key: "status", value: "open", taint: "settled", singleValued: true }],
    });
    const cell = initial.cells.find((c) => c.key === "ticket-1.status");
    expect(cell).toBeTruthy();
    expect(Number.isInteger(cell!.basisHead)).toBe(true);
    expect(Number.isInteger(cell!.validThrough)).toBe(true);
    expect(Array.isArray(cell!.dependencyScope) || cell!.dependencyScope === "global").toBe(true);
    expect(cell!.stale).toBe(false);

    const changed = await adapter!.seedProjection({
      name: "single-valued-status",
      facts: [{ subject: "ticket-1", key: "status", value: "open", taint: "settled", singleValued: true }],
      mutation: { subject: "ticket-1", key: "status", value: "closed", taint: "settled" },
    });
    const stale = changed.cells.find((c) => c.key === "ticket-1.status" && c.value === "open");
    expect(stale?.stale).toBe(true);
  });

  it("projects conflicts for incompatible settled facts without treating Conflict as a language enum", async () => {
    const projection = await adapter!.seedProjection({
      name: "single-valued-owner",
      facts: [
        { subject: "lease-1", key: "owner", value: "alice", taint: "settled", singleValued: true },
        { subject: "lease-1", key: "owner", value: "bob", taint: "settled", singleValued: true },
      ],
    });

    const conflict = projection.conflicts.find((c) => c.subject === "lease-1" && c.invariant.includes("owner"));
    expect(conflict).toBeTruthy();
    expect(conflict!.status).toBe("open");
    expect(Number.isInteger(conflict!.detectedAt)).toBe(true);
    expect(conflict!.facts.length).toBeGreaterThanOrEqual(2);
  });
});
