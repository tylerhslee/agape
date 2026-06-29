import { useState, useEffect } from "react";
import { useStudio, selectedItem } from "./missioncontrol/store.js";
import MissionControl from "./missioncontrol/MissionControl.jsx";
import WorkBoard from "./missioncontrol/WorkBoard.jsx";
import ItemDetail from "./missioncontrol/ItemDetail.jsx";
import { itemsByStatus } from "./missioncontrol/store.js";
import ProjectView from "./project/ProjectView.jsx";
import StudioSurface, { StudioBuilder } from "./StudioSurface.jsx";
import * as project from "./project/projectApi.js";
import { STUDIO } from "virtual:agape-versions";
import "./missioncontrol/missioncontrol.css";

const PROVIDER_DEFAULTS = {
  cognitionProvider: "mock",
  judgeProvider: "anthropic",
  samples: 5,
  temp: 0,
  openaiTopLogprobs: 5,
  keys: { anthropic: false, openai: false, gemini: false },
};
const RUNTIME_DEFAULTS = {
  mode: "local",
  endpoint: "",
  label: "Local runtime",
  version: "unknown",
  connected: true,
};

function judgeProviderForCognition(cognitionProvider) {
  return cognitionProvider === "openai" ? "openai" : "anthropic";
}

function storageGet(key) {
  try { return localStorage.getItem(key); }
  catch { return null; }
}

function storageSet(key, value) {
  try { localStorage.setItem(key, value); }
  catch {}
}

function storedNumber(key, fallback) {
  const n = Number(storageGet(key));
  return Number.isFinite(n) && storageGet(key) !== null ? n : fallback;
}

function hasStoredProviderConfig() {
  return [
    "agape.cognitionProvider",
    "agape.judgeProvider",
    "agape.samples",
    "agape.temp",
    "agape.openaiTopLogprobs",
  ].some((key) => storageGet(key) !== null);
}

function readStoredProvider() {
  const cognitionProvider = storageGet("agape.cognitionProvider") || PROVIDER_DEFAULTS.cognitionProvider;
  return {
    ...PROVIDER_DEFAULTS,
    cognitionProvider,
    judgeProvider: judgeProviderForCognition(cognitionProvider),
    samples: storedNumber("agape.samples", PROVIDER_DEFAULTS.samples),
    temp: storedNumber("agape.temp", PROVIDER_DEFAULTS.temp),
    openaiTopLogprobs: storedNumber("agape.openaiTopLogprobs", PROVIDER_DEFAULTS.openaiTopLogprobs),
  };
}

function providerApiConfig(provider) {
  const cognitionProvider = provider.cognitionProvider || "mock";
  return {
    cognitionProvider,
    judgeProvider: judgeProviderForCognition(cognitionProvider),
    samples: provider.samples,
    temperature: provider.temp,
    openaiTopLogprobs: provider.openaiTopLogprobs,
  };
}

export default function Shell({ info, infoError }) {
  const [state, dispatch] = useStudio();
  const [view, setView] = useState(() => storageGet("agape.view") || "overview");
  const selected = selectedItem(state);
  const hasProject = !!info?.hasProject;

  // The cognition provider is a STUDIO-level setting, not a per-run project toggle:
  // it lives here, is edited in Studio -> Settings, and the project run panel only
  // consumes it.
  const [provider, setProvider] = useState(() => {
    try { return readStoredProvider(); }
    catch { return PROVIDER_DEFAULTS; }
  });
  const [runtime, setRuntime] = useState(() => ({ ...RUNTIME_DEFAULTS, ...(info?.runtime || {}) }));
  useEffect(() => {
    storageSet("agape.cognitionProvider", provider.cognitionProvider || "mock");
    storageSet("agape.judgeProvider", judgeProviderForCognition(provider.cognitionProvider || "mock"));
    storageSet("agape.samples", String(provider.samples ?? 5));
    storageSet("agape.temp", String(provider.temp ?? 0));
    storageSet("agape.openaiTopLogprobs", String(provider.openaiTopLogprobs ?? 5));
  }, [provider.cognitionProvider, provider.judgeProvider, provider.samples, provider.temp, provider.openaiTopLogprobs]);
  useEffect(() => {
    const hasStored = hasStoredProviderConfig();
    project.agentConfig()
      .then((cfg) => {
        if (hasStored) {
          const stored = readStoredProvider();
          setProvider((p) => ({
            ...p,
            ...stored,
            keys: cfg.keys || p.keys,
            cognitionModel: cfg.cognitionModel,
            judgeModel: cfg.judgeModel,
          }));
          project.saveAgentConfig(providerApiConfig(stored))
            .then((saved) => setProvider((p) => ({
              ...p,
              keys: saved.keys || p.keys,
              cognitionModel: saved.cognitionModel || p.cognitionModel,
              judgeModel: saved.judgeModel || p.judgeModel,
            })))
            .catch(() => {});
          return;
        }
        setProvider((p) => ({
          ...p,
          cognitionProvider: cfg.cognitionProvider || p.cognitionProvider,
          judgeProvider: judgeProviderForCognition(cfg.cognitionProvider || p.cognitionProvider),
          samples: cfg.samples ?? p.samples,
          temp: cfg.temperature ?? p.temp,
          openaiTopLogprobs: cfg.openaiTopLogprobs ?? p.openaiTopLogprobs,
          keys: cfg.keys || p.keys,
          cognitionModel: cfg.cognitionModel,
          judgeModel: cfg.judgeModel,
        }));
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    storageSet("agape.view", view);
  }, [view]);
  useEffect(() => {
    project.runtimeConfig()
      .then((cfg) => setRuntime((p) => ({ ...p, ...cfg })))
      .catch(() => {});
  }, []);

  // Editor preferences (e.g. Vim mode) are studio-level too — toggled in
  // Studio -> Settings or from the editor status bar, persisted across sessions.
  const [editorPrefs, setEditorPrefs] = useState(() => {
    try { return { vim: storageGet("agape.vim") === "1", wrap: storageGet("agape.wrap") === "1" }; }
    catch { return { vim: false, wrap: false }; }
  });
  useEffect(() => {
    storageSet("agape.vim", editorPrefs.vim ? "1" : "0");
  }, [editorPrefs.vim]);
  useEffect(() => {
    storageSet("agape.wrap", editorPrefs.wrap ? "1" : "0");
  }, [editorPrefs.wrap]);

  const open = (id) => dispatch({ type: "SELECT", id });
  const goProject = (id) => { dispatch({ type: "CLEAR_SELECT" }); setView(id); };

  return (
    <div className="app">
      <div className="app-main">
        {view === "studio" ? (
          <StudioSurface
            provider={provider} setProvider={setProvider}
            runtime={runtime} setRuntime={setRuntime}
            info={info}
            studioVersion={STUDIO}
            editorPrefs={editorPrefs} setEditorPrefs={setEditorPrefs}
            onExit={() => setView("overview")}
          />
        ) : view === "builder" ? (
          hasProject ? (
            <>
              <ContextBar
                title="Builder"
                info={info}
                active="builder"
                onHome={() => goProject("overview")}
                onWork={() => goProject("work")}
                onBuilder={() => goProject("builder")}
                onCode={() => goProject("explorer")}
                onRun={() => goProject("run")}
                onStudio={() => setView("studio")}
              />
              <div className="app-stage">
                <div className="app-scroll">
                  <StudioBuilder />
                </div>
              </div>
            </>
          ) : <NoProject infoError={infoError} />
        ) : view === "explorer" || view === "run" ? (
          hasProject ? (
            <>
              <ContextBar
                title={view === "run" ? "Run and inspect" : "Code surface"}
                info={info}
                active={view}
                onHome={() => goProject("overview")}
                onWork={() => goProject("work")}
                onBuilder={() => goProject("builder")}
                onCode={() => goProject("explorer")}
                onRun={() => goProject("run")}
                onStudio={() => setView("studio")}
              />
              <div className="app-stage">
                <ProjectView
                  info={info} provider={provider}
                  editorPrefs={editorPrefs} setEditorPrefs={setEditorPrefs}
                  panel={view}
                  onShowRun={() => goProject("run")}
                  onOpenSettings={() => setView("studio")}
                />
              </div>
            </>
          ) : <NoProject infoError={infoError} />
        ) : view === "work" ? (
          <>
            <ContextBar
              title="Work command"
              info={info}
              active="work"
              onHome={() => goProject("overview")}
              onWork={() => goProject("work")}
              onBuilder={() => goProject("builder")}
              onCode={() => goProject("explorer")}
              onRun={() => goProject("run")}
              onStudio={() => setView("studio")}
            />
            <div className="app-stage">
              <div className="app-scroll">
                {selected ? (
                  <ItemDetail item={selected} dispatch={dispatch} onClose={() => dispatch({ type: "CLEAR_SELECT" })} />
                ) : (
                  <WorkBoard state={state} dispatch={dispatch} onOpen={open} />
                )}
              </div>
            </div>
          </>
        ) : (
          <div className="app-stage">
            <div className="app-scroll">
              {selected ? (
                <ItemDetail item={selected} dispatch={dispatch} onClose={() => dispatch({ type: "CLEAR_SELECT" })} />
              ) : (
                <MissionControl
                  state={state}
                  info={info}
                  dispatch={dispatch}
                  onOpen={open}
                  goWork={() => goProject("work")}
                  goBuilder={() => goProject("builder")}
                  goRun={() => goProject("run")}
                  goFiles={() => goProject("explorer")}
                  goStudio={() => setView("studio")}
                />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ContextBar({ title, info, active, onHome, onWork, onBuilder, onCode, onRun, onStudio }) {
  return (
    <header className="context-bar">
      <button className="context-home" onClick={onHome}>
        <span className="agape-mark small" aria-hidden="true"><span /></span> Command
      </button>
      <div className="context-title">
        <b>{title}</b>
        {info?.root && <span>{info.name || info.root}</span>}
      </div>
      <div className="context-actions">
        <button className={active === "work" ? "active" : ""} onClick={onWork}><i className="ti ti-checklist" /> Work</button>
        <button className={active === "builder" ? "active" : ""} onClick={onBuilder}><i className="ti ti-sparkles" /> Builder</button>
        <button className={active === "explorer" ? "active" : ""} onClick={onCode}><i className="ti ti-code" /> Code</button>
        <button className={active === "run" ? "active" : ""} onClick={onRun}><i className="ti ti-player-play" /> Run</button>
        <button onClick={onStudio}><i className="ti ti-settings" /> Studio</button>
      </div>
    </header>
  );
}

const SUBVIEWS = {
  overview: [
    ["overview", "Overview", "ti-layout-dashboard"],
    ["builder", "Builder", "ti-sparkles"],
    ["memory", "Memory", "ti-database"],
    ["events", "Event log", "ti-list-details"],
  ],
  work: [
    ["board", "Board", "ti-columns-3"],
    ["queue", "Queue", "ti-list-check"],
    ["activity", "Activity", "ti-activity"],
  ],
  explorer: [
    ["source", "Source", "ti-code"],
    ["agents", "Agents", "ti-robot"],
    ["outline", "Outline", "ti-binary-tree"],
  ],
  run: [
    ["console", "Console", "ti-terminal-2"],
    ["events", "Event log", "ti-list-details"],
    ["calls", "Model calls", "ti-cloud-computing"],
    ["settings", "Settings", "ti-adjustments"],
  ],
};

function WorkspaceHeader({ view, info, subview, setSubview }) {
  const tabs = SUBVIEWS[view] || [];
  const title = view === "overview" ? "Agents" : view === "explorer" ? "Files" : view === "run" ? "Run" : "Work";
  return (
    <header className="app-topbar workspace-topbar">
      <div className="workspace-title">
        <i className={"ti " + (view === "overview" ? "ti-robot" : view === "work" ? "ti-checklist" : view === "run" ? "ti-player-play" : "ti-folder")} />
        <span className="app-title">{title}</span>
        {info?.root && <span className="app-sub">{info.name || info.root}</span>}
      </div>
      <nav className="workspace-lenses" aria-label={`${title} lenses`}>
        {tabs.map(([id, label, icon]) => (
          <button key={id} className={subview === id ? "active" : ""} onClick={() => setSubview(id)}>
            <i className={"ti " + icon} /> {label}
          </button>
        ))}
      </nav>
    </header>
  );
}

function WorkspaceEvents({ state, info }) {
  const rows = [
    { kind: "runtime", title: `${state.runtime.name} selected`, detail: `${state.runtime.kind} runtime` },
    ...state.items.map((it) => ({
      kind: it.status,
      title: it.title,
      detail: `${it.status}${it.assignee ? " · " + it.assignee : ""}${it.destination ? " · " + it.destination : ""}`,
    })),
    ...(info?.files || []).flatMap((f) => [
      ...f.agents.map((a) => ({ kind: "agent", title: a, detail: f.rel })),
      ...f.prompts.map((p) => ({ kind: "prompt", title: p, detail: f.rel })),
    ]),
  ];
  return (
    <div className="workspace-page">
      <div className="workspace-page-head">
        <h2>Event log</h2>
        <span>Project, work, and agent activity in one timeline.</span>
      </div>
      <div className="workspace-log">
        {rows.map((r, i) => (
          <div key={i} className="workspace-log-row">
            <span className="workspace-log-tick">#{String(i + 1).padStart(3, "0")}</span>
            <span className={"workspace-log-kind " + r.kind}>{r.kind}</span>
            <span className="workspace-log-title">{r.title}</span>
            <span className="workspace-log-detail">{r.detail}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function WorkQueue({ state, onOpen }) {
  const items = ["waiting", "active", "backlog", "parked", "done"].flatMap((s) => itemsByStatus(state, s));
  return (
    <div className="workspace-page">
      <div className="workspace-page-head">
        <h2>Queue</h2>
        <span>Every work item in priority-facing order.</span>
      </div>
      <div className="workspace-table">
        {items.map((it) => (
          <button key={it.id} className="workspace-table-row" onClick={() => onOpen(it.id)}>
            <span>{it.title}</span>
            <em>{it.status}</em>
            <small>{it.assignee || "unassigned"}</small>
          </button>
        ))}
      </div>
    </div>
  );
}

function ProjectAgents({ info }) {
  const agents = (info?.files || []).flatMap((f) => f.agents.map((name) => ({ name, file: f.rel })));
  return (
    <div className="workspace-page">
      <div className="workspace-page-head">
        <h2>Source agents</h2>
        <span>Agents declared across the current project.</span>
      </div>
      <div className="workspace-cards">
        {agents.map((a) => (
          <div key={a.file + a.name} className="workspace-card">
            <i className="ti ti-robot" />
            <strong>{a.name}</strong>
            <span>{a.file}</span>
          </div>
        ))}
        {!agents.length && <div className="empty-state compact">No agents found yet.</div>}
      </div>
    </div>
  );
}

function ProjectOutline({ info }) {
  return (
    <div className="workspace-page">
      <div className="workspace-page-head">
        <h2>Outline</h2>
        <span>Files, agents, and prompt inputs at a glance.</span>
      </div>
      <div className="workspace-log">
        {(info?.files || []).map((f, i) => (
          <div key={f.rel} className="workspace-log-row">
            <span className="workspace-log-tick">#{String(i + 1).padStart(3, "0")}</span>
            <span className="workspace-log-kind source">source</span>
            <span className="workspace-log-title">{f.rel}</span>
            <span className="workspace-log-detail">{f.agents.length} agents · {f.prompts.length} prompts</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function RunWorkspace({ subview, info, provider, onOpenSettings }) {
  if (subview === "settings") {
    return (
      <div className="workspace-page">
        <div className="workspace-page-head">
          <h2>Run settings</h2>
          <span>Provider and sampling settings live in Studio settings.</span>
        </div>
        <button className="accent" onClick={onOpenSettings}><i className="ti ti-settings" /> Open settings</button>
        <div className="workspace-note">{provider.cognitionProvider === "mock" ? "Mock provider enabled." : `${provider.cognitionProvider} provider enabled.`}</div>
      </div>
    );
  }
  return (
    <div className="workspace-page">
      <div className="workspace-page-head">
        <h2>{subview === "calls" ? "Model calls" : "Event log"}</h2>
        <span>Run a file from Console to populate this stream with live run data.</span>
      </div>
      <div className="workspace-log">
        {(info?.files || []).map((f, i) => (
          <div key={f.rel} className="workspace-log-row">
            <span className="workspace-log-tick">#{String(i + 1).padStart(3, "0")}</span>
            <span className="workspace-log-kind source">ready</span>
            <span className="workspace-log-title">{f.rel}</span>
            <span className="workspace-log-detail">open Console to execute this source</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function NoProject({ infoError }) {
  const offline = !!infoError;
  return (
    <div className="app-empty">
      <i className={"ti " + (offline ? "ti-plug-off" : "ti-folder-off")} />
      <div><b>{offline ? "Studio backend unavailable." : "No project open."}</b></div>
      <div>
        {offline
          ? "The web app opened, but the project backend did not answer /project/info. Restart the studio from the project directory."
          : <>Launch the studio on an Agape project with <code>agape studio</code> to edit and run its agents here.</>}
      </div>
    </div>
  );
}
