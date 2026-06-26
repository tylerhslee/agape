import { useState } from "react";
import { STATUSES, STATUS_META, itemsByStatus } from "./store.js";
import { ModeChip } from "./ui.jsx";

// The work board (STUDIO.md §3 "Work streams"): a column per status, capture into
// the parking lot, and manual moves between columns. This is the roadmap surface —
// it works fully with no agents connected.

function Card({ item, dispatch, onOpen }) {
  return (
    <div className="mc-wcard">
      <div className="mc-wcard-title" onClick={() => onOpen(item.id)}>{item.title}</div>
      {item.destination && <div className="mc-wcard-dest">{item.destination}</div>}
      <div className="mc-wcard-meta">
        {item.status === "active" && <ModeChip mode={item.mode} />}
        {item.assignee && <span className="mc-muted-sm"><i className="ti ti-robot" /> {item.assignee}</span>}
      </div>
      <div className="mc-wcard-foot">
        <select
          className="mc-move"
          value={item.status}
          onChange={(e) => dispatch({ type: "SET_STATUS", id: item.id, status: e.target.value })}
          title="move to…"
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>{STATUS_META[s].label}</option>
          ))}
        </select>
        <button className="ghost mc-btn-xs" onClick={() => onOpen(item.id)}>open</button>
        <button className="ghost mc-btn-xs mc-del" onClick={() => dispatch({ type: "DELETE_WORK", id: item.id })} aria-label="delete">
          <i className="ti ti-x" />
        </button>
      </div>
    </div>
  );
}

function Column({ status, items, dispatch, onOpen, onCapture }) {
  const [draft, setDraft] = useState("");
  const meta = STATUS_META[status];
  const capture = () => {
    if (!draft.trim()) return;
    onCapture(draft);
    setDraft("");
  };
  return (
    <div className="mc-bcol">
      <div className="mc-bcol-head">
        <span className={"mc-dot mc-st-" + status} />
        <span className="mc-bcol-label">{meta.label}</span>
        <span className="mc-bcol-count">{items.length}</span>
      </div>
      <div className="mc-bcol-hint">{meta.hint}</div>
      {status === "parked" && (
        <div className="mc-capture">
          <input
            className="mc-capture-input"
            placeholder="+ capture work…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && capture()}
          />
        </div>
      )}
      <div className="mc-bcol-list">
        {items.map((it) => <Card key={it.id} item={it} dispatch={dispatch} onOpen={onOpen} />)}
        {items.length === 0 && status !== "parked" && <div className="mc-bcol-empty">—</div>}
      </div>
    </div>
  );
}

export default function WorkBoard({ state, dispatch, onOpen }) {
  const onCapture = (title) => dispatch({ type: "CREATE_WORK", title });
  return (
    <div className="mc-board-wrap">
      <div className="mc-board-head">
        <span className="mc-board-title"><i className="ti ti-checklist" /> work</span>
        <span className="mc-board-sub">capture into the parking lot, refine into the backlog (your roadmap), then pair or delegate</span>
      </div>
      <div className="mc-board">
        {STATUSES.map((status) => (
          <Column
            key={status}
            status={status}
            items={itemsByStatus(state, status)}
            dispatch={dispatch}
            onOpen={onOpen}
            onCapture={onCapture}
          />
        ))}
      </div>
    </div>
  );
}
