import { useState, useEffect, useRef, useCallback } from "react";
import { api } from "./api.js";
import ActivityBar from "./components/ActivityBar.jsx";
import AgentsExplorer from "./components/AgentsExplorer.jsx";
import EditorArea from "./components/EditorArea.jsx";
import SpinePanel from "./components/SpinePanel.jsx";
import QueryConsole from "./components/QueryConsole.jsx";
import StatusBar from "./components/StatusBar.jsx";

const EMPTY = { agents: [], templates: [], authority_events: [], provider: "?" };

export default function App() {
  const [snap, setSnap] = useState(EMPTY);
  const [events, setEvents] = useState([]);
  const [live, setLive] = useState(true);
  const [editorSrc, setEditorSrc] = useState("");
  const [editorMsg, setEditorMsg] = useState(null);
  const [activity, setActivity] = useState("agents");
  const [panelTab, setPanelTab] = useState("spine");
  const [queryLog, setQueryLog] = useState([]);
  const [connected, setConnected] = useState(true);
  const lastTick = useRef(-1);

  // Refresh the full projection from the spine. `syncEditor` seeds the editor with
  // the loaded program source — only on first load / explicit reload, never after,
  // so we don't clobber edits in progress.
  const refresh = useCallback(async (syncEditor = false) => {
    try {
      const s = await api.state();
      setSnap(s);
      setEvents(s.events);
      lastTick.current = s.events.length ? s.events[s.events.length - 1].tick : -1;
      if (syncEditor) setEditorSrc(s.source || "");
      setConnected(true);
    } catch {
      setConnected(false);
    }
  }, []);

  useEffect(() => { refresh(true); }, [refresh]);

  // Live tail: poll for events appended since the last tick we hold.
  useEffect(() => {
    if (!live) return;
    const id = setInterval(async () => {
      try {
        const { events: fresh } = await api.spineSince(lastTick.current + 1);
        setConnected(true);
        if (fresh.length) {
          setEvents((prev) => [...prev, ...fresh]);
          lastTick.current = fresh[fresh.length - 1].tick;
          setSnap(await api.state()); // lifecycle (awake/sleep/spawn) may have changed
        }
      } catch {
        setConnected(false);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [live]);

  const onRun = async () => {
    try {
      await api.load(editorSrc);
      setEditorMsg({ ok: true, text: "loaded — spine reset" });
      await refresh(false);
    } catch (e) {
      setEditorMsg({ ok: false, text: `${e.kind || "error"}: ${e.message}` });
    }
  };

  const onAgentAct = async (kind, name) => {
    try {
      if (kind === "awake") await api.awake(name);
      else if (kind === "sleep") await api.sleep(name);
      else if (kind === "ask") await api.send(name, "What is your name?");
      await refresh(false);
    } catch (e) {
      pushQuery({ kind: "err", text: e.message });
    }
  };

  const pushQuery = (line) => setQueryLog((prev) => [...prev, line]);

  const onQuery = async (src) => {
    pushQuery({ kind: "cmd", text: src });
    try {
      const r = await api.eval(src);
      const fresh = r.new_events || [];
      pushQuery({ kind: "res", text: `→ ${fresh.length} new event${fresh.length === 1 ? "" : "s"}` });
      for (const e of fresh) {
        const pay = e.payload == null ? "" : (typeof e.payload === "object" ? JSON.stringify(e.payload) : ` ${e.payload}`);
        pushQuery({ kind: "res", text: `    ${e.tick}  ${e.etype}${e.subject != null ? " " + e.subject : ""}${pay}` });
      }
      await refresh(false);
    } catch (e) {
      pushQuery({ kind: "err", text: `${e.kind || "error"}: ${e.message}` });
    }
  };

  const onActivity = (id) => {
    setActivity(id);
    if (id === "spine") setPanelTab("spine");
    if (id === "query") setPanelTab("query");
  };

  return (
    <div className="shell">
      <div className="titlebar">
        <span className="dots">
          <i style={{ background: "#ff5f56" }} />
          <i style={{ background: "#ffbd2e" }} />
          <i style={{ background: "#27c93f" }} />
        </span>
        <span style={{ marginLeft: 8, color: "#9d9d9d" }}>
          Agape Studio — {(snap.program_path || "untitled").split("/").pop()}
          {!connected && <span style={{ color: "#f48771" }}> · backend offline</span>}
        </span>
      </div>

      <div className="body">
        <ActivityBar active={activity} onSelect={onActivity} />
        <AgentsExplorer state={snap} onAct={onAgentAct} />

        <div className="center">
          <EditorArea
            source={editorSrc}
            onChange={setEditorSrc}
            onRun={onRun}
            programPath={snap.program_path}
            msg={editorMsg}
          />

          <div className="panel">
            <div className="panel-tabs">
              <span className={"panel-tab" + (panelTab === "spine" ? " active" : "")} onClick={() => setPanelTab("spine")}>
                Spine
              </span>
              <span className={"panel-tab" + (panelTab === "query" ? " active" : "")} onClick={() => setPanelTab("query")}>
                Query
              </span>
              <div className="right">
                <span style={{ color: live ? "#4ec9b0" : "#858585" }}>
                  {live ? "● live" : "paused"} · {events.length} events
                </span>
              </div>
            </div>
            {panelTab === "spine" ? <SpinePanel events={events} /> : <QueryConsole log={queryLog} onRun={onQuery} />}
          </div>
        </div>
      </div>

      <StatusBar state={snap} eventCount={events.length} live={live} onToggleLive={() => setLive((l) => !l)} />
    </div>
  );
}
