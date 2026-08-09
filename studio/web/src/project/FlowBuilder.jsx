import { useEffect, useMemo, useRef, useState } from "react";
import * as project from "./projectApi.js";
import { FLOW_KINDS, canvasBounds, changedFields, edgePath, kindIcon, layoutFlow, visibleFlow } from "./flowModel.js";
import { runtimeSessions } from "./runtimeSessionClient.js";

function positionKey(rel) { return `agape.flow.positions:${rel}`; }
function loadPositions(rel) {
  try { return JSON.parse(localStorage.getItem(positionKey(rel)) || "{}"); }
  catch { return {}; }
}
function storePositions(rel, positions) {
  try { localStorage.setItem(positionKey(rel), JSON.stringify(positions)); } catch {}
}

export default function FlowBuilder({ info, onOpenCode }) {
  const [rel, setRel] = useState(info?.files?.[0]?.rel || "");
  const [document, setDocument] = useState(null);
  const [draft, setDraft] = useState({});
  const [selected, setSelected] = useState(null);
  const [positions, setPositions] = useState({});
  const [query, setQuery] = useState("");
  const [kinds, setKinds] = useState(FLOW_KINDS);
  const [focus, setFocus] = useState(false);
  const [compact, setCompact] = useState(false);
  const [state, setState] = useState({ phase: rel ? 'loading' : 'idle', message: '' });

  const load = async (nextRel = rel) => {
    if (!nextRel) return;
    setState({ phase: "loading", message: "Reading Agape flow…" });
    try {
      const next = await project.flow(nextRel);
      setDocument(next);
      setDraft({});
      setSelected((id) => next.nodes.some((node) => node.id === id) ? id : next.nodes[0]?.id || null);
      const stored = loadPositions(nextRel);
      setPositions({ ...layoutFlow(next.nodes, next.edges), ...stored });
      setState({ phase: "ready", message: "" });
    } catch (error) {
      setDocument(null);
      setState({ phase: "error", message: error.message });
    }
  };

  useEffect(() => { load(rel); }, [rel]); // eslint-disable-line react-hooks/exhaustive-deps

  const changes = useMemo(() => changedFields(document, draft), [document, draft]);
  const filtered = useMemo(() => visibleFlow(document?.nodes || [], document?.edges || [], {
    query, kinds, focusId: focus ? selected : null,
  }), [document, query, kinds, focus, selected]);
  const filteredActive = Boolean(query.trim() || focus || kinds.length !== FLOW_KINDS.length);
  const displayPositions = useMemo(() => filteredActive
    ? layoutFlow(filtered.nodes.map((node) => ({ ...node, position: null })), filtered.edges)
    : positions,
  [filteredActive, filtered.nodes, filtered.edges, positions]);
  const bounds = useMemo(() => canvasBounds(filtered.nodes, displayPositions), [filtered.nodes, displayPositions]);
  const selectedNode = document?.nodes.find((node) => node.id === selected) || null;

  const save = async () => {
    if (!document || !changes.length) return;
    const submitted = new Map(changes.map((change) => [`${change.nodeId}:${change.field}`, change.value]));
    setState({ phase: "saving", message: `Saving ${changes.length} change${changes.length === 1 ? "" : "s"}…` });
    try {
      await runtimeSessions.reset(info.root || info.name, rel);
      const next = await project.saveFlow(rel, document.revision, changes);
      setDocument(next);
      setDraft((current) => {
        const remaining = { ...current };
        for (const [key, value] of submitted) {
          if (Object.is(current[key], value)) delete remaining[key];
        }
        return remaining;
      });
      setSelected((id) => next.nodes.some((node) => node.id === id) ? id : next.nodes[0]?.id || null);
      setState({ phase: "saved", message: "Saved to Agape source" });
    } catch (error) {
      const suffix = error.code === "stale_revision" ? " Reload before saving again." : "";
      setState({ phase: "error", message: `${error.message}${suffix}`, diagnostics: error.diagnostics || [] });
    }
  };

  const saveStructure = async (patch) => {
    if (!document || !patch) return;
    if (changes.length) {
      setState({ phase: "error", message: "Save or reload property drafts before applying a structural source patch." });
      return;
    }
    setState({ phase: "saving", message: "Checking structural source patch…" });
    try {
      await runtimeSessions.reset(info.root || info.name, rel);
      const next = await project.saveFlowStructure(rel, document.revision, patch);
      setDocument(next);
      setSelected((id) => next.nodes.some((node) => node.id === id) ? id : next.nodes[0]?.id || null);
      setPositions((current) => ({ ...layoutFlow(next.nodes, next.edges), ...current }));
      setState({ phase: "saved", message: "Compiled and saved to Agape source", sourceDiff: next.sourceDiff || "" });
    } catch (error) {
      const suffix = error.code === "stale_revision" ? " Reload before editing again." : "";
      setState({ phase: "error", message: `${error.message}${suffix}`, diagnostics: error.diagnostics || [] });
    }
  };

  const createAgent = () => {
    if (!document?.capabilities?.createNodes) return;
    const name = window.prompt("New agent identifier");
    if (name) saveStructure({ op: "create_agent", name: name.trim() });
  };

  const resetLayout = () => {
    const next = layoutFlow(document?.nodes || [], document?.edges || []);
    setPositions(next);
    storePositions(rel, next);
  };

  return (
    <div className="flow-builder">
      <header className="flow-toolbar">
        <div className="flow-title">
          <span className="flow-title-icon"><i className="ti ti-route" /></span>
          <div><b>Agentic flow</b><span>Properties and explicit port drops rewrite <code>.ag</code>; dragging a card header arranges only this canvas.</span></div>
        </div>
        <label className="flow-file-select">
          <span>Program</span>
          <select value={rel} onChange={(event) => setRel(event.target.value)}>
            {(info?.files || []).map((file) => <option key={file.rel} value={file.rel}>{file.rel}</option>)}
          </select>
        </label>
        <div className="flow-toolbar-actions">
          <button onClick={createAgent} disabled={!document?.capabilities?.createNodes || state.phase === "saving"}><i className="ti ti-robot-plus" /> New agent</button>
          <button onClick={() => load()} disabled={!rel || state.phase === "loading"}><i className="ti ti-refresh" /> Reload</button>
          <button onClick={onOpenCode}><i className="ti ti-code" /> Open code</button>
          <button className="primary" onClick={save} disabled={!changes.length || state.phase === "saving" || document?.readOnly}>
            <i className="ti ti-device-floppy" /> {state.phase === "saving" ? "Saving…" : `Save${changes.length ? ` (${changes.length})` : ""}`}
          </button>
        </div>
      </header>

      {!rel ? <Empty icon="ti-file-off" title="No Agape program" detail="Add a .ag file to this project to build its flow." />
        : state.phase === "loading" ? <Empty icon="ti-loader-2 flow-spin" title="Reading flow" detail="Parsing agents, model calls, outputs, and gates…" />
          : !document ? <Empty icon="ti-alert-triangle" title="Flow unavailable" detail={state.message} action={<button onClick={() => load()}>Try again</button>} />
            : <>
              {(document.diagnostics?.length > 0 || state.message) && (
                <div className={`flow-banner ${state.phase === "error" ? "error" : state.phase === "saved" ? "saved" : ""}`} role="status">
                  <i className={`ti ${state.phase === "error" ? "ti-alert-circle" : state.phase === "saved" ? "ti-circle-check" : "ti-info-circle"}`} />
                  <span>{state.message || `${document.diagnostics.length} parser diagnostic${document.diagnostics.length === 1 ? "" : "s"}`}</span>
                  {(state.diagnostics || document.diagnostics || []).slice(0, 2).map((d, index) => <em key={index}>{d.message}</em>)}
                </div>
              )}
              {state.sourceDiff && <details className="flow-source-diff"><summary>Source diff</summary><pre>{state.sourceDiff}</pre></details>}
              <div className="flow-workspace">
                <aside className="flow-filter-panel">
                  <label className="flow-search"><i className="ti ti-search" /><input aria-label="Search flow" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search this flow…" /></label>
                  <div className="flow-panel-heading"><span>Constructs</span><em>{filtered.nodes.length}/{document.nodes.length}</em></div>
                  <div className="flow-kind-list">
                    {FLOW_KINDS.map((kind) => {
                      const count = document.nodes.filter((node) => node.kind === kind).length;
                      if (!count) return null;
                      const active = kinds.includes(kind);
                      return <button key={kind} className={active ? "active" : ""} onClick={() => setKinds((list) => active ? list.filter((item) => item !== kind) : [...list, kind])}>
                        <i className={`ti ${kindIcon(kind)}`} /><span>{kind}</span><em>{count}</em>
                      </button>;
                    })}
                  </div>
                  <div className="flow-panel-heading"><span>View</span></div>
                  <label className="flow-check"><input type="checkbox" checked={focus} disabled={!selected} onChange={(e) => setFocus(e.target.checked)} /><span>Focus neighbors</span></label>
                  <label className="flow-check"><input type="checkbox" checked={compact} onChange={(e) => setCompact(e.target.checked)} /><span>Compact cards</span></label>
                  <button className="flow-layout-btn" onClick={resetLayout}><i className="ti ti-layout-grid" /> Auto-layout</button>
                  <div className="flow-capabilities">
                    <b>Safe edit scope</b>
                    <span>{document.capabilities?.editProperties ? 'Unlocked prompt text, thresholds, and literal say templates rewrite source when saved.' : 'This flow is inspect-only.'}</span>
                    <span>Card headers move layout only. Drag an output port onto an explicit compatible input port to reconnect; drag a step handle onto another step to reorder.</span>
                    <span>Unsupported argument synthesis, dependency-bearing deletion, and ambiguous AST shapes remain Code-only.</span>
                  </div>
                </aside>

                <FlowCanvas nodes={filtered.nodes} edges={filtered.edges} positions={displayPositions} setPositions={setPositions}
                  rel={rel} selected={selected} setSelected={setSelected} bounds={bounds} compact={compact} draggable={!filteredActive} onStructuralPatch={saveStructure} />

                <Inspector node={selectedNode} draft={draft} setDraft={setDraft} documentReadOnly={document.readOnly || state.phase === "saving"} capabilities={document.capabilities} onStructuralPatch={saveStructure} />
              </div>
            </>}
    </div>
  );
}

function FlowCanvas({ nodes, edges, positions, setPositions, rel, selected, setSelected, bounds, compact, draggable = true, onStructuralPatch = () => {} }) {
  const drag = useRef(null);
  const move = (event) => {
    if (!drag.current) return;
    const { id, x, y, left, top } = drag.current;
    setPositions((current) => ({ ...current, [id]: { x: Math.max(12, left + event.clientX - x), y: Math.max(12, top + event.clientY - y) } }));
  };
  const end = () => {
    if (!drag.current) return;
    drag.current = null;
    setPositions((current) => { storePositions(rel, current); return current; });
  };
  return (
    <main className="flow-canvas-viewport" onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
      {!nodes.length ? <div className="flow-no-results"><i className="ti ti-filter-off" /><b>No matching constructs</b><span>Clear search, filters, or focus mode.</span></div> : null}
      <div className="flow-canvas" style={{ width: bounds.width, height: bounds.height }}>
        <svg width={bounds.width} height={bounds.height} className="flow-edges" aria-hidden="true">
          <defs><marker id="flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" /></marker></defs>
          {edges.map((edge) => <g key={edge.id}><path d={edgePath(edge, positions)} markerEnd="url(#flow-arrow)" /><title>{edge.label || edge.kind}</title></g>)}
        </svg>
        {nodes.map((node) => {
          const p = positions[node.id] || { x: 42, y: 42 };
          return <article key={node.id} data-kind={node.kind} className={'flow-node ' + (selected === node.id ? 'selected ' : '') + (compact ? 'compact ' : '') + (draggable ? '' : 'locked-layout')}
            style={{ transform: `translate(${p.x}px, ${p.y}px)` }} onClick={() => setSelected(node.id)} onDragOver={(event) => {
              if (event.dataTransfer.types.includes("application/x-agape-flow-structure")) event.preventDefault();
            }} onDrop={(event) => {
              const payload = readStructuralDrag(event);
              if (payload?.mode === "reorder" && payload.nodeId !== node.id && isStructuralStep(node)) {
                event.preventDefault(); onStructuralPatch({ op: "reorder_step", nodeId: payload.nodeId, beforeNodeId: node.id });
              }
            }}>
            <div className='flow-node-head' title={draggable ? 'Drag to arrange this canvas' : 'Clear filters or focus mode to arrange the canvas'} onPointerDown={(event) => {
              if (!draggable) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              drag.current = { id: node.id, x: event.clientX, y: event.clientY, left: p.x, top: p.y };
              setSelected(node.id);
            }}>
              <span><i className={`ti ${kindIcon(node.kind)}`} />{node.kind}</span>
              <span className="flow-node-tools">
                {isStructuralStep(node) && <i className="ti ti-arrows-sort flow-reorder-handle" draggable="true" title="Drag onto another source-backed step to reorder" onPointerDown={(event) => event.stopPropagation()} onDragStart={(event) => writeStructuralDrag(event, { mode: "reorder", nodeId: node.id })} />}
                {node.readOnly && <i className="ti ti-lock" title={node.readOnlyReason || "Read-only construct"} />}
              </span>
            </div>
            <b className="flow-node-label">{node.label}</b>
            {!compact && <div className="flow-node-fields">{(node.fields || []).slice(0, 2).map((field) => <span key={field.key}><em>{field.label}</em>{String(field.value ?? "") || "—"}</span>)}</div>}
            <span className="flow-port in" title="Drop an explicit structural connection here" onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); }} onDrop={(event) => {
              event.preventDefault(); event.stopPropagation();
              const payload = readStructuralDrag(event);
              const source = nodes.find((candidate) => candidate.id === payload?.nodeId);
              let patch = connectionPatch(source, node);
              if (patch?.op === "add_handoff" && patch.handoff === "message") {
                const message = window.prompt("Text payload for this message handoff");
                if (message === null) return;
                patch = { ...patch, message };
              }
              if (patch) onStructuralPatch(patch);
            }} />
            <span className="flow-port out" draggable={isConnectionSource(node) ? "true" : undefined} title={isConnectionSource(node) ? "Drag onto a compatible input port to rewrite source" : "Visual output port"} onDragStart={(event) => {
              if (!isConnectionSource(node)) return;
              event.stopPropagation(); writeStructuralDrag(event, { mode: "connect", nodeId: node.id });
            }} />
          </article>;
        })}
      </div>
    </main>
  );
}

function Inspector({ node, draft, setDraft, documentReadOnly, capabilities = {}, onStructuralPatch = () => {} }) {
  if (!node) return <aside className="flow-inspector"><Empty icon="ti-click" title="Select a construct" detail="Inspect its properties and safe edit surface." /></aside>;
  return <aside className="flow-inspector">
    <div className="flow-inspector-head"><span data-kind={node.kind}><i className={`ti ${kindIcon(node.kind)}`} />{node.kind}</span><b>{node.label}</b><code>{node.id}</code></div>
    <div className="flow-inspector-body">
      {node.readOnly && <div className='flow-readonly'><i className='ti ti-lock' /><b>Visible, not editable</b><span>{node.readOnlyReason || 'This construct is compiler-derived and must be edited in Code.'}</span></div>}
      {!node.readOnly && !node.fields?.length && <div className='flow-readonly'><i className='ti ti-lock' /><b>Visible, not editable</b><span>This construct has no safe source-preserving properties yet.</span></div>}
      <div className="flow-structural-actions">
        {capabilities.deleteNodes && node.metadata?.compilerMeta?.deletable === true && <button onClick={() => onStructuralPatch({ op: "delete_agent", nodeId: node.id })}><i className="ti ti-trash" /> Delete unreferenced agent</button>}
        {isStructuralStep(node) && <button onClick={() => onStructuralPatch({ op: "remove_handoff", nodeId: node.id })}><i className="ti ti-unlink" /> Remove handoff</button>}
      </div>
      {(node.fields || []).map((field) => {
        const key = `${node.id}:${field.key}`;
        const value = Object.prototype.hasOwnProperty.call(draft, key) ? draft[key] : field.value;
        const locked = documentReadOnly || node.readOnly || field.readOnly;
        const common = { id: `flow-field-${encodeURIComponent(key)}`, value: value ?? "", disabled: locked,
          onChange: (event) => setDraft((current) => ({ ...current, [key]: field.type === "number" ? Number(event.target.value) : event.target.value })) };
        return <label className="flow-field" key={field.key}>
          <span>{field.label}{locked && <i className="ti ti-lock" title={field.readOnlyReason || "Read-only"} />}</span>
          {field.type === "multiline" ? <textarea {...common} rows={8} />
            : field.type === "select" ? <select {...common}>{(field.options || []).map((option) => <option key={option} value={option}>{option}</option>)}</select>
              : <input {...common} type={field.type === "number" ? "number" : "text"} />}
          {locked && <small>{field.readOnlyReason || "Shown for context; edit this in Code."}</small>}
        </label>;
      })}
    </div>
  </aside>;
}

function Empty({ icon, title, detail, action }) {
  return <div className="flow-empty"><i className={`ti ${icon}`} /><b>{title}</b><span>{detail}</span>{action}</div>;
}

function isStructuralStep(node) {
  return Boolean(node?.metadata?.compilerMeta?.invocation) && ["event", "action", "message"].includes(node.kind);
}
function isConnectionSource(node) {
  return node?.kind === "agent" || isStructuralStep(node);
}
function declarationTarget(node) {
  if (node?.metadata?.compilerMeta?.declaration) return { handoff: node.metadata.compilerMeta.handoffKind, target: node.metadata.compilerMeta.name };
  const compilerId = node?.metadata?.compilerNodeId || "";
  if (node?.kind === "agent" && compilerId.startsWith("agent:")) return { handoff: "message", target: compilerId.slice(6) };
  return null;
}

function connectionPatch(source, target) {
  const destination = declarationTarget(target);
  if (!source || !destination) return null;
  if (source.kind === "agent" && (destination.handoff === "event" || destination.handoff === "action")) {
    return { op: "add_handoff", contextNodeId: source.id, handoff: destination.handoff, target: destination.target };
  }
  if (source.kind === "agent" && destination.handoff === "message") {
    const compilerId = source.metadata?.compilerNodeId || "";
    if (!compilerId.startsWith("agent:")) return null;
    return { op: "add_handoff", contextNodeId: `instance:${compilerId.slice(6)}`, handoff: "message", target: destination.target };
  }
  if (!isStructuralStep(source)) return null;
  const sourceKind = source.metadata.compilerMeta.handoffKind;
  if (sourceKind !== destination.handoff) return null;
  return { op: "reconnect_handoff", nodeId: source.id, target: destination.target };
}

function writeStructuralDrag(event, payload) {
  event.dataTransfer.setData("application/x-agape-flow-structure", JSON.stringify(payload));
  event.dataTransfer.effectAllowed = "move";
}
function readStructuralDrag(event) {
  try { return JSON.parse(event.dataTransfer.getData("application/x-agape-flow-structure") || "null"); }
  catch { return null; }
}

export { FlowCanvas, Inspector, connectionPatch };
