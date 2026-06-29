import { useState } from "react";
import { itemsByStatus, counts, createWorkId } from "./store.js";
import { agentRespond } from "./agentApi.js";

function Metric({ label, value, tone, onClick }) {
  return (
    <div className={"mc-metric" + (onClick ? " clickable" : "") + (tone ? " " + tone : "")} onClick={onClick}>
      <div className="mc-metric-label">{label}</div>
      <div className="mc-metric-value">{value}</div>
    </div>
  );
}

const INTENTS = [
  ["plan", "Plan", "ti-map", "define or sequence product work"],
  ["build", "Build", "ti-hammer", "draft or change Agape code"],
  ["inspect", "Inspect", "ti-search", "review specific code or behavior"],
  ["run", "Run", "ti-player-play", "execute and explain the ledger"],
  ["review", "Review", "ti-shield-check", "check gates, authority, and risk"],
];

export default function MissionControl({ state, info, dispatch, onOpen, goWork, goBuilder, goRun, goFiles, goStudio }) {
  const [intent, setIntent] = useState("build");
  const [target, setTarget] = useState("next");
  const [line, setLine] = useState("");
  const [prompt, setPrompt] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);
  const [selectedSignalId, setSelectedSignalId] = useState(null);
  const c = counts(state);
  const waiting = itemsByStatus(state, "waiting");
  const active = itemsByStatus(state, "active");
  const backlog = itemsByStatus(state, "backlog");
  const agents = (info?.files || []).flatMap((f) => f.agents.map((name) => ({ name, file: f.rel })));
  const prompts = (info?.files || []).flatMap((f) => f.prompts.map((name) => ({ name, file: f.rel })));
  const files = info?.files || [];
  const projectName = info?.name || state.runtime.name || "Agape project";
  const projectRoot = info?.root || "current directory";
  const agentStates = agents.map((a) => {
    const assigned = [...active, ...waiting].filter((it) => (it.assignee || "").toLowerCase() === a.name.toLowerCase());
    return {
      ...a,
      state: assigned.length ? "engaged" : "declared",
      focus: assigned[0]?.title || "awaiting run",
      risk: assigned.length ? "needs inspection" : "source only",
    };
  });
  const ledgerPreview = [
    { kind: "Project", subject: projectName, detail: `${files.length} source files loaded` },
    ...prompts.slice(0, 3).map((p) => ({ kind: "Prompt", subject: p.name, detail: p.file })),
    ...agentStates.slice(0, 4).map((a) => ({ kind: "Agent", subject: a.name, detail: `${a.state} · ${a.file}` })),
    ...waiting.slice(0, 2).map((it) => ({ kind: "Gate", subject: it.title, detail: "waiting for human response" })),
  ];
  const selectedIntent = INTENTS.find(([id]) => id === intent);
  const signals = [
    ...waiting.map((it) => ({ id: "wait-" + it.id, kind: "response", title: it.title, meta: it.destination || "needs your decision", icon: "ti-bell", item: it })),
    ...active.map((it) => ({ id: "active-" + it.id, kind: "active", title: it.title, meta: it.assignee || "in progress", icon: "ti-activity", item: it })),
    ...backlog.map((it) => ({ id: "backlog-" + it.id, kind: "planned", title: it.title, meta: it.destination || "planned work", icon: "ti-list-check", item: it })),
    ...agents.map((a) => ({ id: "agent-" + a.file + a.name, kind: "agent", title: a.name, meta: a.file, icon: "ti-robot", file: a.file })),
    ...prompts.map((p) => ({ id: "prompt-" + p.file + p.name, kind: "input", title: p.name, meta: p.file, icon: "ti-plug", file: p.file })),
    ...files.map((f) => ({ id: "file-" + f.rel, kind: "source", title: f.rel, meta: `${f.agents.length} agents · ${f.prompts.length} inputs`, icon: "ti-code", file: f.rel })),
  ];
  const selectedSignal = signals.find((s) => s.id === selectedSignalId) || signals[0] || {
    kind: "ready",
    title: "No project signals yet",
    meta: "Create or open Agape source to begin.",
    icon: "ti-sparkles",
  };

  const prime = (nextIntent, nextTarget, nextPrompt, nextLine = "") => {
    setIntent(nextIntent);
    setTarget(nextTarget || "next");
    setLine(nextLine);
    setPrompt(nextPrompt);
  };

  const submit = async () => {
    const text = prompt.trim();
    if (!text || pending) return;
    const context = [
      selectedIntent?.[1],
      target && target !== "next" ? target : "next best work",
      line ? `line ${line}` : null,
    ].filter(Boolean).join(" · ");
    const id = createWorkId();
    const title = text.length > 70 ? text.slice(0, 67) + "..." : text;
    const assignee = "Builder-1";
    const thread = [
      { who: "you", text },
      { who: "sys", text: `Assigned to ${assignee} - asking now.` },
    ];
    const item = {
      id,
      title,
      destination: context,
      status: "active",
      mode: "delegated",
      assignee,
      thread,
    };
    dispatch?.({
      type: "CREATE_WORK",
      id,
      title,
      destination: context,
      status: "active",
      mode: "delegated",
      assignee,
      thread,
      select: true,
    });
    setPrompt("");
    setPending(true);
    setError(null);
    onOpen?.(id);
    try {
      const reply = await agentRespond(item, thread, intent);
      dispatch?.({ type: "ADD_MESSAGE", id, message: { who: "ai", text: reply } });
    } catch (e) {
      const msg = e.message || "agent unavailable";
      setError(msg);
      dispatch?.({ type: "ADD_MESSAGE", id, message: { who: "sys", text: `agent unavailable - ${msg}` } });
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="mc-home">
      <section className="agent-desk">
        <div className="agent-desk-main">
          <div className="agape-wordmark">
            <span className="agape-mark" aria-hidden="true"><span /></span>
            <span>Agape Studio</span>
          </div>
          <h1>{state.goal || projectName}</h1>
          <p>{info?.hasProject ? `Project root: ${projectRoot}` : "Open Studio from an Agape project to inspect agents, files, runs, and ledger events."}</p>
          <div className="agent-intents">
            {INTENTS.map(([id, label, icon, desc]) => (
              <button key={id} className={intent === id ? "active" : ""} onClick={() => setIntent(id)} title={desc}>
                <i className={"ti " + icon} /> {label}
              </button>
            ))}
          </div>
          <div className="agent-prompt">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={
                intent === "inspect"
                  ? "Ask an agent to inspect a line, gate, memory recall, or behavior..."
                  : intent === "plan"
                    ? "Ask an agent to break down, define, or sequence product work..."
                    : "Tell an agent what to build, change, run, or review..."
              }
            />
            <div className="agent-prompt-foot">
              <select value={target} onChange={(e) => setTarget(e.target.value)} title="target context">
                <option value="next">next best work</option>
                {backlog.map((it) => <option key={it.id} value={it.title}>{it.title}</option>)}
                {active.map((it) => <option key={it.id} value={it.title}>{it.title}</option>)}
                {files.map((f) => <option key={f.rel} value={f.rel}>{f.rel}</option>)}
              </select>
              <input value={line} onChange={(e) => setLine(e.target.value)} placeholder="line" />
              <button className="accent" onClick={submit} disabled={pending}><i className="ti ti-send" /> {pending ? "Asking..." : "Ask agent"}</button>
            </div>
            {error && <div className="mc-muted-sm" style={{ color: "var(--vsc-error)", padding: "0 12px 10px" }}>{error}</div>}
          </div>
        </div>
        <div className="agent-response-rail">
          <div className="agent-response-head"><i className="ti ti-bell" /> response queue</div>
          {waiting.length ? waiting.slice(0, 4).map((it) => (
            <button key={it.id} className="agent-response-item" onClick={() => onOpen(it.id)}>
              <span>{it.title}</span>
              <em>{it.destination || "needs review"}</em>
            </button>
          )) : (
            <div className="agent-response-empty">No agent is blocked on you right now.</div>
          )}
          <div className="agent-quick">
            <button onClick={goWork}><i className="ti ti-checklist" /> Work</button>
            <button onClick={goBuilder}><i className="ti ti-sparkles" /> Builder</button>
            <button onClick={goRun}><i className="ti ti-player-play" /> Run</button>
            <button onClick={goFiles}><i className="ti ti-code" /> Code</button>
            <button onClick={goStudio}><i className="ti ti-settings" /> Settings</button>
          </div>
        </div>
      </section>

      <section className="system-inspector">
        <div className="system-map">
          <div className="canvas-head">
            <span>System Map</span>
            <em>{agentStates.length} agents</em>
          </div>
          <div className="topology">
            <div className="topology-node root">
              <i className="ti ti-cpu" />
              <span>{projectName}</span>
              <em>{info?.hasProject ? "project" : state.runtime.kind}</em>
            </div>
            <div className="topology-branches">
              <div><b>{files.length}</b><span>source</span></div>
              <div><b>{agentStates.length}</b><span>agents</span></div>
              <div><b>{prompts.length}</b><span>inputs</span></div>
              <div><b>{waiting.length}</b><span>blocked</span></div>
            </div>
          </div>
        </div>

        <div className="agent-state-panel">
          <div className="canvas-head">
            <span>Agent State</span>
            <em>live-ready</em>
          </div>
          <div className="agent-state-list">
            {agentStates.length ? agentStates.slice(0, 5).map((a) => (
              <button
                key={a.file + a.name}
                className="agent-state-row"
                onClick={() => prime("inspect", a.file, `Inspect agent ${a.name}: summarize its instruction, grants, gates, memory use, and current runtime state.`)}
              >
                <span className={"state-light " + a.state} />
                <b>{a.name}</b>
                <span>{a.focus}</span>
                <em>{a.risk}</em>
              </button>
            )) : (
              <div className="signal-empty">No declared agents found in source yet.</div>
            )}
          </div>
        </div>

        <div className="ledger-panel">
          <div className="canvas-head">
            <span>Ledger</span>
            <em>preview</em>
          </div>
          <div className="ledger-list">
            {ledgerPreview.map((e, i) => (
              <button
                key={i + e.kind + e.subject}
                className="ledger-row"
                onClick={() => prime("run", e.subject, `Run or inspect ledger evidence for ${e.subject}. Explain event causes, gates, and authority decisions.`)}
              >
                <code>#{String(i + 1).padStart(3, "0")}</code>
                <b>{e.kind}</b>
                <span>{e.subject}</span>
                <em>{e.detail}</em>
              </button>
            ))}
            {!ledgerPreview.length && <div className="signal-empty">Run a source file to populate ledger events.</div>}
          </div>
        </div>
      </section>

      <section className="agent-canvas">
        <div className="signal-rail">
          <div className="canvas-head">
            <span>Signal Field</span>
            <em>{signals.length}</em>
          </div>
          <div className="signal-list">
            {signals.slice(0, 14).map((s) => (
              <button
                key={s.id}
                className={"signal-row" + (selectedSignal.id === s.id ? " active" : "")}
                onClick={() => setSelectedSignalId(s.id)}
              >
                <i className={"ti " + s.icon} />
                <span>{s.title}</span>
                <em>{s.kind}</em>
              </button>
            ))}
            {!signals.length && <div className="signal-empty">No signals yet.</div>}
          </div>
        </div>

        <div className="signal-detail">
          <div className="detail-orbit">
            <span className={"orbit-node " + selectedSignal.kind}><i className={"ti " + selectedSignal.icon} /></span>
            <div>
              <div className="detail-kind">{selectedSignal.kind}</div>
              <h2>{selectedSignal.title}</h2>
              <p>{selectedSignal.meta}</p>
            </div>
          </div>
          <div className="detail-actions">
            {selectedSignal.item && <button onClick={() => onOpen(selectedSignal.item.id)}><i className="ti ti-arrow-up-right" /> Open work</button>}
            {selectedSignal.file && <button onClick={goFiles}><i className="ti ti-code" /> Inspect source</button>}
            <button onClick={goRun}><i className="ti ti-player-play" /> Run evidence</button>
          </div>
          <div className="detail-metrics">
            <Metric label="needs response" value={c.waiting} tone={c.waiting > 0 ? "warn" : ""} />
            <Metric label="in motion" value={c.active} />
            <Metric label="planned" value={c.backlog} onClick={goWork} />
            <Metric label="source files" value={files.length} onClick={goFiles} />
          </div>
        </div>

        <div className="move-stack">
          <div className="canvas-head">
            <span>Suggested Moves</span>
            <em>agent-ready</em>
          </div>
          <button className="move-card" onClick={() => prime("plan", "next", "Define the next smallest valuable product slice and turn it into executable Agape work.")}>
            <i className="ti ti-map" />
            <span>Shape the product path</span>
            <em>turn vague intent into queued work</em>
          </button>
          <button className="move-card" onClick={() => prime("inspect", selectedSignal.file || target, `Inspect ${selectedSignal.title} for gate, authority, memory, and tool-use risks.`)}>
            <i className="ti ti-search" />
            <span>Inspect this signal</span>
            <em>ask for evidence, not vibes</em>
          </button>
          <button className="move-card" onClick={() => prime("inspect", "system", "Inspect the whole multi-agent system: topology, agent states, grants, gates, memory flows, and ledger evidence.")}>
            <i className="ti ti-topology-star-ring-3" />
            <span>Inspect the system</span>
            <em>topology, state, ledger, gates</em>
          </button>
          <button className="move-card" onClick={() => prime("build", selectedSignal.file || target, "Draft the Agape change, run conformance, and report the smallest safe patch.")}>
            <i className="ti ti-hammer" />
            <span>Delegate implementation</span>
            <em>write, check, learn</em>
          </button>
          <button className="move-card" onClick={() => prime("review", selectedSignal.title, "Review the current agent output and identify what needs human decision before proceeding.")}>
            <i className="ti ti-shield-check" />
            <span>Review decision point</span>
            <em>respond where judgment matters</em>
          </button>
        </div>
      </section>
    </div>
  );
}
