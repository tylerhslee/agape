import { useState, useEffect } from "react";
import { useStudio, selectedItem } from "./missioncontrol/store.js";
import MissionControl from "./missioncontrol/MissionControl.jsx";
import WorkBoard from "./missioncontrol/WorkBoard.jsx";
import ItemDetail from "./missioncontrol/ItemDetail.jsx";
import ProjectView from "./project/ProjectView.jsx";
import StudioSurface from "./StudioSurface.jsx";
import { STUDIO, RUNTIME, LANGUAGE } from "virtual:agape-versions";
import "./missioncontrol/missioncontrol.css";

// Two deliberately separate scopes:
//
//   PROJECT (the rail) — the Agape app the user is building. Their files, their
//   runs, and the work board for that project. This is "work on my thing."
//
//   STUDIO (the gear) — the studio itself: settings, conformance inspection, and
//   the studio's own agentic layer (fleet + memory). The studio is, in time, an
//   agentic app in its own right; this is where that lives. Reached via the gear
//   at the bottom of the rail (the workspace-vs-settings split).
const PROJECT_SPACES = [
  { id: "overview", label: "Overview", icon: "ti-layout-dashboard" },
  { id: "work", label: "Work", icon: "ti-checklist" },
  { id: "explorer", label: "Files", icon: "ti-folder" },
  { id: "run", label: "Run", icon: "ti-player-play" },
];

export default function Shell({ info }) {
  const [state, dispatch] = useStudio();
  const [view, setView] = useState("overview"); // a project space id, or "studio"
  const selected = selectedItem(state);
  const hasProject = !!info?.hasProject;

  // The cognition provider is a STUDIO-level setting, not a per-run project toggle:
  // it lives here, is edited in Studio -> Settings, and the project run panel only
  // consumes it.
  const [provider, setProvider] = useState(() => {
    try { return { claude: localStorage.getItem("agape.claude") === "1", samples: 5, temp: 0 }; }
    catch { return { claude: false, samples: 5, temp: 0 }; }
  });
  useEffect(() => {
    try { localStorage.setItem("agape.claude", provider.claude ? "1" : "0"); } catch {}
  }, [provider.claude]);

  // Editor preferences (e.g. Vim mode) are studio-level too — toggled in
  // Studio -> Settings or from the editor status bar, persisted across sessions.
  const [editorPrefs, setEditorPrefs] = useState(() => {
    try { return { vim: localStorage.getItem("agape.vim") === "1", wrap: localStorage.getItem("agape.wrap") === "1" }; }
    catch { return { vim: false, wrap: false }; }
  });
  useEffect(() => {
    try { localStorage.setItem("agape.vim", editorPrefs.vim ? "1" : "0"); } catch {}
  }, [editorPrefs.vim]);
  useEffect(() => {
    try { localStorage.setItem("agape.wrap", editorPrefs.wrap ? "1" : "0"); } catch {}
  }, [editorPrefs.wrap]);

  const open = (id) => dispatch({ type: "SELECT", id });
  const goProject = (id) => { dispatch({ type: "CLEAR_SELECT" }); setView(id); };

  return (
    <div className="app">
      <nav className="app-rail">
        <div className="app-brand" title="Agape Studio"><i className="ti ti-heart-handshake" /></div>
        {PROJECT_SPACES.map((s) => (
          <div
            key={s.id}
            className={"rail-item" + (view === s.id ? " active" : "")}
            onClick={() => goProject(s.id)}
            title={s.label}
          >
            <i className={"ti " + s.icon} /><span>{s.label}</span>
          </div>
        ))}
        <div className="rail-spacer" />
        <div
          className={"rail-item" + (view === "studio" ? " active" : "")}
          onClick={() => setView("studio")}
          title="Studio — settings, conformance, the studio's own agents"
        >
          <i className="ti ti-settings" /><span>Studio</span>
        </div>
        <div
          className="rail-ver"
          title={`studio v${STUDIO} · runtime v${RUNTIME} · language v${LANGUAGE}`}
          onClick={() => setView("studio")}
        >
          v{STUDIO}
        </div>
      </nav>

      <div className="app-main">
        {view === "studio" ? (
          <StudioSurface
            provider={provider} setProvider={setProvider}
            editorPrefs={editorPrefs} setEditorPrefs={setEditorPrefs}
            onExit={() => setView("overview")}
          />
        ) : view === "explorer" || view === "run" ? (
          // Editor views own the whole pane (no topbar) for maximum editing space.
          hasProject
            ? <ProjectView
                info={info} provider={provider}
                editorPrefs={editorPrefs} setEditorPrefs={setEditorPrefs}
                panel={view}
                onShowRun={() => setView("run")}
                onOpenSettings={() => setView("studio")}
              />
            : <NoProject />
        ) : (
          <>
            <header className="app-topbar">
              <i className="ti ti-folder" style={{ color: "var(--type)", fontSize: 18 }} />
              <span className="app-title">{info?.name || "project"}</span>
              {info?.root && <span className="app-sub">{info.root}</span>}
            </header>
            <div className="app-stage">
              <div className="app-scroll">
                {selected ? (
                  <ItemDetail item={selected} dispatch={dispatch} onClose={() => dispatch({ type: "CLEAR_SELECT" })} />
                ) : view === "work" ? (
                  <WorkBoard state={state} dispatch={dispatch} onOpen={open} />
                ) : (
                  <MissionControl state={state} dispatch={dispatch} onOpen={open} goWork={() => setView("work")} />
                )}
              </div>
            </div>
          </>
        )}
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
