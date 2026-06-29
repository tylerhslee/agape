import { useState, useEffect } from "react";
import Shell from "./Shell.jsx";
import * as project from "./project/projectApi.js";

// Loads whatever project the studio was launched on (if any), then mounts the
// single app shell. There is no longer a top-level "which screen" router — the
// shell's activity rail owns navigation between spaces.
export default function Root() {
  const [info, setInfo] = useState(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    let timer = null;
    let attempts = 0;
    const load = () => {
      project.info()
        .then((d) => {
          if (cancelled) return;
          setInfo(d);
          setError(null);
          setReady(true);
        })
        .catch((e) => {
          if (cancelled) return;
          attempts += 1;
          setError(e);
          if (attempts < 30) {
            timer = setTimeout(load, 500);
          } else {
            setReady(true);
          }
        });
    };
    load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  if (!ready) return <div className="app-loading">opening studio…{error ? " waiting for backend" : ""}</div>;
  return <Shell info={info} infoError={error} />;
}
