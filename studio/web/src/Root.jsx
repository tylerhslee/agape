import { useState } from "react";
import Studio from "./missioncontrol/Studio.jsx";
import App from "./App.jsx";
import Review from "./review/Review.jsx";

// Top-level switch between studio surfaces:
//  - "review"  — the spec + conformance review studio (the landing).
//  - "studio"  — the work-centric shell (mission control + work board + detail).
//  - "console" — the VS Code-skinned event console (code editing).
export default function Root() {
  const [view, setView] = useState("review");
  if (view === "console") return <App onHome={() => setView("review")} />;
  if (view === "studio") return <Studio onOpenConsole={() => setView("console")} />;
  return <Review onStudio={() => setView("studio")} />;
}
