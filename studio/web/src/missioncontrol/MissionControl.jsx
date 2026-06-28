import { itemsByStatus, counts } from "./store.js";
import { StatusDot, ModeChip } from "./ui.jsx";

function Metric({ label, value, tone, onClick }) {
  return (
    <div className={"mc-metric" + (onClick ? " clickable" : "") + (tone ? " " + tone : "")} onClick={onClick}>
      <div className="mc-metric-label">{label}</div>
      <div className="mc-metric-value">{value}</div>
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

export default function MissionControl({ state, info, onOpen, goWork, goRun, goFiles, goStudio }) {
  const c = counts(state);
  const waiting = itemsByStatus(state, "waiting");
  const active = itemsByStatus(state, "active");
  const agents = (info?.files || []).flatMap((f) => f.agents.map((name) => ({ name, file: f.rel })));
  const prompts = (info?.files || []).flatMap((f) => f.prompts.map((name) => ({ name, file: f.rel })));

  return (
    <div className="mc-home">
      <section className="mc-command">
        <div className="mc-command-copy">
          <div className="mc-kicker"><i className="ti ti-heart-handshake" /> Agape Studio</div>
          <h1>{state.goal}</h1>
          <p>Coordinate agentic work, inspect authority and gates, run ledger-backed programs, and teach the builder how to write Agape.</p>
        </div>
        <div className="mc-command-actions">
          <button className="accent" onClick={goStudio}><i className="ti ti-sparkles" /> Open builder</button>
          <button onClick={goRun}><i className="ti ti-player-play" /> Run project</button>
          <button className="ghost" onClick={goFiles}><i className="ti ti-file-code" /> Source</button>
        </div>
      </section>

      <section className="mc-agent-grid">
        <div className="mc-agent-panel">
          <div className="mc-panel-head">
            <span><i className="ti ti-robot" /> Project agents</span>
            <button className="ghost mc-btn-xs" onClick={goFiles}>files</button>
          </div>
          {agents.length ? (
            <div className="mc-agent-list">
              {agents.map((a) => (
                <div key={a.file + a.name} className="mc-agent-row">
                  <span className="mc-agent-avatar">{a.name.slice(0, 1)}</span>
                  <span className="mc-agent-name">{a.name}</span>
                  <span className="mc-agent-file">{a.file}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="mc-needs-empty">No agents found in this project yet.</div>
          )}
        </div>

        <div className="mc-agent-panel">
          <div className="mc-panel-head">
            <span><i className="ti ti-antenna-bars-5" /> Inputs and runtime</span>
            <button className="ghost mc-btn-xs" onClick={goRun}>run</button>
          </div>
          <div className="mc-runtime-stack">
            <div><b>{state.runtime.name}</b><span>{state.runtime.kind} runtime</span></div>
            <div><b>{prompts.length}</b><span>prompt sensor{prompts.length === 1 ? "" : "s"}</span></div>
            <div><b>{info?.files?.length || 0}</b><span>Agape source file{info?.files?.length === 1 ? "" : "s"}</span></div>
          </div>
          {prompts.length > 0 && (
            <div className="mc-sensor-list">
              {prompts.map((p) => <span key={p.file + p.name}><i className="ti ti-plug" /> {p.name}</span>)}
            </div>
          )}
        </div>
      </section>

      <div className="mc-metrics mc-metrics-4">
        <Metric label="needs you" value={c.waiting} tone={c.waiting > 0 ? "warn" : ""} />
        <Metric label="in progress" value={c.active} />
        <Metric label="backlog" value={c.backlog} onClick={goWork} />
        <Metric label="done" value={c.done} />
      </div>

      <section className="mc-two-col">
        <div>
          <div className="mc-section-title"><i className="ti ti-bell mc-warn-i" /> needs you</div>
          {waiting.length ? (
            <div className="mc-list">{waiting.map((it) => <Row key={it.id} item={it} onOpen={onOpen} />)}</div>
          ) : (
            <div className="mc-needs-empty">Nothing needs your review right now.</div>
          )}
        </div>
        <div>
          <div className="mc-section-title"><i className="ti ti-activity" /> active work</div>
          {active.length ? (
            <div className="mc-list">{active.map((it) => <Row key={it.id} item={it} onOpen={onOpen} />)}</div>
          ) : (
            <div className="mc-needs-empty">
              No active item. <span className="mc-link" onClick={goWork}>Open work</span> to pair or delegate.
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
