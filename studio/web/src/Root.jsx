import { useState, useEffect } from "react";
import Studio from "./missioncontrol/Studio.jsx";
import App from "./App.jsx";
import Review from "./review/Review.jsx";
import ProjectView from "./project/ProjectView.jsx";
import * as project from "./project/projectApi.js";

// Top-level switch between studio surfaces:
//  - "project" — the user's own Agape project (opened via `agape studio`): the landing
//    when AGAPE_PROJECT is set on the agent-server.
//  - "review"  — the spec + conformance review studio.
//  - "studio"  — the work-centric shell (mission control + work board + detail).
//  - "console" — the VS Code-skinned event console (code editing).
export default function Root() {
  const [view, setView] = useState(null); // null until we know whether a project is open
  const [info, setInfo] = useState(null);

  useEffect(() => {
    project.info()
      .then((d) => { setInfo(d); setView(d.hasProject ? "project" : "review"); })
      .catch(() => setView("review"));
  }, []);

  if (view === null) return <div style={{ position: "fixed", inset: 0, background: "#0f1115", color: "#9aa4b2", display: "flex", alignItems: "center", justifyContent: "center", font: "14px sans-serif" }}>opening studio…</div>;
  if (view === "console") return <App onHome={() => setView("review")} />;
  if (view === "studio") return <Studio onOpenConsole={() => setView("console")} />;
  if (view === "project" && info?.hasProject) return <ProjectView info={info} onReview={() => setView("review")} />;
  return <Review onStudio={() => setView("studio")} onProject={info?.hasProject ? () => setView("project") : undefined} />;
}
