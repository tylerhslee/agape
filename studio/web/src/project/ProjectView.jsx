import { useState, useEffect, useMemo, useRef } from "react";
import Editor from "@monaco-editor/react";
import { registerAgape, AGAPE_LANG_ID } from "../agapeLanguage.js";
import * as project from "./projectApi.js";

// The Project studio: inspect a project's agents, edit their .ag code, and run it —
// feeding the `prompt` sensors with input and watching the spine that results.
export default function ProjectView({ info, onReview }) {
  const [sel, setSel] = useState(info.files[0]?.rel || null);
  const [src, setSrc] = useState("");
  const [dirty, setDirty] = useState(false);
  const [prompts, setPrompts] = useState({});
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState(null);
  const dirtyRef = useRef(false);

  const file = useMemo(() => info.files.find((f) => f.rel === sel), [info, sel]);

  // Load the selected file's source.
  useEffect(() => {
    if (!sel) return;
    let live = true;
    project.file(sel).then((d) => { if (live) { setSrc(d.body); setDirty(false); dirtyRef.current = false; } });
    setResult(null);
    setMsg(null);
    return () => { live = false; };
  }, [sel]);

  const save = async () => {
    try { await project.saveFile(sel, src); setDirty(false); dirtyRef.current = false; setMsg({ ok: true, t: "saved" }); }
    catch (e) { setMsg({ ok: false, t: e.message }); }
  };
  const runIt = async () => {
    setRunning(true); setMsg(null);
    try {
      if (dirtyRef.current) await project.saveFile(sel, src); // run what you see
      setResult(await project.run(sel, prompts));
      setDirty(false); dirtyRef.current = false;
    } catch (e) { setResult({ ok: false, error: e.message }); }
    setRunning(false);
  };

  return (
    <div className="pj">
      <header className="pj-top">
        <b style={{ letterSpacing: 0.3 }}>Agape</b>
        <span className="pj-badge">{info.name}</span>
        <span className="pj-dim" style={{ fontSize: 12 }} title={info.root}>{info.root}</span>
        <span style={{ flex: 1 }} />
        <button onClick={save} disabled={!sel}>{dirty ? "Save*" : "Save"}</button>
        <button className="pj-run" onClick={runIt} disabled={!sel || running}>{running ? "running…" : "▶ Run"}</button>
        {onReview && <button onClick={onReview}>Conformance →</button>}
      </header>

      <div className="pj-body">
        <aside className="pj-side">
          <div className="pj-side-h">agents &amp; files</div>
          {info.files.map((f) => (
            <div key={f.rel} className={"pj-file" + (f.rel === sel ? " on" : "")} onClick={() => setSel(f.rel)}>
              <div className="pj-fname">{f.rel}</div>
              {f.agents.map((a) => <div key={a} className="pj-agent">▸ {a}</div>)}
              {f.prompts.map((p) => <div key={p} className="pj-sensor">⌁ {p} <span className="pj-dim">(input)</span></div>)}
            </div>
          ))}
          {info.files.length === 0 && <div className="pj-dim" style={{ padding: 12 }}>no .ag files in this project</div>}
        </aside>

        <main className="pj-editor">
          {sel ? (
            <Editor height="100%" language={AGAPE_LANG_ID} theme="agape-dark" path={sel} value={src}
              onChange={(v) => { setSrc(v ?? ""); setDirty(true); dirtyRef.current = true; }} beforeMount={registerAgape}
              options={{ fontSize: 13, minimap: { enabled: false }, automaticLayout: true, scrollBeyondLastLine: false, tabSize: 2 }} />
          ) : <div className="pj-dim" style={{ margin: "auto" }}>select a file</div>}
        </main>

        <section className="pj-run-panel">
          <div className="pj-side-h">run</div>
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
              <div className="pj-dim" style={{ padding: 12 }}>▶ Run to see the spine — the append-only log of everything the agents do.</div>
            ) : result.ok ? (
              <>
                {result.events.map((e, i) => <SpineRow key={i} e={e} />)}
                <div className="pj-dim" style={{ padding: "8px 12px" }}>{result.events.length} events · {result.head?.slice(0, 16)}</div>
              </>
            ) : (
              <div className="pj-err">✗ {result.class ? result.class + ": " : ""}{result.error}</div>
            )}
          </div>
        </section>
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
  else if (/Prompt|Draft|Decided|Spawned|AgentAwake/.test(k)) cls = "ev-note";
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
.pj-top{display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid #2a3140;background:#161a22}
.pj-badge{font:600 12px ui-monospace,monospace;padding:4px 9px;border-radius:6px;background:#243049;color:#e6e9ef}
.pj button{font:inherit;cursor:pointer;border:1px solid #2a3140;background:#1d2330;color:#e6e9ef;border-radius:7px;padding:6px 12px}
.pj button.pj-run{background:#58a6ff;border-color:#58a6ff;color:#04101f;font-weight:600}
.pj button:disabled{opacity:.5;cursor:default}
.pj-dim{color:#9aa4b2}.ok{color:#3fb950}.bad{color:#f85149}
.pj-body{flex:1;display:flex;min-height:0}
.pj-side{width:240px;border-right:1px solid #2a3140;background:#13161d;overflow:auto}
.pj-side-h{font:600 11px ui-monospace,monospace;text-transform:uppercase;letter-spacing:.5px;color:#6b7588;padding:10px 12px 4px}
.pj-file{padding:7px 12px;cursor:pointer;border-bottom:1px solid #1b2230}
.pj-file:hover{background:#1d2330}.pj-file.on{background:#243049}
.pj-fname{font:600 12.5px ui-monospace,monospace}
.pj-agent{font:12px ui-monospace,monospace;color:#7ee787;padding-left:8px}
.pj-sensor{font:12px ui-monospace,monospace;color:#79c0ff;padding-left:8px}
.pj-editor{flex:1;display:flex;min-width:0}
.pj-run-panel{width:360px;border-left:1px solid #2a3140;background:#13161d;display:flex;flex-direction:column;min-height:0}
.pj-inputs{padding:6px 12px}
.pj-inp{display:flex;flex-direction:column;gap:3px;margin-bottom:8px}
.pj-inp span{font:12px ui-monospace,monospace;color:#79c0ff}
.pj-inp input{font:inherit;background:#1d2330;border:1px solid #2a3140;color:#e6e9ef;border-radius:7px;padding:6px 9px}
.pj-msg{padding:4px 12px;font-size:12.5px}
.pj-spine{flex:1;overflow:auto;border-top:1px solid #2a3140;margin-top:4px}
.pj-err{padding:12px;color:#f85149;font:12.5px ui-monospace,monospace;white-space:pre-wrap}
.ev{display:grid;grid-template-columns:30px 150px 1fr;grid-template-areas:"t k s" ". p p";gap:0 8px;padding:3px 12px;font:12px ui-monospace,monospace;border-bottom:1px solid #161b24}
.ev-t{grid-area:t;color:#48515f;text-align:right}
.ev-k{grid-area:k;font-weight:600}
.ev-s{grid-area:s;color:#9aa4b2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ev-p{grid-area:p;color:#6b7588;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ev-good .ev-k{color:#3fb950}.ev-warn .ev-k{color:#d29922}.ev-note .ev-k{color:#79c0ff}.ev-dim .ev-k{color:#6b7588}
`;
