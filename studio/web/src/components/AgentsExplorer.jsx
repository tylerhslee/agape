// The side bar in "Agents" view — the event-cockpit's answer to the file
// Explorer. Instead of files, it lists the live agent population (each a
// projection of the ledger), the declared templates, and the authority-bearing
// event types (Guarantee 1). Hovering an agent reveals lifecycle actions.

export default function AgentsExplorer({ state, onAct }) {
  const { agents = [], templates = [], authority_events = [] } = state;
  return (
    <div className="sidebar">
      <div className="head">
        <span>AGENTS</span>
        <span style={{ color: "#6a6a6a" }}>{agents.length}</span>
      </div>
      <div className="scroll">
        {agents.length === 0 && <div className="empty">no live agents</div>}
        {agents.map((a) => (
          <div className="tree-item" key={a.name}>
            <span className={"dot" + (a.awake ? " awake" : "")} />
            <span>{a.name}</span>
            <span className="type">: {a.type}</span>
            <span className="acts">
              {a.awake ? (
                <i className="ti ti-player-pause" title="sleep" onClick={() => onAct("sleep", a.name)} />
              ) : (
                <i className="ti ti-player-play" title="awake" onClick={() => onAct("awake", a.name)} />
              )}
              <i className="ti ti-message-question" title="ask its name" onClick={() => onAct("ask", a.name)} />
            </span>
          </div>
        ))}

        <div className="section-sub">TEMPLATES</div>
        <div style={{ padding: "0 10px 8px" }}>
          {templates.map((t) => (
            <span className="pill" key={t}>{t}</span>
          ))}
        </div>

        {authority_events.length > 0 && (
          <>
            <div className="section-sub">AUTHORITY</div>
            <div style={{ padding: "0 10px 8px" }}>
              {authority_events.map((t) => (
                <span className="pill auth" key={t}>
                  <i className="ti ti-shield-lock" style={{ fontSize: 12, verticalAlign: -1 }} /> {t}
                </span>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
