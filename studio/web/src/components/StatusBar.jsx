// The signature blue status bar. Shows the live connection to the Agape backend,
// the cognition provider behind the seam, and the ledger/agent counts.
export default function StatusBar({ state, eventCount, live, onToggleLive }) {
  return (
    <div className="statusbar">
      <span><i className="ti ti-diamond" /> Agape</span>
      <span title="cognition provider behind the seam">
        <i className="ti ti-cpu" /> {state.provider}
      </span>
      <span
        onClick={onToggleLive}
        style={{ cursor: "pointer" }}
        title="toggle live tailing"
      >
        <i className={"ti " + (live ? "ti-circle-filled" : "ti-circle")} /> {live ? "live" : "paused"}
      </span>
      <div className="right">
        <span>{eventCount} events</span>
        <span>{(state.agents || []).length} agents</span>
        {state.program_path && <span>{state.program_path.split("/").pop()}</span>}
      </div>
    </div>
  );
}
