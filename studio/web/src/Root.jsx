import { useState } from "react";
import Studio from "./missioncontrol/Studio.jsx";
import App from "./App.jsx";

// Top-level switch between the two studio surfaces:
//  - "studio"  — the work-centric shell (mission control + work board + detail).
//  - "console" — the existing VS Code-skinned event console (code editing).
// Both stay reachable; neither knows about the other beyond a callback.
export default function Root() {
  const [view, setView] = useState("studio");
  return view === "console" ? (
    <App onHome={() => setView("studio")} />
  ) : (
    <Studio onOpenConsole={() => setView("console")} />
  );
}
