import { useState, useEffect, useMemo, useRef } from "react";
import Editor from "@monaco-editor/react";
import { registerAgape, AGAPE_LANG_ID } from "../agapeLanguage.js";
import * as project from "./projectApi.js";

// True when the viewport is phone-width — drives the single-pane mobile layout.
function useNarrow(bp = 860) {
  const [narrow, setNarrow] = useState(typeof window !== "undefined" && window.innerWidth < bp);
  useEffect(() => {
    const on = () => setNarrow(window.innerWidth < bp);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, [bp]);
  return narrow;
}

// The Project studio: inspect a project's agents, edit their .ag code, and run it —
// feeding the `prompt` sensors with input and watching the spine that results.
// Desktop shows the three panels side-by-side; phone shows one at a time.
export default function ProjectView({ info, onReview }) {
  const [sel, setSel] = useState(info.files[0]?.rel || null);
  const [src, setSrc] = useState("");
  const [dirty, setDirty] = useState(false);
  const [prompts, setPrompts] = useState({});
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState(null);
  const [claude, setClaude] = useState(false);
  const dirtyRef = useRef(false);
  const narrow = useNarrow();
  const [pane, setPane] = useState("code"); // mobile: files | code | run

  const file = useMemo(() => info.files.find((f) => f.rel === sel), [info, sel]);

  // Pair each Sent→Resolved (by correlation id) into one provider/LLM call, and
  // estimate usage. Token counts are ~chars/4; cost uses Haiku-class rates. These
  // are ESTIMATES off the deterministic mock — a live connector makes them real.
  const run = useMemo(() => {
    if (!result || !result.ok) return null;
    const sent = {}; const calls = [];
    for (const e of result.events) {
      if (e.etype === "Sent" && e.corr != null) sent[e.corr] = e.payload;
      else if (e.etype === "Resolved" && e.corr != null && sent[e.corr] != null) {
        calls.push({ input: sent[e.corr], output: e.payload });
      }
    }
    const tok = (s) => Math.ceil((s || "").length / 4);
    const tokIn = calls.reduce((a, c) => a + tok(c.input), 0);
    const tokOut = calls.reduce((a, c) => a + tok(c.output), 0);
    const cost = (tokIn / 1e6) * 0.8 + (tokOut / 1e6) * 4.0; // $0.80 / $4.00 per Mtok
    return { calls, tokIn, tokOut, cost };
  }, [result]);

  // Load the selected file's source.
  useEffect(() => {
    if (!sel) return;
    let live = true;
    project.file(sel).then((d) => { if (live) { setSrc(d.body); setDirty(false); dirtyRef.current = false; } });
    setResult(null);
    setMsg(null);
    return () => { live = false; };
  }, [sel]);

  const pickFile = (rel) => { setSel(rel); setPane("code"); }; // on phone, jump to the code
  const save = async () => {
    try { await project.saveFile(sel, src); setDirty(false); dirtyRef.current = false; setMsg({ ok: true, t: "saved" }); }
    catch (e) { setMsg({ ok: false, t: e.message }); }
  };
  const runIt = async () => {
    setRunning(true); setMsg(null);
    setPane("run"); // on phone, surface the output
    try {
      if (dirtyRef.current) await project.saveFile(sel, src); // run what you see
      const r = await project.run(sel, prompts, { claude });
      setResult({ ...r, claude }); // remember which provider produced this run
      setDirty(false); dirtyRef.current = false;
    } catch (e) { setResult({ ok: false, error: e.message }); }
    setRunning(false);
  };

  const showFiles = !narrow || pane === "files";
  const showCode = !narrow || pane === "code";
  const showRun = !narrow || pane === "run";

  const sidebar = (
    <aside className="pj-side">
      <div className="pj-side-h">agents &amp; files</div>
      {info.files.map((f) => (
        <div key={f.rel} className={"pj-file" + (f.rel === sel ? " on" : "")} onClick={() => pickFile(f.rel)}>
          <div className="pj-fname">{f.rel}</div>
          {f.agents.map((a) => <div key={a} className="pj-agent">▸ {a}</div>)}
          {f.prompts.map((p) => <div key={p} className="pj-sensor">⌁ {p} <span className="pj-dim">(input)</span></div>)}
        </div>
      ))}
      {info.files.length === 0 && <div className="pj-dim" style={{ padding: 12 }}>no .ag files in this project</div>}
    </aside>
  );

  const editor = (
    <main className="pj-editor">
      {sel ? (
        <Editor height="100%" language={AGAPE_LANG_ID} theme="agape-dark" path={sel} value={src}
          onChange={(v) => { setSrc(v ?? ""); setDirty(true); dirtyRef.current = true; }} beforeMount={registerAgape}
          options={{ fontSize: 13, minimap: { enabled: false }, automaticLayout: true, scrollBeyondLastLine: false, tabSize: 2 }} />
      ) : <div className="pj-dim" style={{ margin: "auto" }}>select a file</div>}
    </main>
  );

  const runPanel = (
    <section className="pj-run-panel">
      <div className="pj-run-h">
        <span className="pj-side-h" style={{ padding: 0 }}>run</span>
        <span style={{ flex: 1 }} />
        <label className="pj-toggle" title="Route the ← cognition seam to a real Claude (sampling fallback for graded judgments) instead of the deterministic mock">
          <input type="checkbox" checked={claude} onChange={(e) => setClaude(e.target.checked)} />
          <span>🧠 Claude</span>
        </label>
      </div>
      {file && file.prompts.length > 0 ? (
        <div className="pj-inputs">
          <div className="pj-dim" style={{ marginBottom: 6 }}>user input → the <code>prompt</code> sensors:</div>
          {file.prompts.map((p) => (
            <label key={p} className="pj-inp">
              <span>{p}</span>
              <input placeholder={`value for ${p}…`} value={prompts[p] || ""}
                onChange={(e) => setPrompts((m) => ({ ...m, [p]: e.target.value }))}
                onKeyDown={(e) => { if (e.key === "Enter") runIt(); }} />
            </label>
          ))}
        </div>
      ) : <div className="pj-dim" style={{ padding: "0 12px 8px" }}>no <code>prompt</code> sensors — runs on awake.</div>}

      {msg && <div className={"pj-msg " + (msg.ok ? "ok" : "bad")}>{msg.t}</div>}

      <div className="pj-spine">
        {!result ? (
          <div className="pj-dim" style={{ padding: 12 }}>▶ Run to see the LLM calls, cost, and the spine — the append-only log of everything the agents do.</div>
        ) : result.ok ? (
          <>
            <div className="pj-metrics">
              <div className="pj-metric"><b>{run.calls.length}</b><span>LLM calls</span></div>
              <div className="pj-metric"><b>{run.tokIn}</b><span>tok in</span></div>
              <div className="pj-metric"><b>{run.tokOut}</b><span>tok out</span></div>
              <div className="pj-metric"><b>~${run.cost < 0.001 ? run.cost.toFixed(5) : run.cost.toFixed(3)}</b><span>est. cost</span></div>
            </div>
            <div className="pj-metric-note">{result.claude ? "live Claude (haiku) · sampling fallback · tokens estimated from text" : "estimated · deterministic mock provider (no live connector)"}</div>

            <div className="pj-section-h">llm calls</div>
            {run.calls.length === 0 && <div className="pj-dim" style={{ padding: "0 12px 8px" }}>no provider calls this run</div>}
            {run.calls.map((c, i) => (
              <div key={i} className="pj-call">
                <div className="pj-io"><span className="pj-io-tag in">in</span><span className="pj-io-txt">{c.input}</span></div>
                <div className="pj-io"><span className="pj-io-tag out">out</span><span className="pj-io-txt">{c.output}</span></div>
              </div>
            ))}

            <div className="pj-section-h">spine</div>
            {result.events.map((e, i) => <SpineRow key={i} e={e} />)}
            <div className="pj-dim" style={{ padding: "8px 12px" }}>{result.events.length} events · {result.head?.slice(0, 16)}</div>
          </>
        ) : (
          <div className="pj-err">✗ {result.class ? result.class + ": " : ""}{result.error}</div>
        )}
      </div>
    </section>
  );

  return (
    <div className="pj">
      <header className="pj-top">
        <b style={{ letterSpacing: 0.3 }}>Agape</b>
        <span className="pj-badge">{info.name}</span>
        {!narrow && <span className="pj-dim pj-path" title={info.root}>{info.root}</span>}
        <span style={{ flex: 1 }} />
        <button onClick={save} disabled={!sel}>{dirty ? "Save*" : "Save"}</button>
        <button className="pj-run" onClick={runIt} disabled={!sel || running}>{running ? "running…" : "▶ Run"}</button>
        {onReview && <button onClick={onReview}>{narrow ? "✓" : "Conformance →"}</button>}
      </header>

      {narrow && (
        <nav className="pj-seg">
          <button className={pane === "files" ? "on" : ""} onClick={() => setPane("files")}>Files</button>
          <button className={pane === "code" ? "on" : ""} onClick={() => setPane("code")}>Code</button>
          <button className={pane === "run" ? "on" : ""} onClick={() => setPane("run")}>Run{result ? ` (${result.ok ? result.events.length : "✗"})` : ""}</button>
        </nav>
      )}

      <div className={"pj-body" + (narrow ? " narrow" : "")}>
        {showFiles && sidebar}
        {showCode && editor}
        {showRun && runPanel}
      </div>
      <style>{STYLE}</style>
    </div>
  );
}

// Color the spine by what each event means: decisions/deliveries are the points
// that matter; the send chain is dim scaffolding.
function SpineRow({ e }) {
  const k = e.etype;
  let cls = "ev-dim";
  if (/Decided|Reply|Attestation|Internalized/.test(k)) cls = "ev-good";
  else if (/Abstained|Failed|Error|Contradiction|TypeMismatch|RetryExhausted|Crashed|Expired|rejected/.test(k) || k === "Event") cls = "ev-warn";
  else if (/Prompt|Draft|Spawned|AgentAwake/.test(k)) cls = "ev-note";
  return (
    <div className={"ev " + cls}>
      <span className="ev-t">{e.tick}</span>
      <span className="ev-k">{e.etype}</span>
      <span className="ev-s">{e.subject || ""}</span>
      <span className="ev-p">{e.payload && e.payload !== e.subject ? e.payload : ""}</span>
    </div>
  );
}

const STYLE = `
.pj{position:fixed;inset:0;display:flex;flex-direction:column;background:#0f1115;color:#e6e9ef;font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif}
.pj code{font:12px ui-monospace,Menlo,Consolas,monospace;color:#9aa4b2}
.pj-top{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid #2a3140;background:#161a22;flex-wrap:wrap}
.pj-badge{font:600 12px ui-monospace,monospace;padding:4px 9px;border-radius:6px;background:#243049;color:#e6e9ef}
.pj-path{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:40vw}
.pj button{font:inherit;cursor:pointer;border:1px solid #2a3140;background:#1d2330;color:#e6e9ef;border-radius:7px;padding:6px 12px}
.pj button.pj-run{background:#58a6ff;border-color:#58a6ff;color:#04101f;font-weight:600}
.pj button:disabled{opacity:.5;cursor:default}
.pj-dim{color:#9aa4b2}.ok{color:#3fb950}.bad{color:#f85149}
/* mobile segmented switcher */
.pj-seg{display:flex;gap:6px;padding:8px 12px;border-bottom:1px solid #2a3140;background:#13161d}
.pj-seg button{flex:1;font:inherit;cursor:pointer;border:1px solid #2a3140;background:#1d2330;color:#9aa4b2;border-radius:8px;padding:9px}
.pj-seg button.on{background:#243049;color:#e6e9ef;border-color:#345}
.pj-body{flex:1;display:flex;min-height:0}
.pj-body.narrow{flex-direction:column}
.pj-side{width:240px;border-right:1px solid #2a3140;background:#13161d;overflow:auto}
.pj-side-h{font:600 11px ui-monospace,monospace;text-transform:uppercase;letter-spacing:.5px;color:#6b7588;padding:10px 12px 4px}
.pj-file{padding:7px 12px;cursor:pointer;border-bottom:1px solid #1b2230}
.pj-file:hover{background:#1d2330}.pj-file.on{background:#243049}
.pj-fname{font:600 12.5px ui-monospace,monospace}
.pj-agent{font:12px ui-monospace,monospace;color:#7ee787;padding-left:8px}
.pj-sensor{font:12px ui-monospace,monospace;color:#79c0ff;padding-left:8px}
.pj-editor{flex:1;display:flex;min-width:0}
.pj-run-panel{width:360px;border-left:1px solid #2a3140;background:#13161d;display:flex;flex-direction:column;min-height:0}
.pj-run-h{display:flex;align-items:center;padding:10px 12px 4px}
.pj-toggle{display:flex;align-items:center;gap:5px;font-size:12px;color:#9aa4b2;cursor:pointer;user-select:none}
.pj-toggle input{cursor:pointer;accent-color:#d29922}
.pj-inputs{padding:6px 12px}
.pj-inp{display:flex;flex-direction:column;gap:3px;margin-bottom:8px}
.pj-inp span{font:12px ui-monospace,monospace;color:#79c0ff}
.pj-inp input{font:inherit;background:#1d2330;border:1px solid #2a3140;color:#e6e9ef;border-radius:7px;padding:6px 9px}
.pj-msg{padding:4px 12px;font-size:12.5px}
.pj-spine{flex:1;overflow:auto;border-top:1px solid #2a3140;margin-top:4px}
.pj-metrics{display:flex;gap:8px;padding:10px 12px 4px}
.pj-metric{flex:1;background:#1a1f2b;border:1px solid #2a3140;border-radius:8px;padding:7px 6px;text-align:center;display:flex;flex-direction:column;gap:1px}
.pj-metric b{font:600 15px ui-monospace,monospace;color:#e6e9ef}
.pj-metric span{font-size:10.5px;color:#6b7588;text-transform:uppercase;letter-spacing:.3px}
.pj-metric-note{font-size:11px;color:#6b7588;padding:0 12px 2px}
.pj-section-h{font:600 11px ui-monospace,monospace;text-transform:uppercase;letter-spacing:.5px;color:#6b7588;padding:10px 12px 4px}
.pj-call{margin:0 12px 8px;border:1px solid #232b39;border-radius:8px;overflow:hidden}
.pj-io{display:flex;gap:8px;padding:6px 9px;font:12px/1.45 ui-monospace,Menlo,Consolas,monospace}
.pj-io+.pj-io{border-top:1px solid #232b39;background:#11151d}
.pj-io-tag{flex:none;font:600 10px ui-monospace,monospace;padding:1px 6px;border-radius:5px;height:fit-content;text-transform:uppercase}
.pj-io-tag.in{background:#1d2a3a;color:#79c0ff}.pj-io-tag.out{background:#15291c;color:#7ee787}
.pj-io-txt{white-space:pre-wrap;word-break:break-word;color:#cdd3dc}
.pj-err{padding:12px;color:#f85149;font:12.5px ui-monospace,monospace;white-space:pre-wrap}
.ev{display:grid;grid-template-columns:30px 150px 1fr;grid-template-areas:"t k s" ". p p";gap:0 8px;padding:3px 12px;font:12px ui-monospace,monospace;border-bottom:1px solid #161b24}
.ev-t{grid-area:t;color:#48515f;text-align:right}
.ev-k{grid-area:k;font-weight:600}
.ev-s{grid-area:s;color:#9aa4b2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ev-p{grid-area:p;color:#6b7588;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ev-good .ev-k{color:#3fb950}.ev-warn .ev-k{color:#d29922}.ev-note .ev-k{color:#79c0ff}.ev-dim .ev-k{color:#6b7588}
/* phone: each visible pane fills the screen so the editor is readable */
.pj-body.narrow .pj-side,.pj-body.narrow .pj-run-panel{width:auto;flex:1;border:none}
.pj-body.narrow .pj-editor{flex:1}
`;
