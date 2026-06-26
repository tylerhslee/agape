import { describe, it, expect } from "vitest";
import { reducer, initialState, itemsByStatus, counts, selectedItem, STATUSES } from "./store.js";

const find = (s, id) => s.items.find((i) => i.id === id);

describe("store — runtime scope (STUDIO.md §2)", () => {
  it("is scoped to a selected app runtime", () => {
    expect(initialState.runtime).toBeDefined();
    expect(initialState.runtime.kind).toBe("app");
    expect(initialState.runtime.id).toBeTruthy();
  });
});

describe("store — seed roadmap", () => {
  it("ships a backlog so the roadmap isn't empty", () => {
    expect(itemsByStatus(initialState, "backlog").length).toBeGreaterThan(0);
    expect(itemsByStatus(initialState, "parked").length).toBeGreaterThan(0);
    expect(itemsByStatus(initialState, "done").length).toBeGreaterThan(0);
  });
  it("exposes counts across all statuses", () => {
    const c = counts(initialState);
    for (const s of STATUSES) expect(c[s]).toBeTypeOf("number");
  });
});

describe("store — capture without delegating (the parking lot)", () => {
  it("CREATE_WORK lands a new item in the parking lot, unassigned", () => {
    const s = reducer(initialState, { type: "CREATE_WORK", title: "weekend digest agent" });
    const added = s.items.at(-1);
    expect(added.title).toBe("weekend digest agent");
    expect(added.status).toBe("parked");
    expect(added.assignee).toBeNull();
  });
  it("ignores an empty capture", () => {
    expect(reducer(initialState, { type: "CREATE_WORK", title: "   " }).items.length).toBe(initialState.items.length);
  });
});

describe("store — manual status & editing (no agents)", () => {
  it("SET_STATUS moves an item between columns", () => {
    const id = itemsByStatus(initialState, "parked")[0].id;
    const s = reducer(initialState, { type: "SET_STATUS", id, status: "backlog" });
    expect(find(s, id).status).toBe("backlog");
  });
  it("rejects an unknown status", () => {
    const id = initialState.items[0].id;
    expect(reducer(initialState, { type: "SET_STATUS", id, status: "nonsense" })).toBe(initialState);
  });
  it("EDIT_WORK patches fields", () => {
    const id = initialState.items[0].id;
    const s = reducer(initialState, { type: "EDIT_WORK", id, patch: { destination: "new aim" } });
    expect(find(s, id).destination).toBe("new aim");
  });
  it("DELETE_WORK removes an item and clears selection of it", () => {
    const id = initialState.items[0].id;
    const sel = reducer(initialState, { type: "SELECT", id });
    const s = reducer(sel, { type: "DELETE_WORK", id });
    expect(find(s, id)).toBeUndefined();
    expect(s.selectedId).toBeNull();
  });
});

describe("store — assignment", () => {
  it("DELEGATE makes an item active & delegated with an assignee", () => {
    const id = itemsByStatus(initialState, "backlog")[0].id;
    const s = reducer(initialState, { type: "DELEGATE", id, assignee: "Builder-1" });
    const it = find(s, id);
    expect(it.status).toBe("active");
    expect(it.mode).toBe("delegated");
    expect(it.assignee).toBe("Builder-1");
    expect(it.thread.at(-1).who).toBe("sys");
  });
  it("PAIR makes an item active & paired", () => {
    const id = itemsByStatus(initialState, "backlog")[0].id;
    const it = find(reducer(initialState, { type: "PAIR", id }), id);
    expect(it.status).toBe("active");
    expect(it.mode).toBe("paired");
  });
});

describe("store — selection & thread", () => {
  it("SELECT / CLEAR_SELECT drive the detail spoke", () => {
    const id = initialState.items[0].id;
    const s = reducer(initialState, { type: "SELECT", id });
    expect(selectedItem(s).id).toBe(id);
    expect(selectedItem(reducer(s, { type: "CLEAR_SELECT" }))).toBeNull();
  });
  it("STEER appends a note; empty is a no-op", () => {
    const id = initialState.items[0].id;
    const s = reducer(initialState, { type: "STEER", id, text: "check edge cases" });
    expect(find(s, id).thread.at(-1)).toEqual({ who: "you", text: "check edge cases" });
    expect(reducer(initialState, { type: "STEER", id, text: "  " })).toBe(initialState);
  });

  it("ADD_MESSAGE appends an agent reply from the seam", () => {
    const id = initialState.items[0].id;
    const s = reducer(initialState, { type: "ADD_MESSAGE", id, message: { who: "ai", text: "here's the plan" } });
    expect(find(s, id).thread.at(-1)).toEqual({ who: "ai", text: "here's the plan" });
  });
});
