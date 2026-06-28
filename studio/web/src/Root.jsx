import { useState, useEffect } from "react";
import Shell from "./Shell.jsx";
import * as project from "./project/projectApi.js";

// Loads whatever project the studio was launched on (if any), then mounts the
// single app shell. There is no longer a top-level "which screen" router — the
// shell's activity rail owns navigation between spaces.
export default function Root() {
  const [info, setInfo] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    project.info()
      .then((d) => { setInfo(d); setReady(true); })
      .catch(() => setReady(true)); // no project / backend — shell still opens
  }, []);

  if (!ready) return <div className="app-loading">opening studio…</div>;
  return <Shell info={info} />;
}
