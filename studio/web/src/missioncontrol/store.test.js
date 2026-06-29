import { describe, it, expect } from "vitest";
import { reducer, initialState, itemsByStatus, counts, selectedItem, STATUSES } from "./store.js";

const find = (s, id) => s.items.find((i) => i.id === id);

describe("store — runtime scope (STUDIO.md §2)", () => {
  it("starts scoped to the active project", () => {
    expect(initialState.runtime).toBeDefined();
    expect(initialState.runtime.kind).toBe("project");
    expect(initialState.runtime.id).toBe("active-project");
  });
});

function stateWithWork(status = "parked") {
  return reducer(initialState, { type: "CREATE_WORK", title: "ship login agent", status });
}

describe("store — first open", () => {
  it("does not ship a canned roadmap or default project", () => {
    expect(initialState.goal).toBe("");
    expect(initialState.items).toEqual([]);
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
  it("can create an already delegated item with an initial thread", () => {
    const s = reducer(initialState, {
      type: "CREATE_WORK",
      id: "w-dashboard",
      title: "inspect project",
      destination: "Inspect - current project",
      status: "active",
      mode: "delegated",
      assignee: "Builder-1",
      thread: [{ who: "you", text: "tell me what this project is about" }],
      select: true,
    });
    const added = s.items.at(-1);
    expect(added.id).toBe("w-dashboard");
    expect(added.status).toBe("active");
    expect(added.mode).toBe("delegated");
    expect(added.assignee).toBe("Builder-1");
    expect(added.thread.at(-1).text).toMatch(/project/);
    expect(s.selectedId).toBe("w-dashboard");
  });
});

describe("store — manual status & editing (no agents)", () => {
  it("SET_STATUS moves an item between columns", () => {
    const start = stateWithWork("parked");
    const id = itemsByStatus(start, "parked")[0].id;
    const s = reducer(start, { type: "SET_STATUS", id, status: "backlog" });
    expect(find(s, id).status).toBe("backlog");
  });
  it("rejects an unknown status", () => {
    const start = stateWithWork();
    const id = start.items[0].id;
    expect(reducer(start, { type: "SET_STATUS", id, status: "nonsense" })).toBe(start);
  });
  it("EDIT_WORK patches fields", () => {
    const start = stateWithWork();
    const id = start.items[0].id;
    const s = reducer(start, { type: "EDIT_WORK", id, patch: { destination: "new aim" } });
    expect(find(s, id).destination).toBe("new aim");
  });
  it("DELETE_WORK removes an item and clears selection of it", () => {
    const start = stateWithWork();
    const id = start.items[0].id;
    const sel = reducer(start, { type: "SELECT", id });
    const s = reducer(sel, { type: "DELETE_WORK", id });
    expect(find(s, id)).toBeUndefined();
    expect(s.selectedId).toBeNull();
  });
});

describe("store — assignment", () => {
  it("DELEGATE makes an item active & delegated with an assignee", () => {
    const start = stateWithWork("backlog");
    const id = itemsByStatus(start, "backlog")[0].id;
    const s = reducer(start, { type: "DELEGATE", id, assignee: "Builder-1" });
    const it = find(s, id);
    expect(it.status).toBe("active");
    expect(it.mode).toBe("delegated");
    expect(it.assignee).toBe("Builder-1");
    expect(it.thread.at(-1).who).toBe("sys");
  });
  it("PAIR makes an item active & paired", () => {
    const start = stateWithWork("backlog");
    const id = itemsByStatus(start, "backlog")[0].id;
    const it = find(reducer(start, { type: "PAIR", id }), id);
    expect(it.status).toBe("active");
    expect(it.mode).toBe("paired");
  });
});

describe("store — selection & thread", () => {
  it("SELECT / CLEAR_SELECT drive the detail spoke", () => {
    const start = stateWithWork();
    const id = start.items[0].id;
    const s = reducer(start, { type: "SELECT", id });
    expect(selectedItem(s).id).toBe(id);
    expect(selectedItem(reducer(s, { type: "CLEAR_SELECT" }))).toBeNull();
  });
  it("STEER appends a note; empty is a no-op", () => {
    const start = stateWithWork();
    const id = start.items[0].id;
    const s = reducer(start, { type: "STEER", id, text: "check edge cases" });
    expect(find(s, id).thread.at(-1)).toEqual({ who: "you", text: "check edge cases" });
    expect(reducer(start, { type: "STEER", id, text: "  " })).toBe(start);
  });

  it("ADD_MESSAGE appends an agent reply from the seam", () => {
    const start = stateWithWork();
    const id = start.items[0].id;
    const s = reducer(start, { type: "ADD_MESSAGE", id, message: { who: "ai", text: "here's the plan" } });
    expect(find(s, id).thread.at(-1)).toEqual({ who: "ai", text: "here's the plan" });
  });
});
