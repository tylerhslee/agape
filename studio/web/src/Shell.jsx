import { useState } from "react";
import { useStudio, selectedItem } from "./missioncontrol/store.js";
import MissionControl from "./missioncontrol/MissionControl.jsx";
import WorkBoard from "./missioncontrol/WorkBoard.jsx";
import ItemDetail from "./missioncontrol/ItemDetail.jsx";
import Learning from "./missioncontrol/Learning.jsx";
import ProjectView from "./project/ProjectView.jsx";
import Review from "./review/Review.jsx";
import "./missioncontrol/missioncontrol.css";

// The single app shell. A persistent left activity rail switches between the
// top-level spaces; the active space renders in the stage. Management is the
// home — this is a surface for *managing* agentic work, not a code editor with
// extras bolted on. Editing code is one space among several, not the front door.
const SPACES = [
  { id: "overview", label: "Overview", icon: "ti-layout-dashboard" },
  { id: "work", label: "Work", icon: "ti-checklist" },
  { id: "agents", label: "Agents", icon: "ti-robot" },
  { id: "code", label: "Code", icon: "ti-code" },
  { id: "tests", label: "Tests", icon: "ti-list-check" },
];

export default function Shell({ info }) {
  const [state, dispatch] = useStudio();
  const [space, setSpace] = useState("overview");
  const selected = selectedItem(state);
  const hasProject = !!info?.hasProject;

  const open = (id) => dispatch({ type: "SELECT", id });
  const go = (id) => { dispatch({ type: "CLEAR_SELECT" }); setSpace(id); };

  const manage = space === "overview" || space === "work" || space === "agents";

  return (
    <div className="app">
      <nav className="app-rail">
        <div className="app-brand" title="Agape Studio"><i className="ti ti-heart-handshake" /></div>
        {SPACES.map((s) => (
          <div
            key={s.id}
            className={"rail-item" + (space === s.id ? " active" : "")}
            onClick={() => go(s.id)}
            title={s.label}
          >
            <i className={"ti " + s.icon} />
            <span>{s.label}</span>
          </div>
        ))}
        <div className="rail-spacer" />
        <div className="rail-item" title="Agape Studio"><i className="ti ti-info-circle" /><span>About</span></div>
      </nav>

      <div className="app-main">
        {manage && (
          <header className="app-topbar">
            <i className="ti ti-stack-2" style={{ color: "var(--type)", fontSize: 18 }} />
            <span className="app-title">{state.runtime.name}</span>
            <span className="app-sub">{state.goal}</span>
          </header>
        )}

        <div className="app-stage">
          {space === "code" ? (
            hasProject ? <ProjectView info={info} /> : <NoProject />
          ) : space === "tests" ? (
            <Review />
          ) : (
            <div className="app-scroll">
              {selected ? (
                <ItemDetail item={selected} dispatch={dispatch} onClose={() => dispatch({ type: "CLEAR_SELECT" })} />
              ) : space === "work" ? (
                <WorkBoard state={state} dispatch={dispatch} onOpen={open} />
              ) : space === "agents" ? (
                <Learning />
              ) : (
                <MissionControl state={state} dispatch={dispatch} onOpen={open} goWork={() => setSpace("work")} />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function NoProject() {
  return (
    <div className="app-empty">
      <i className="ti ti-folder-off" />
      <div><b>No project open.</b></div>
      <div>Launch the studio on an Agape project with <code>agape studio</code> to edit and run its agents here.</div>
    </div>
  );
}
