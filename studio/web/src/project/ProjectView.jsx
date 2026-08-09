import { useState, useEffect, useMemo, useRef } from "react";
import Editor from "@monaco-editor/react";
import { registerAgape, AGAPE_LANG_ID } from "../agapeLanguage.js";
import * as project from "./projectApi.js";
import RuntimeRunView from "./RuntimeRunView.jsx";
import { runtimeSessions } from "./runtimeSessionClient.js";

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
  padding: { top: 8, bottom: 8 },
  bracketPairColorization: { enabled: true },
  guides: { indentation: true, bracketPairs: "active" },
  stickyScroll: { enabled: true },
  scrollbar: { verticalScrollbarSize: 11, horizontalScrollbarSize: 11, horizontal: "auto" },
  lineNumbersMinChars: 3,
  overviewRulerLanes: 2,
  wordWrap: "off", // toggled live via editor prefs
};

// The Project workspace. The active rail icon (`panel`) chooses the left side
// panel — "explorer" (file tree) or "run" (run inputs + output) — and the editor
// fills the rest with no top chrome; a full-width status bar carries the actions
// and position, the way a real IDE does.
export default function ProjectView({ info, provider, editorPrefs, setEditorPrefs, onOpenSettings, onShowRun, panel = "explorer" }) {
  const [sel, setSel] = useState(info.files[0]?.rel || null);
  const [src, setSrc] = useState("");
  const [dirty, setDirty] = useState(false);
  const [prompts, setPrompts] = useState({});
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState(null);
  const [rulingBusy, setRulingBusy] = useState(false);
  const [rulingError, setRulingError] = useState(null);
  const [evidenceState, setEvidenceState] = useState({});
  // Provider config is studio-level (Studio -> Settings); consumed here.
  const {
    cognitionProvider = "mock",
    samples = 5,
    temp = 0,
    openaiTopLogprobs = 5,
  } = provider;
  const srcRef = useRef("");          // synchronously tracks Monaco edits for save/run commands
  const judgeProvider = judgeProviderForCognition(cognitionProvider);
  const liveProvider = cognitionProvider !== "mock";
  const vim = !!editorPrefs?.vim;
  const dirtyRef = useRef(false);
  const edRef = useRef(null);          // the Monaco editor instance
  const vimRef = useRef(null);         // active vim-mode disposable, or null
  const vimStatusRef = useRef(null);   // status-bar node vim writes its mode into
  const saveRef = useRef(null);        // freshest save(), for :w and Ctrl+S
  const closeRef = useRef(null);       // freshest close(), for :q
  const [pos, setPos] = useState({ line: 1, col: 1 });
  const [edReady, setEdReady] = useState(false);
  const wrap = !!editorPrefs?.wrap;
  const [sideOpen, setSideOpen] = useState(true);

  const file = useMemo(() => info.files.find((f) => f.rel === sel), [info, sel]);

  // Pair each Sent→Resolved (by correlation id) into one provider/LLM call, and
  // estimate usage. Token counts are ~chars/4; cost uses Haiku-class rates. These
  // are ESTIMATES off the deterministic mock — a live connector makes them real.
  const run = useMemo(() => {
    if (!result || !result.ok) return null;
    const sent = {}; const calls = [];
    for (const e of result.events) {
      if (e.etype === "Sent" && e.corr != null) sent[e.corr] = fmtPayload(e.payload);
      else if (e.etype === "Resolved" && e.corr != null && sent[e.corr] != null) {
        calls.push({ input: sent[e.corr], output: fmtPayload(e.payload) });
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
    project.file(sel).then((d) => { if (live) { srcRef.current = d.body; setSrc(d.body); setDirty(false); dirtyRef.current = false; } });
    setResult(null);
    setMsg(null);
    setRulingError(null);
    setEvidenceState({});
    return () => { live = false; };
  }, [sel]);

  const pickFile = (rel) => setSel(rel);
  const save = async () => {
    if (!sel) return;
    try {
      if (dirtyRef.current) {
        await runtimeSessions.reset(info.root || info.name, sel);
      }
      const source = srcRef.current;
      await project.saveFile(sel, source);
      if (srcRef.current === source) { setDirty(false); dirtyRef.current = false; setMsg({ ok: true, t: "saved" }); }
      else setMsg({ ok: true, t: "saved previous edit; newer changes remain" });
    }
    catch (e) { setMsg({ ok: false, t: e.message }); }
  };
  const runIt = async () => {
    if (!sel) return;
    onShowRun?.();           // reveal the run panel (Run space) for the output
    setRunning(true); setMsg(null);
    let runSource = srcRef.current;
    try {
      if (dirtyRef.current) {
        await runtimeSessions.reset(info.root || info.name, sel);
        runSource = srcRef.current;
        await project.saveFile(sel, runSource);
      }
      const entries = Object.entries(prompts).filter(([, value]) => value !== "");
      let view;
      if (entries.length === 0) {
        ({ view } = await runtimeSessions.session(info.root || info.name, sel));
      } else {
        for (const [name, value] of entries) {
          view = await runtimeSessions.sendPrompt(info.root || info.name, sel, { name, value });
          if (view.state === "pending-ruling") break;
        }
      }
      setResult({
        ok: true,
        events: view.ledger,
        head: view.ledgerHead,
        stdout: view.stdout,
        certificates: view.certificates,
        runtimeView: view,
        provider: { cognitionProvider, judgeProvider, samples, temp, openaiTopLogprobs },
        asked: { ...prompts },
      });
      if (srcRef.current === runSource) { setDirty(false); dirtyRef.current = false; }
      setRulingError(null);
    } catch (e) { setResult({ ok: false, error: e.message, class: e.code }); }
    setRunning(false);
  };

  const rule = async (outcome, decision) => {
    const view = result?.runtimeView;
    if (!sel || !view?.pending) return;
    setRulingBusy(true);
    setRulingError(null);
    try {
      const next = await runtimeSessions.rule(info.root || info.name, sel, view.pending, outcome, decision);
      setResult((current) => ({
        ...current,
        events: next.ledger,
        head: next.ledgerHead,
        stdout: next.stdout,
        certificates: next.certificates,
        runtimeView: next,
      }));
    } catch (error) {
      setRulingError({ message: error.message, code: error.code });
    } finally {
      setRulingBusy(false);
    }
  };

  const inspectEvidence = async ({ decisionId, evidenceRef }) => {
    if (!sel) return;
    const key = `${decisionId}:${evidenceRef}`;
    setEvidenceState((current) => ({ ...current, [key]: { loading: true } }));
    try {
      const evidence = await runtimeSessions.inspectEvidence(info.root || info.name, sel, evidenceRef, decisionId);
      setEvidenceState((current) => ({ ...current, [key]: { evidence } }));
    } catch (error) {
      setEvidenceState((current) => ({ ...current, [key]: { error: { message: error.message, code: error.code } } }));
    }
  };

  // Keep the Vim ex-commands bound to the freshest closures.
  saveRef.current = save;
  closeRef.current = () => setSel(null); // :q -> no file open

  const disposeVim = () => { try { vimRef.current?.dispose(); } catch { /* editor already gone */ } vimRef.current = null; };

  const onEditorMount = (ed, monaco) => {
    edRef.current = ed;
    ed.onDidChangeCursorPosition((e) => setPos({ line: e.position.lineNumber, col: e.position.column }));
    // Ctrl/Cmd+S saves — works whether or not Vim mode is on.
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current?.());
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
        const V = VimMode.Vim;
        V.defineEx("write", "w", () => saveRef.current?.());
        V.defineEx("quit", "q", () => closeRef.current?.());                            // :q / :q!
        V.defineEx("wq", "wq", () => { saveRef.current?.(); closeRef.current?.(); });   // :wq
        V.defineEx("xit", "x", () => { saveRef.current?.(); closeRef.current?.(); });   // :x
      });
    } else if (!vim && vimRef.current) {
      disposeVim();
    }
    return () => { cancelled = true; };
  }, [vim, edReady]);

  // When the file closes (e.g. Vim :q), tear down the editor-bound vim instance so
  // it re-attaches cleanly to the next file that's opened.
  useEffect(() => {
    if (!sel) { disposeVim(); edRef.current = null; setEdReady(false); }
  }, [sel]);

  useEffect(() => () => disposeVim(), []);

  // Word wrap is a live Monaco option — flip it without recreating the editor.
  useEffect(() => { edRef.current?.updateOptions({ wordWrap: wrap ? "on" : "off" }); }, [wrap, edReady]);

  const filesPanel = (
    <aside className="pj-side">
      <div className="pj-side-h">explorer</div>
      {info.files.map((f) => (
        <div key={f.rel} className={"pj-file" + (f.rel === sel ? " on" : "")} onClick={() => pickFile(f.rel)}>
          <div className="pj-fname"><i className="ti ti-file-code" /> {f.rel}</div>
          {f.agents.map((a) => <div key={a} className="pj-agent">▸ {a}</div>)}
          {f.prompts.map((p) => <div key={p} className="pj-sensor">⌁ {p} <span className="pj-dim">(input)</span></div>)}
        </div>
      ))}
      {info.files.length === 0 && <div className="pj-dim" style={{ padding: 12 }}>no .ag files in this project</div>}
    </aside>
  );

  const runPanel = (
    <section className="pj-run-panel">
      <div className="pj-side-h">
        run · {sel ? sel.split("/").pop() : "no file"}
        <button className="pj-run-btn" onClick={runIt} disabled={!sel || running}>
          <i className="ti ti-player-play-filled" />{running ? "…" : "Run"}
        </button>
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

      <div className="pj-spine">
        {!result ? (
          <div className="pj-dim" style={{ padding: 12 }}>▶ Run to see the LLM calls, cost, and the ledger - the append-only log of everything the agents do.</div>
        ) : result.ok ? (
          <>
            <RuntimeRunView
              view={result.runtimeView}
              asked={result.asked}
              rulingBusy={rulingBusy}
              rulingError={rulingError}
              onRule={rule}
              evidenceState={evidenceState}
              onInspectEvidence={inspectEvidence}
              SpineRow={SpineRow}
            />

            <div className="pj-section-h">under the hood</div>
            <div className="pj-metrics">
              <div className="pj-metric"><b>{run.calls.length}</b><span>LLM calls</span></div>
              <div className="pj-metric"><b>{run.tokIn}</b><span>tok in</span></div>
              <div className="pj-metric"><b>{run.tokOut}</b><span>tok out</span></div>
              <div className="pj-metric"><b>~${run.cost < 0.001 ? run.cost.toFixed(5) : run.cost.toFixed(3)}</b><span>est. cost</span></div>
            </div>
            <div className="pj-metric-note">{providerRunLabel(result.provider)}</div>

            <div className="pj-section-h">llm calls</div>
            {run.calls.length === 0 && <div className="pj-dim" style={{ padding: "0 12px 8px" }}>no provider calls this run</div>}
            {run.calls.map((c, i) => (
              <div key={i} className="pj-call">
                <div className="pj-io"><span className="pj-io-tag in">in</span><span className="pj-io-txt">{c.input}</span></div>
                <div className="pj-io"><span className="pj-io-tag out">out</span><span className="pj-io-txt">{c.output}</span></div>
              </div>
            ))}

          </>
        ) : (
          <div className="pj-err">✗ {result.class ? result.class + ": " : ""}{result.error}</div>
        )}
      </div>
    </section>
  );

  return (
    <div className="pj">
      <div className="pj-body">
        {sideOpen && (panel === "run" ? runPanel : filesPanel)}
        <main className="pj-editor">
          {sel ? (
            <Editor height="100%" language={AGAPE_LANG_ID} theme="agape-dark" path={sel} value={src}
              onChange={(v) => { const next = v ?? ""; srcRef.current = next; setSrc(next); setDirty(true); dirtyRef.current = true; }}
              beforeMount={registerAgape} onMount={onEditorMount} options={EDITOR_OPTIONS} />
          ) : (
            <div className="pj-empty">
              <i className="ti ti-file-off" />
              <div>No file open</div>
              <div className="pj-dim">Pick a file from the explorer to start editing.</div>
            </div>
          )}
        </main>
      </div>

      <footer className="pj-status">
        <button className="pj-st-toggle" onClick={() => setSideOpen((o) => !o)}
          title={sideOpen ? "Hide side panel" : "Show side panel"}>
          <i className={"ti " + (sideOpen ? "ti-layout-sidebar-left-collapse" : "ti-layout-sidebar-left-expand")} />
        </button>
        {sel ? (
          <>
            <span className="pj-st-file"><i className="ti ti-file-code" />{sel.split("/").pop()}{dirty && <i className="pj-dot" title="unsaved changes" />}</span>
            <button className="pj-st-run" onClick={runIt} disabled={running} title="Run (saves first)">
              <i className="ti ti-player-play-filled" />{running ? "running…" : "Run"}
            </button>
            <button className="pj-st-save" onClick={save} disabled={!dirty} title="Save  (Ctrl/Cmd+S)">
              <i className="ti ti-device-floppy" />{dirty ? "Save" : "Saved"}
            </button>
            <span className="pj-st-provider" onClick={onOpenSettings} title="Cognition provider — Studio → Settings">
              <i className="ti ti-cpu" />{providerStatusLabel({ cognitionProvider, judgeProvider, samples, temp, openaiTopLogprobs })}
            </span>
            <span className="pj-st-grow" ref={vimStatusRef} />
            {msg && <span className={msg.ok ? "ok" : "bad"}>{msg.t}</span>}
            <span className="pj-st-i">Ln {pos.line}, Col {pos.col}</span>
            <span className="pj-st-i">Spaces: 2</span>
            <span className="pj-st-i"><i className="ti ti-letter-a" />Agape</span>
            <button className={"pj-st-tog" + (wrap ? " on" : "")} onClick={() => setEditorPrefs((p) => ({ ...p, wrap: !p.wrap }))}
              title="Toggle word wrap">
              <i className="ti ti-text-wrap" />wrap
            </button>
            <button className={"pj-st-tog" + (vim ? " on" : "")} onClick={() => setEditorPrefs((p) => ({ ...p, vim: !p.vim }))}
              title="Toggle Vim mode">
              <i className="ti ti-keyboard" />{vim ? "VIM" : "vim"}
            </button>
          </>
        ) : (
          <>
            <span className="pj-st-i pj-dim">no file open</span>
            <span className="pj-st-grow" ref={vimStatusRef} />
            <button className={"pj-st-tog" + (wrap ? " on" : "")} onClick={() => setEditorPrefs((p) => ({ ...p, wrap: !p.wrap }))}
              title="Toggle word wrap">
              <i className="ti ti-text-wrap" />wrap
            </button>
          </>
        )}
      </footer>
      <style>{STYLE}</style>
    </div>
  );
}

function providerStatusLabel({ cognitionProvider, samples, temp, openaiTopLogprobs }) {
  const cognition = cognitionProvider === "openai" ? "OpenAI" : cognitionProvider === "anthropic" ? "Claude" : "mock";
  if (cognition === "mock") return "mock";
  const credence = cognitionProvider === "openai"
    ? `Credence via logprobs ${openaiTopLogprobs || 5}`
    : `Credence via sampling ${samples || 5}x${temp > 0 ? ` · ${temp}` : ""}`;
  return `${cognition} · ${credence}`;
}

function providerRunLabel(provider) {
  if (!provider || provider.cognitionProvider === "mock") return "estimated · deterministic mock provider (no live connector)";
  const cognition = provider.cognitionProvider === "openai" ? "live OpenAI" : "live Claude";
  const credence = provider.cognitionProvider === "openai"
    ? `credence via token logprobs · top ${provider.openaiTopLogprobs || 5}`
    : `credence via sampling fallback · ${provider.samples || 5} draws`;
  return `${cognition} · ${credence} · tokens estimated from text`;
}

function judgeProviderForCognition(cognitionProvider) {
  return cognitionProvider === "openai" ? "openai" : "anthropic";
}

// Ledger event payloads are structured objects (tainted values carry `rendered`,
// sends carry {to, prompt}, resolutions carry {reply}, …). Flatten to readable
// text before anything reaches the DOM — objects as React children crash the panel.
function fmtPayload(p) {
  if (p == null) return "";
  if (typeof p === "string") return p;
  if (Array.isArray(p)) return p.map(fmtPayload).join(", ");
  if (typeof p === "object") {
    if (typeof p.rendered === "string") return p.rendered;
    if (p.value !== undefined) return fmtPayload(p.value);
    if (p.input !== undefined) return fmtPayload(p.input);
    if (p.reply !== undefined) return fmtPayload(p.reply);
    if (typeof p.prompt === "string") return p.prompt;
    try { return JSON.stringify(p); } catch { return String(p); }
  }
  return String(p);
}

// Color the ledger by what each event means: decisions/deliveries are the points
// that matter; the send chain is dim scaffolding.
function SpineRow({ e }) {
  const k = e.etype;
  let cls = "ev-dim";
  if (/Decided|Reply|Attestation|Internalized/.test(k)) cls = "ev-good";
  else if (/Abstained|Failed|Error|Contradiction|TypeMismatch|RetryExhausted|Crashed|Expired|rejected/.test(k) || k === "Event") cls = "ev-warn";
  else if (/Prompt|Draft|Spawned|AgentAwake/.test(k)) cls = "ev-note";
  const pay = fmtPayload(e.payload);
  return (
    <div className={"ev " + cls}>
      <span className="ev-t">{e.tick}</span>
      <span className="ev-k">{e.etype}</span>
      <span className="ev-s">{e.subject || ""}</span>
      <span className="ev-p">{pay && pay !== e.subject ? pay : ""}</span>
    </div>
  );
}

const STYLE = `
.pj{display:flex;flex-direction:column;flex:1;min-height:0;background:var(--bg);color:var(--text);font:14px/1.5 var(--sans)}
.pj code{font:12px var(--mono);color:var(--muted)}
.pj button{font:inherit;cursor:pointer;border:1px solid var(--border);background:var(--surface-2);color:var(--text);border-radius:var(--radius-sm);padding:6px 12px}
.pj button:hover{background:var(--surface-3)}
.pj button:disabled{opacity:.5;cursor:default}
.pj-dim{color:var(--muted)}.ok{color:var(--ok)}.bad{color:var(--err)}
.pj-body{flex:1;display:flex;min-height:0}
/* left side panels — explorer (files) or run (inputs + output) */
.pj-side{width:190px;flex:none;border-right:1px solid var(--border-soft);background:var(--surface);overflow:auto}
.pj-run-panel{width:360px;flex:none;border-right:1px solid var(--border-soft);background:var(--surface);display:flex;flex-direction:column;min-height:0}
.pj-side-h{display:flex;align-items:center;gap:8px;font:600 11px var(--mono);text-transform:uppercase;letter-spacing:.5px;color:var(--faint);padding:9px 12px 6px}
.pj-file{padding:7px 12px;cursor:pointer;border-bottom:1px solid var(--border-soft)}
.pj-file:hover{background:var(--surface-2)}.pj-file.on{background:var(--accent-soft)}
.pj-fname{display:flex;align-items:center;gap:6px;font:600 12.5px var(--mono)}
.pj-fname i.ti{color:var(--accent);font-size:14px}
.pj-agent{font:12px var(--mono);color:var(--ok);padding-left:8px}
.pj-sensor{font:12px var(--mono);color:var(--accent);padding-left:8px}
.pj button.pj-run-btn{margin-left:auto;display:flex;align-items:center;gap:4px;background:var(--accent);border-color:var(--accent);color:var(--accent-ink);font-weight:600;padding:3px 10px;font-size:11px}
.pj button.pj-run-btn:hover{background:#6cb3ff}
/* editor — no top chrome, fills the pane */
.pj-editor{flex:1;min-width:0;display:flex;flex-direction:column}
.pj-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;color:var(--muted)}
.pj-empty i{font-size:34px;color:var(--faint)}
/* full-width status bar — carries the actions + position */
.pj-status{flex:none;display:flex;align-items:center;gap:12px;height:28px;padding:0 10px;background:var(--surface);border-top:1px solid var(--border-soft);font-size:11px;color:var(--muted)}
.pj-st-file{display:flex;align-items:center;gap:6px;color:var(--text)}
.pj-st-file i.ti{font-size:13px;color:var(--accent)}
.pj-dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--warn)}
.pj button.pj-st-run{display:flex;align-items:center;gap:4px;background:none;border:none;color:var(--ok);padding:2px 7px;border-radius:4px;font-size:11px}
.pj button.pj-st-run:hover{background:var(--surface-3)}
.pj button.pj-st-save{display:flex;align-items:center;gap:4px;background:none;border:none;color:var(--muted);padding:2px 7px;border-radius:4px;font-size:11px}
.pj button.pj-st-save:hover{background:var(--surface-3);color:var(--text)}
.pj button.pj-st-save:disabled{opacity:1;color:var(--faint)}
.pj-st-provider{display:flex;align-items:center;gap:4px;cursor:pointer}
.pj-st-provider i.ti{font-size:13px;color:var(--type)}
.pj-st-provider:hover{color:var(--text)}
.pj-st-grow{flex:1;min-width:0;font:11px var(--mono);color:var(--accent);overflow:hidden;white-space:nowrap;padding-left:4px}
.pj-st-i{display:flex;align-items:center;gap:4px}
.pj-st-i i.ti{font-size:13px}
.pj button.pj-st-tog{display:flex;align-items:center;gap:4px;background:none;border:none;color:var(--muted);padding:2px 7px;border-radius:4px;font-size:10.5px;text-transform:uppercase;letter-spacing:.04em}
.pj button.pj-st-tog:hover{background:var(--surface-3);color:var(--text)}
.pj button.pj-st-tog.on,.pj button.pj-st-tog.on i{color:var(--accent)}
.pj button.pj-st-toggle{display:flex;align-items:center;background:none;border:none;color:var(--muted);padding:2px 5px;border-radius:4px}
.pj button.pj-st-toggle:hover{background:var(--surface-3);color:var(--text)}
.pj button.pj-st-toggle i.ti{font-size:15px}
/* run panel body */
.pj-inputs{padding:6px 12px}
.pj-inp{display:flex;flex-direction:column;gap:3px;margin-bottom:8px}
.pj-inp span{font:12px var(--mono);color:var(--accent)}
.pj-inp input{font:inherit;background:var(--surface-2);border:1px solid var(--border);color:var(--text);border-radius:var(--radius-sm);padding:6px 9px}
.pj-spine{flex:1;overflow:auto;border-top:1px solid var(--border-soft);margin-top:4px}
.pj-qa{display:flex;flex-direction:column;gap:8px;padding:12px}
.pj-msg-row{display:flex;gap:8px;align-items:flex-start}
.pj-who{flex:none;width:46px;font:600 10px var(--mono);text-transform:uppercase;letter-spacing:.3px;padding-top:6px}
.pj-who.you{color:var(--accent)}.pj-who.agape{color:var(--ok)}.pj-who.warn{color:var(--warn)}
.pj-bubble{flex:1;background:var(--surface-2);border:1px solid var(--border);border-radius:10px;padding:8px 11px;font-size:13px;line-height:1.5;white-space:pre-wrap;word-break:break-word}
.pj-certificate-state{display:inline-block;font:600 10px var(--mono);color:var(--ok);background:rgba(63,185,80,.14);border-radius:5px;padding:1px 6px;margin-right:7px;vertical-align:1px}
.pj-output-provenance{display:block;color:var(--muted);font:600 10px var(--mono);letter-spacing:.02em;margin-bottom:4px;text-transform:uppercase}
.pj-certificate-state.is-qualified,.pj-certificate-state.is-abstained,.pj-certificate-state.is-rejected{color:var(--warn);background:rgba(210,153,34,.14)}
.pj-certificate-state.is-noverifiableclaims{color:var(--accent);background:var(--accent-soft)}
.pj-proof-note{margin:0 12px 8px;padding:7px 9px;border-left:2px solid var(--accent);background:var(--surface-2);color:var(--muted);font-size:11px}
.pj-certificate,.pj-evidence{margin:0 12px 8px;padding:8px 9px;border:1px solid var(--border-soft);border-radius:var(--radius-sm);background:var(--surface-2);font:11px/1.5 var(--mono)}
.pj-certificate{display:flex;flex-wrap:wrap;gap:5px 12px}
.pj-ruling{margin:0 12px 10px;padding:10px;border:1px solid var(--warn);border-radius:var(--radius-sm);background:rgba(210,153,34,.08)}
.pj-ruling-title{font:600 12px var(--mono);color:var(--warn);margin-bottom:5px}
.pj-ruling-meta{font:11px var(--mono);color:var(--muted)}
.pj-ruling-scores{display:flex;flex-wrap:wrap;gap:8px;margin:6px 0;font:11px var(--mono)}
.pj-ruling-actions{display:flex;gap:6px}.pj-ruling-actions button{padding:3px 8px;font-size:11px}
.pj-ruling-error,.pj-evidence-error{margin-top:7px;color:var(--err);font:11px var(--mono)}
.pj-evidence-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.pj-evidence-head button{padding:3px 8px;font-size:10px}
.pj-evidence-state{margin-top:7px;color:var(--muted)}
.pj-evidence-detail{margin-top:8px;border-top:1px solid var(--border-soft);padding-top:8px}
.pj-evidence-thresholds{display:grid;grid-template-columns:1fr 1fr;gap:3px 8px}
.pj-evidence-candidate{margin-top:8px;padding-top:7px;border-top:1px solid var(--border-soft)}
.pj-evidence-candidate>code{display:block;margin:4px 0;color:var(--text);white-space:pre-wrap;word-break:break-word}
.pj-evidence-tokens{display:flex;flex-wrap:wrap;gap:4px 10px;color:var(--muted)}
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
`;
