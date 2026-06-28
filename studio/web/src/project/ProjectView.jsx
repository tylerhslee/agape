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

// Monaco options tuned to read like a real IDE: minimap, indent + bracket-pair
// guides, bracket-pair colorization, sticky scroll, a smooth caret, and ligatures.
const EDITOR_OPTIONS = {
  fontSize: 13.5,
  fontFamily: '"Cascadia Code", "JetBrains Mono", "Fira Code", Menlo, Consolas, monospace',
  fontLigatures: true,
  minimap: { enabled: true, renderCharacters: false, maxColumn: 70 },
  automaticLayout: true,
  scrollBeyondLastLine: false,
  tabSize: 2,
  renderLineHighlight: "all",
  cursorBlinking: "smooth",
  cursorSmoothCaretAnimation: "on",
  smoothScrolling: true,
  roundedSelection: true,
  padding: { top: 10, bottom: 10 },
  bracketPairColorization: { enabled: true },
  guides: { indentation: true, bracketPairs: "active" },
  stickyScroll: { enabled: true },
  scrollbar: { verticalScrollbarSize: 11, horizontalScrollbarSize: 11 },
  lineNumbersMinChars: 3,
  overviewRulerLanes: 2,
};

// The Project studio: inspect a project's agents, edit their .ag code, and run it —
// feeding the `prompt` sensors with input and watching the spine that results.
// Desktop shows the three panels side-by-side; phone shows one at a time.
export default function ProjectView({ info, provider, editorPrefs, setEditorPrefs, onOpenSettings }) {
  const [sel, setSel] = useState(info.files[0]?.rel || null);
  const [src, setSrc] = useState("");
  const [dirty, setDirty] = useState(false);
  const [prompts, setPrompts] = useState({});
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState(null);
  // The cognition provider is studio-level config (Studio -> Settings); this view
  // only consumes it.
  const { claude, samples, temp } = provider;
  const vim = !!editorPrefs?.vim;
  const dirtyRef = useRef(false);
  const edRef = useRef(null);          // the Monaco editor instance
  const vimRef = useRef(null);         // active vim-mode disposable, or null
  const vimStatusRef = useRef(null);   // status-bar node vim writes its mode into
  const saveRef = useRef(null);        // freshest save(), for the :w ex-command
  const [pos, setPos] = useState({ line: 1, col: 1 });
  const [edReady, setEdReady] = useState(false);
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

  // The conversation: what was asked, and the verified answer the system delivered.
  // The "answer" is the payload of the last `perform`ed action (e.g. Reply) — an
  // action only fires when its gate commits, so its presence means "verified".
  const convo = useMemo(() => {
    if (!result || !result.ok) return null;
    const actions = [...(src || "").matchAll(/^\s*action\s+([A-Za-z_]\w*)/gm)].map((m) => m[1]);
    const acts = result.events.filter((e) => actions.includes(e.etype));
    const answer = acts.length ? acts[acts.length - 1] : null;
    const abstained = result.events.some((e) => e.etype === "Abstained");
    const rejected = !answer && result.events.some((e) => /reject/i.test(e.payload || ""));
    return { asked: result.asked || {}, answer, abstained, rejected };
  }, [result, src]);

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
      const r = await project.run(sel, prompts, { claude, samples, temperature: temp });
      setResult({ ...r, claude, asked: { ...prompts } }); // remember provider + what was asked
      setDirty(false); dirtyRef.current = false;
    } catch (e) { setResult({ ok: false, error: e.message }); }
    setRunning(false);
  };

  // Keep the Vim :w command bound to the freshest save().
  saveRef.current = save;

  const onEditorMount = (ed) => {
    edRef.current = ed;
    ed.onDidChangeCursorPosition((e) => setPos({ line: e.position.lineNumber, col: e.position.column }));
    setEdReady(true);
  };

  // Attach / detach Vim mode as the preference toggles (lazy-loaded on first use).
  useEffect(() => {
    if (!edRef.current) return undefined;
    let cancelled = false;
    if (vim && !vimRef.current) {
      import("monaco-vim").then(({ initVimMode, VimMode }) => {
        if (cancelled || vimRef.current || !edRef.current) return;
        vimRef.current = initVimMode(edRef.current, vimStatusRef.current);
        VimMode.Vim.defineEx("write", "w", () => saveRef.current && saveRef.current());
      });
    } else if (!vim && vimRef.current) {
      vimRef.current.dispose();
      vimRef.current = null;
    }
    return () => { cancelled = true; };
  }, [vim, edReady]);

  useEffect(() => () => { if (vimRef.current) { vimRef.current.dispose(); vimRef.current = null; } }, []);

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
        <>
          <div className="pj-ed-bar">
            <span className="pj-ed-tab">
              <i className="ti ti-file-code" />
              {sel.split("/").pop()}
              {dirty && <i className="pj-ed-dot" title="unsaved changes" />}
            </span>
            <span className="pj-ed-crumbs">{[info.name, ...sel.split("/")].join("  ›  ")}</span>
          </div>
          <div className="pj-ed-wrap">
            <Editor height="100%" language={AGAPE_LANG_ID} theme="agape-dark" path={sel} value={src}
              onChange={(v) => { setSrc(v ?? ""); setDirty(true); dirtyRef.current = true; }}
              beforeMount={registerAgape} onMount={onEditorMount} options={EDITOR_OPTIONS} />
          </div>
          <div className="pj-ed-status">
            <span className="pj-st"><i className="ti ti-letter-a" /> Agape</span>
            <span className="pj-st">Ln {pos.line}, Col {pos.col}</span>
            <span className="pj-st">Spaces: 2</span>
            <span className="pj-st-vim" ref={vimStatusRef} />
            <button
              className={"pj-st-btn" + (vim ? " on" : "")}
              onClick={() => setEditorPrefs((p) => ({ ...p, vim: !p.vim }))}
              title="Toggle Vim mode"
            >
              <i className="ti ti-keyboard" />{vim ? "VIM" : "vim"}
            </button>
            <span className="pj-st">UTF-8</span>
          </div>
        </>
      ) : <div className="pj-dim" style={{ margin: "auto" }}>select a file</div>}
    </main>
  );

  const runPanel = (
    <section className="pj-run-panel">
      <div className="pj-side-h">run · {claude ? "🧠 live Claude" : "deterministic mock"}</div>
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
            <div className="pj-qa">
              {Object.entries(convo.asked).filter(([, v]) => v).map(([k, v]) => (
                <div key={k} className="pj-msg-row"><span className="pj-who you">you</span><span className="pj-bubble">{v}</span></div>
              ))}
              {convo.answer ? (
                <div className="pj-msg-row">
                  <span className="pj-who agape">agape</span>
                  <span className="pj-bubble"><span className="pj-verified">✓ verified</span>{convo.answer.payload}</span>
                </div>
              ) : (
                <div className="pj-msg-row">
                  <span className="pj-who warn">agape</span>
                  <span className="pj-bubble pj-dim">{convo.abstained ? "abstained — the gate couldn't commit, no answer delivered" : convo.rejected ? "rejected — the answer failed fact-check, not delivered" : "no answer delivered"}</span>
                </div>
              )}
            </div>

            <div className="pj-section-h">under the hood</div>
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
        <span className="pj-provider" title="Cognition provider — change in Studio → Settings">
          <i className="ti ti-cpu" />
          {claude ? `live Claude · ${samples} draw${samples === 1 ? "" : "s"}${temp > 0 ? ` · temp ${temp}` : ""}` : "deterministic mock"}
          {onOpenSettings && <button className="pj-link" onClick={onOpenSettings}>settings</button>}
        </span>
        <span style={{ flex: 1 }} />
        <button onClick={save} disabled={!sel}>{dirty ? "Save*" : "Save"}</button>
        <button className="pj-run" onClick={runIt} disabled={!sel || running}>{running ? "running…" : "▶ Run"}</button>
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
.pj{display:flex;flex-direction:column;flex:1;min-height:0;background:var(--bg);color:var(--text);font:14px/1.5 var(--sans)}
.pj code{font:12px var(--mono);color:var(--muted)}
.pj-top{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--border-soft);background:var(--surface);flex-wrap:wrap}
.pj-badge{font:600 12px var(--mono);padding:4px 9px;border-radius:var(--radius-sm);background:var(--accent-soft);color:var(--accent)}
.pj-path{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:40vw}
.pj button{font:inherit;cursor:pointer;border:1px solid var(--border);background:var(--surface-2);color:var(--text);border-radius:var(--radius-sm);padding:6px 12px}
.pj button:hover{background:var(--surface-3)}
.pj button.pj-run{background:var(--accent);border-color:var(--accent);color:var(--accent-ink);font-weight:600}
.pj button.pj-run:hover{background:#6cb3ff}
.pj button:disabled{opacity:.5;cursor:default}
.pj-dim{color:var(--muted)}.ok{color:var(--ok)}.bad{color:var(--err)}
.pj-provider{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted)}
.pj-provider i{font-size:14px;color:var(--type)}
.pj button.pj-link{background:none;border:none;color:var(--accent);padding:0;margin-left:4px;font-size:12px;text-decoration:underline}
.pj button.pj-link:hover{background:none;color:#6cb3ff}
/* mobile segmented switcher */
.pj-seg{display:flex;gap:6px;padding:8px 12px;border-bottom:1px solid var(--border-soft);background:var(--surface)}
.pj-seg button{flex:1;font:inherit;cursor:pointer;border:1px solid var(--border);background:var(--surface-2);color:var(--muted);border-radius:var(--radius-sm);padding:9px}
.pj-seg button.on{background:var(--surface-3);color:var(--text);border-color:var(--border)}
.pj-body{flex:1;display:flex;min-height:0}
.pj-body.narrow{flex-direction:column}
.pj-side{width:240px;border-right:1px solid var(--border-soft);background:var(--surface);overflow:auto}
.pj-side-h{font:600 11px var(--mono);text-transform:uppercase;letter-spacing:.5px;color:var(--faint);padding:10px 12px 4px}
.pj-file{padding:7px 12px;cursor:pointer;border-bottom:1px solid var(--border-soft)}
.pj-file:hover{background:var(--surface-2)}.pj-file.on{background:var(--accent-soft)}
.pj-fname{font:600 12.5px var(--mono)}
.pj-agent{font:12px var(--mono);color:var(--ok);padding-left:8px}
.pj-sensor{font:12px var(--mono);color:var(--accent);padding-left:8px}
.pj-editor{flex:1;display:flex;flex-direction:column;min-width:0}
.pj-ed-bar{display:flex;align-items:flex-end;gap:12px;height:36px;padding:0 12px;background:var(--surface);border-bottom:1px solid var(--border-soft);flex:none}
.pj-ed-tab{display:flex;align-items:center;gap:7px;height:36px;padding:0 13px;font-size:12.5px;color:var(--text);background:var(--bg);border:1px solid var(--border-soft);border-bottom-color:var(--bg);border-radius:6px 6px 0 0;margin-bottom:-1px}
.pj-ed-tab i.ti{font-size:14px;color:var(--accent)}
.pj-ed-dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--warn)}
.pj-ed-crumbs{font-size:11.5px;color:var(--faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding-bottom:9px}
.pj-ed-wrap{flex:1;min-height:0}
.pj-ed-status{display:flex;align-items:center;gap:14px;height:26px;padding:0 12px;background:var(--surface);border-top:1px solid var(--border-soft);font-size:11px;color:var(--muted);flex:none}
.pj-st{display:flex;align-items:center;gap:4px}
.pj-st i.ti{font-size:13px}
.pj-st-vim{flex:1;min-width:0;font:11px var(--mono);color:var(--accent);overflow:hidden;white-space:nowrap}
.pj button.pj-st-btn{display:flex;align-items:center;gap:4px;background:none;border:none;color:var(--muted);padding:1px 7px;border-radius:4px;font-size:10.5px;text-transform:uppercase;letter-spacing:.04em}
.pj button.pj-st-btn:hover{background:var(--surface-3);color:var(--text)}
.pj button.pj-st-btn.on,.pj button.pj-st-btn.on i{color:var(--accent)}
.pj-run-panel{width:360px;border-left:1px solid var(--border-soft);background:var(--surface);display:flex;flex-direction:column;min-height:0}
.pj-toggle{display:flex;align-items:center;gap:5px;font-size:12px;color:var(--muted);cursor:pointer;user-select:none}
.pj-toggle input{cursor:pointer;accent-color:var(--warn)}
.pj-toggle-hdr{border:1px solid var(--border);border-radius:var(--radius-sm);padding:5px 10px;background:var(--surface-2)}
.pj-toggle-hdr.on{border-color:var(--warn);color:var(--text);background:rgba(210,153,34,.12)}
.pj-cfg{display:flex;align-items:center;gap:12px;padding:2px 12px 6px;flex-wrap:wrap}
.pj-cfg label{display:flex;align-items:center;gap:5px;font-size:12px;color:var(--muted)}
.pj-cfg input{width:52px;font:inherit;background:var(--surface-2);border:1px solid var(--border);color:var(--text);border-radius:var(--radius-sm);padding:3px 6px}
.pj-inputs{padding:6px 12px}
.pj-inp{display:flex;flex-direction:column;gap:3px;margin-bottom:8px}
.pj-inp span{font:12px var(--mono);color:var(--accent)}
.pj-inp input{font:inherit;background:var(--surface-2);border:1px solid var(--border);color:var(--text);border-radius:var(--radius-sm);padding:6px 9px}
.pj-msg{padding:4px 12px;font-size:12.5px}
.pj-spine{flex:1;overflow:auto;border-top:1px solid var(--border-soft);margin-top:4px}
.pj-qa{display:flex;flex-direction:column;gap:8px;padding:12px}
.pj-msg-row{display:flex;gap:8px;align-items:flex-start}
.pj-who{flex:none;width:46px;font:600 10px var(--mono);text-transform:uppercase;letter-spacing:.3px;padding-top:6px}
.pj-who.you{color:var(--accent)}.pj-who.agape{color:var(--ok)}.pj-who.warn{color:var(--warn)}
.pj-bubble{flex:1;background:var(--surface-2);border:1px solid var(--border);border-radius:10px;padding:8px 11px;font-size:13px;line-height:1.5;white-space:pre-wrap;word-break:break-word}
.pj-verified{display:inline-block;font:600 10px var(--mono);color:var(--ok);background:rgba(63,185,80,.14);border-radius:5px;padding:1px 6px;margin-right:7px;vertical-align:1px}
.pj-metrics{display:flex;gap:8px;padding:10px 12px 4px}
.pj-metric{flex:1;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);padding:7px 6px;text-align:center;display:flex;flex-direction:column;gap:1px}
.pj-metric b{font:600 15px var(--mono);color:var(--text)}
.pj-metric span{font-size:10.5px;color:var(--faint);text-transform:uppercase;letter-spacing:.3px}
.pj-metric-note{font-size:11px;color:var(--faint);padding:0 12px 2px}
.pj-section-h{font:600 11px var(--mono);text-transform:uppercase;letter-spacing:.5px;color:var(--faint);padding:10px 12px 4px}
.pj-call{margin:0 12px 8px;border:1px solid var(--border-soft);border-radius:var(--radius-sm);overflow:hidden}
.pj-io{display:flex;gap:8px;padding:6px 9px;font:12px/1.45 var(--mono)}
.pj-io+.pj-io{border-top:1px solid var(--border-soft);background:var(--bg)}
.pj-io-tag{flex:none;font:600 10px var(--mono);padding:1px 6px;border-radius:5px;height:fit-content;text-transform:uppercase}
.pj-io-tag.in{background:var(--accent-soft);color:var(--accent)}.pj-io-tag.out{background:rgba(63,185,80,.14);color:var(--ok)}
.pj-io-txt{white-space:pre-wrap;word-break:break-word;color:var(--text)}
.pj-err{padding:12px;color:var(--err);font:12.5px var(--mono);white-space:pre-wrap}
.ev{display:grid;grid-template-columns:30px 150px 1fr;grid-template-areas:"t k s" ". p p";gap:0 8px;padding:3px 12px;font:12px var(--mono);border-bottom:1px solid var(--border-soft)}
.ev-t{grid-area:t;color:var(--faint);text-align:right}
.ev-k{grid-area:k;font-weight:600}
.ev-s{grid-area:s;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ev-p{grid-area:p;color:var(--faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ev-good .ev-k{color:var(--ok)}.ev-warn .ev-k{color:var(--warn)}.ev-note .ev-k{color:var(--accent)}.ev-dim .ev-k{color:var(--faint)}
/* phone: each visible pane fills the screen so the editor is readable */
.pj-body.narrow .pj-side,.pj-body.narrow .pj-run-panel{width:auto;flex:1;border:none}
.pj-body.narrow .pj-editor{flex:1}
`;
