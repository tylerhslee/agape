import { itemsByStatus, counts } from "./store.js";
import { StatusDot, ModeChip } from "./ui.jsx";

// The dashboard (STUDIO.md §4): what needs me, and is the fleet healthy — read from
// the work collection. With no agentic backend connected, the fleet is empty and
// every transition is manual; the dashboard says so honestly.
function Metric({ label, value, warn, onClick }) {
  return (
    <div className={"mc-metric" + (onClick ? " clickable" : "")} onClick={onClick}>
      <div className="mc-metric-label">{label}</div>
      <div className={"mc-metric-value" + (warn ? " warn" : "")}>{value}</div>
    </div>
  );
}

function Row({ item, onOpen }) {
  return (
    <div className="mc-list-row" onClick={() => onOpen(item.id)}>
      <StatusDot status={item.status} />
      <span className="mc-list-title">{item.title}</span>
      {item.status === "active" && <ModeChip mode={item.mode} />}
      {item.assignee && <span className="mc-muted-sm"><i className="ti ti-robot" /> {item.assignee}</span>}
      <i className="ti ti-chevron-right mc-list-go" />
    </div>
  );
}

export default function MissionControl({ state, onOpen, goWork }) {
  const c = counts(state);
  const waiting = itemsByStatus(state, "waiting");
  const active = itemsByStatus(state, "active");

  return (
    <div className="mc-col">
      <div className="mc-banner">
        <i className="ti ti-flag mc-flag" />
        <span className="mc-banner-title">{state.goal}</span>
        <span className="mc-banner-status ok">{state.runtime.name} runtime</span>
      </div>

      <div className="mc-metrics mc-metrics-4">
        <Metric label="needs you" value={c.waiting} warn={c.waiting > 0} />
        <Metric label="in progress" value={c.active} />
        <Metric label="backlog" value={c.backlog} onClick={goWork} />
        <Metric label="done" value={c.done} />
      </div>

      <div className="mc-section-title"><i className="ti ti-bell mc-warn-i" /> needs you</div>
      {waiting.length ? (
        <div className="mc-list">{waiting.map((it) => <Row key={it.id} item={it} onOpen={onOpen} />)}</div>
      ) : (
        <div className="mc-needs-empty"><i className="ti ti-coffee" /> nothing needs you right now.</div>
      )}

      <div className="mc-section-title"><i className="ti ti-activity" /> in progress</div>
      {active.length ? (
        <div className="mc-list">{active.map((it) => <Row key={it.id} item={it} onOpen={onOpen} />)}</div>
      ) : (
        <div className="mc-needs-empty">
          nothing in progress — <span className="mc-link" onClick={goWork}>open the work board</span> to start something.
        </div>
      )}

      <div className="mc-section-title"><i className="ti ti-robot" /> fleet</div>
      <div className="mc-fleet-empty">
        <i className="ti ti-plug-off" />
        <div>
          <div>no agents connected.</div>
          <div className="mc-muted-sm">Slot in the Agape agentic backend to see operators routing and delegating. Until then, manage all work by hand on the <span className="mc-link" onClick={goWork}>work board</span>.</div>
        </div>
      </div>
    </div>
  );
}
