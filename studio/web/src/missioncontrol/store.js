// Studio — the work-centric store.
//
// A collection of work items the human manages by hand, plus the runtime scope it
// belongs to (STUDIO.md §2). This is the studio's *somatic* core: every action
// here is an operation that needs no agents — capture, status, edit, assign. The
// agentic backend (Agape operators) slots in later to drive items autonomously; it
// does not change this surface. Kept a pure reducer so it is trivially testable and
// later swappable for calls across the API seam.

import { useEffect, useReducer } from "react";

// The work-item lifecycle (STUDIO.md §5.1). Order here is the board's column order.
export const STATUSES = ["parked", "backlog", "active", "waiting", "done"];

export const STATUS_META = {
  parked: { label: "parking lot", hint: "captured, not scheduled" },
  backlog: { label: "backlog", hint: "planned — the roadmap" },
  active: { label: "in progress", hint: "being worked" },
  waiting: { label: "needs you", hint: "a decision or review" },
  done: { label: "done", hint: "delivered" },
};

let _seq = 1;
const nextId = () => `w${_seq++}`;

function makeItem(title, destination, status, extra = {}) {
  return {
    id: nextId(),
    title,
    destination,
    status,
    assignee: null,
    mode: "paired", // meaningful once active: "paired" | "delegated"
    thread: [],
    order: _seq, // creation order; the board sorts on this
    ...extra,
  };
}

export const initialState = {
  // The selected app runtime this studio surface is scoped to (STUDIO.md §2).
  runtime: { id: "active-project", name: "active project", kind: "project" },
  goal: "",
  items: [],
  selectedId: null,
};

function isRetiredSeedState(state) {
  return state?.runtime?.id === "app-factcheck" ||
    state?.goal === "build v1 fact-checker — claim → criteria → verdict";
}

function readStoredState() {
  try {
    const raw = localStorage.getItem("agape.studioState");
    if (!raw) return initialState;
    const parsed = JSON.parse(raw);
    if (isRetiredSeedState(parsed)) return initialState;
    if (!parsed || !Array.isArray(parsed.items)) return initialState;
    let maxId = 0;
    for (const item of parsed.items) {
      const n = Number(String(item.id || "").replace(/^w/, ""));
      if (Number.isFinite(n)) maxId = Math.max(maxId, n);
    }
    _seq = Math.max(_seq, maxId + 1);
    return {
      ...initialState,
      ...parsed,
      selectedId: null,
      runtime: parsed.runtime || initialState.runtime,
      items: parsed.items,
    };
  } catch {
    return initialState;
  }
}

function persistState(state) {
  try {
    localStorage.setItem("agape.studioState", JSON.stringify({
      runtime: state.runtime,
      goal: state.goal,
      items: state.items,
    }));
  } catch {}
}

function patchItem(state, id, fn) {
  return { ...state, items: state.items.map((it) => (it.id === id ? fn(it) : it)) };
}

export function reducer(state, action) {
  switch (action.type) {
    // ── capture & lifecycle (somatic — no agents needed) ──
    case "CREATE_WORK": {
      const title = (action.title || "").trim();
      if (!title) return state;
      const status = STATUSES.includes(action.status) ? action.status : "parked";
      const it = makeItem(title, action.destination || "", status);
      return { ...state, items: [...state.items, it] };
    }

    case "SET_STATUS":
      if (!STATUSES.includes(action.status)) return state;
      return patchItem(state, action.id, (it) => ({ ...it, status: action.status }));

    case "EDIT_WORK":
      return patchItem(state, action.id, (it) => ({ ...it, ...action.patch }));

    case "DELETE_WORK":
      return {
        ...state,
        items: state.items.filter((it) => it.id !== action.id),
        selectedId: state.selectedId === action.id ? null : state.selectedId,
      };

    // ── assignment (sets state today; an agent acts on it once the backend lands) ──
    case "DELEGATE":
      return patchItem(state, action.id, (it) => ({
        ...it,
        status: "active",
        mode: "delegated",
        assignee: action.assignee || it.assignee || "unassigned",
        thread: [...it.thread, { who: "sys", text: `Delegated to ${action.assignee || "an agent"} — will run once the agentic backend is connected.` }],
      }));

    case "PAIR":
      return patchItem(state, action.id, (it) => ({ ...it, status: "active", mode: "paired" }));

    // ── selection & thread ──
    case "SELECT":
      return { ...state, selectedId: action.id };
    case "CLEAR_SELECT":
      return { ...state, selectedId: null };

    case "STEER": {
      const text = (action.text || "").trim();
      if (!text) return state;
      return patchItem(state, action.id, (it) => ({ ...it, thread: [...it.thread, { who: "you", text }] }));
    }

    // Append a message from any source (used for agent replies from the seam).
    case "ADD_MESSAGE":
      if (!action.message) return state;
      return patchItem(state, action.id, (it) => ({ ...it, thread: [...it.thread, action.message] }));

    default:
      return state;
  }
}

export function useStudio() {
  const pair = useReducer(reducer, undefined, readStoredState);
  const [state] = pair;
  useEffect(() => persistState(state), [state]);
  return pair;
}

// ── selectors ──
export function itemsByStatus(state, status) {
  return state.items.filter((it) => it.status === status).sort((a, b) => a.order - b.order);
}
export function counts(state) {
  return STATUSES.reduce((acc, s) => ((acc[s] = itemsByStatus(state, s).length), acc), {});
}
export function selectedItem(state) {
  return state.items.find((it) => it.id === state.selectedId) || null;
}
