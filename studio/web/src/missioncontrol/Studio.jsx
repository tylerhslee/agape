import { useState } from "react";
import { useStudio, selectedItem } from "./store.js";
import MissionControl from "./MissionControl.jsx";
import WorkBoard from "./WorkBoard.jsx";
import ItemDetail from "./ItemDetail.jsx";
import "./missioncontrol.css";

// The studio shell: a section nav (the IA from STUDIO.md §3) on the left, a runtime
// top bar, and the active section in the stage. Selecting a work item opens the
// detail spoke over the stage. Sections beyond mission/work are shown but inert
// until built — they convey the roadmap without faking behavior.
const NAV = [
  {
    group: "operate",
    items: [
      { id: "mission", label: "mission control", icon: "ti-layout-dashboard" },
      { id: "work", label: "work", icon: "ti-checklist" },
    ],
  },
  {
    group: "build",
    items: [{ id: "code", label: "code · console", icon: "ti-code", external: true }],
  },
  {
    group: "soon",
    items: [
      { id: "events", label: "event log", icon: "ti-timeline", disabled: true },
      { id: "agents", label: "agents", icon: "ti-robot", disabled: true },
      { id: "settings", label: "settings", icon: "ti-settings", disabled: true },
    ],
  },
];

export default function Studio({ onOpenConsole }) {
  const [state, dispatch] = useStudio();
  const [section, setSection] = useState("mission");
  const selected = selectedItem(state);

  const onNav = (item) => {
    if (item.disabled) return;
    if (item.external) return onOpenConsole?.();
    dispatch({ type: "CLEAR_SELECT" });
    setSection(item.id);
  };

  const open = (id) => dispatch({ type: "SELECT", id });

  return (
    <div className="mc-shell">
      <nav className="mc-nav">
        <div className="mc-nav-brand">
          <i className="ti ti-heart-handshake" />
          <span>Agape Studio</span>
        </div>
        {NAV.map((g) => (
          <div key={g.group}>
            <div className="mc-nav-group">{g.group}</div>
            {g.items.map((it) => (
              <div
                key={it.id}
                className={
                  "mc-nav-item" +
                  (section === it.id ? " active" : "") +
                  (it.disabled ? " disabled" : "")
                }
                onClick={() => onNav(it)}
              >
                <i className={"ti " + it.icon} />
                <span>{it.label}</span>
                {it.disabled && <span className="mc-nav-soon">soon</span>}
              </div>
            ))}
          </div>
        ))}
      </nav>

      <div className="mc-stage">
        <header className="mc-topbar">
          <i className="ti ti-stack-2 mc-rt-icon" />
          <select className="mc-runtime" value={state.runtime.id} readOnly>
            <option value={state.runtime.id}>{state.runtime.name} · app runtime</option>
          </select>
          <span className="mc-topbar-goal">{state.goal}</span>
          <button className="ghost mc-btn-sm mc-right" onClick={onOpenConsole}>
            <i className="ti ti-code" /> console
          </button>
        </header>

        <div className="mc-stage-body">
          {selected ? (
            <ItemDetail item={selected} dispatch={dispatch} onClose={() => dispatch({ type: "CLEAR_SELECT" })} />
          ) : section === "work" ? (
            <WorkBoard state={state} dispatch={dispatch} onOpen={open} />
          ) : (
            <MissionControl state={state} dispatch={dispatch} onOpen={open} goWork={() => setSection("work")} />
          )}
        </div>
      </div>
    </div>
  );
}
