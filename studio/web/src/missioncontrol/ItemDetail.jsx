import { useState } from "react";
import { STATUSES, STATUS_META } from "./store.js";
import { StatusChip, ModeChip } from "./ui.jsx";
import { agentRespond } from "./agentApi.js";

// The detail spoke (STUDIO.md hub-and-spoke): open one work item to edit it, change
// its status, assign it, and pair with its agent. Sending a note or delegating calls
// the agentic seam (agentApi → the Claude-backed agent server today). All edits and
// status changes remain manual and need no backend.
export default function ItemDetail({ item, dispatch, onClose }) {
  const [assignee, setAssignee] = useState("Builder-1");
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);

  const edit = (patch) => dispatch({ type: "EDIT_WORK", id: item.id, patch });
  const setStatus = (status) => dispatch({ type: "SET_STATUS", id: item.id, status });

  // Run an agent turn against the seam, appending its reply (or an error breadcrumb).
  const runAgent = async (contextItem, thread, intent) => {
    setPending(true);
    setError(null);
    try {
      const text = await agentRespond(contextItem, thread, intent);
      dispatch({ type: "ADD_MESSAGE", id: item.id, message: { who: "ai", text } });
    } catch (e) {
      setError(e.message);
      dispatch({ type: "ADD_MESSAGE", id: item.id, message: { who: "sys", text: `agent unavailable — ${e.message}` } });
    } finally {
      setPending(false);
    }
  };

  const send = async () => {
    const text = note.trim();
    if (!text || pending) return;
    dispatch({ type: "STEER", id: item.id, text });
    setNote("");
    await runAgent(item, [...item.thread, { who: "you", text }], "respond");
  };

  const delegate = async () => {
    if (pending) return;
    dispatch({ type: "DELEGATE", id: item.id, assignee });
    await runAgent({ ...item, status: "active", mode: "delegated", assignee }, item.thread, "kickoff");
  };

  return (
    <div className="mc-col">
      <div className="mc-detail-head">
        <button className="ghost mc-btn-sm" onClick={onClose}><i className="ti ti-arrow-left" /> back</button>
        <StatusChip status={item.status} />
        {item.status === "active" && <ModeChip mode={item.mode} />}
        <button className="ghost mc-btn-sm mc-right mc-del" onClick={() => dispatch({ type: "DELETE_WORK", id: item.id })}>
          <i className="ti ti-trash" /> delete
        </button>
      </div>

      <input className="mc-detail-title" value={item.title} onChange={(e) => edit({ title: e.target.value })} />
      <textarea
        className="mc-detail-dest"
        placeholder="destination — what this is converging on"
        value={item.destination}
        onChange={(e) => edit({ destination: e.target.value })}
      />

      <div className="mc-detail-controls">
        <div className="mc-field">
          <label>status</label>
          <select value={item.status} onChange={(e) => setStatus(e.target.value)}>
            {STATUSES.map((s) => <option key={s} value={s}>{STATUS_META[s].label}</option>)}
          </select>
        </div>
        <div className="mc-field">
          <label>assign</label>
          <div className="mc-assign-row">
            <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              <option>Builder-1</option>
              <option>Builder-2</option>
            </select>
            <button className="mc-btn-sm" onClick={delegate} disabled={pending}>delegate</button>
            <button className="ghost mc-btn-sm" onClick={() => dispatch({ type: "PAIR", id: item.id })}>pair</button>
          </div>
        </div>
      </div>

      <div className="mc-section-title"><i className="ti ti-message-2" /> thread</div>
      <div className="mc-thread">
        {item.thread.length === 0 && <div className="mc-needs-empty">no messages yet — say something, or delegate to kick the agent off.</div>}
        {item.thread.map((m, i) =>
          m.who === "sys" ? (
            <div key={i} className="mc-msg-sys">{m.text}</div>
          ) : (
            <div key={i} className={"mc-msg-row" + (m.who === "you" ? " you" : "")}>
              <div className={"mc-msg " + (m.who === "you" ? "mc-msg-you" : "mc-msg-ai")}>
                {m.who === "ai" && <div className="mc-msg-who"><i className="ti ti-sparkles" /> {item.assignee || "agent"}</div>}
                {m.text}
              </div>
            </div>
          )
        )}
        {pending && <div className="mc-msg-sys"><i className="ti ti-loader" /> the agent is thinking…</div>}
        <div className="mc-input-row">
          <input
            className="mc-input"
            placeholder="message the agent…"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
            disabled={pending}
          />
          <button className="mc-btn-sm" onClick={send} disabled={pending}>send</button>
        </div>
        {error && <div className="mc-muted-sm mc-thread-note" style={{ color: "var(--vsc-error)" }}><i className="ti ti-alert-triangle" /> {error}</div>}
        <div className="mc-muted-sm mc-thread-note">
          <i className="ti ti-info-circle" /> replies come from the Claude-backed agent server (studio/agent-server) — the Agape backend slots in behind the same seam.
        </div>
      </div>
    </div>
  );
}
