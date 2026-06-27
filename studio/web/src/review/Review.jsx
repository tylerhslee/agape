import { useState, useEffect, useRef, useMemo } from "react";
import Editor from "@monaco-editor/react";
import { registerAgape, AGAPE_LANG_ID } from "../agapeLanguage.js";
import * as review from "./reviewApi.js";

// The Review studio: inspect the conformance suite, read/proofread SPEC.md, and
// edit the spec with an LLM in place. Built on Studio's Monaco + agent-server.
export default function Review({ onStudio }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [tab, setTab] = useState("tests");
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [ranAt, setRanAt] = useState(null);

  const load = async () => {
    setLoading(true);
    setErr(null);
    try {
      setData(await review.data());
    } catch (e) {
      setErr(e.message);
    }
    setLoading(false);
  };
  // Re-run the conformance suite and update results in place, without the full-page
  // loading state — the table stays visible while the suite runs. (The Monaco spec
  // editor uses a non-reactive defaultValue, so refreshing data won't reset an edit.)
  const runTests = async () => {
    setRunning(true);
    setErr(null);
    try {
      setData(await review.data());
      setRanAt(new Date().toLocaleTimeString());
    } catch (e) {
      setErr(e.message);
    }
    setRunning(false);
  };
  useEffect(() => {
    load();
  }, []);

  return (
    <div className="rv">
      <header className="rv-top">
        <b style={{ letterSpacing: 0.3 }}>Agape · Review</b>
        {data && <span className={"rv-badge " + (data.passed === data.total ? "ok" : "bad")}>{data.passed}/{data.total} pass</span>}
        {data && <span className={"rv-badge " + (data.buildOk ? "ok" : "bad")}>{data.buildOk ? "build ok" : "BUILD FAILED"}</span>}
        <nav className="rv-tabs">
          {["tests", "spec", "results"].map((t) => (
            <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t}</button>
          ))}
        </nav>
        <span style={{ flex: 1 }} />
        {ranAt && !running && <span className="dim" style={{ fontSize: 12 }}>ran {ranAt}</span>}
        <button className="primary" onClick={runTests} disabled={running || loading} title="Re-run the conformance suite">
          {running ? "running tests…" : "▶ Run tests"}
        </button>
        <button onClick={load} disabled={loading || running} title="Reload everything (suite + spec)">{loading ? "loading…" : "↻ reload"}</button>
        {onStudio && <button onClick={onStudio}>Studio →</button>}
      </header>

      {err && <div className="rv-err">backend error: {err}<br />— start it: <code>cd studio/agent-server &amp;&amp; npx tsx server.ts</code> (needs ANTHROPIC_API_KEY)</div>}
      {loading && !data && <div className="rv-load">running the conformance suite…</div>}
      {data && tab === "tests" && <TestsView data={data} />}
      {data && tab === "spec" && <SpecView spec={data.spec} onSaved={load} />}
      {data && tab === "results" && <ResultsView data={data} />}
      <style>{STYLE}</style>
    </div>
  );
}

function TestsView({ data }) {
  const [sel, setSel] = useState(null);
  const [q, setQ] = useState("");
  const [sec, setSec] = useState("");
  const [st, setSt] = useState("");
  const [src, setSrc] = useState("");
  const [msg, setMsg] = useState(null);
  const sections = useMemo(() => [...new Set(data.tests.map((t) => t.section))].sort(), [data]);
  const rows = data.tests.filter(
    (t) => (!sec || t.section === sec) && (!st || t.status === st) &&
      (!q || t.id.includes(q) || (t.spec || "").includes(q) || t.body.includes(q))
  );
  const open = (t) => { setSel(t); setSrc(t.body); setMsg(null); };
  const save = async () => {
    try {
      await review.testSave(sel.rel, src);
      setMsg({ ok: true, t: "saved — hit ↻ refresh to re-run" });
    } catch (e) {
      setMsg({ ok: false, t: e.message });
    }
  };
  return (
    <div className="rv-split">
      <div className="rv-list">
        <div className="rv-filters">
          <input placeholder="search id / spec / source…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select value={sec} onChange={(e) => setSec(e.target.value)}>
            <option value="">all sections</option>
            {sections.map((s) => <option key={s}>{s}</option>)}
          </select>
          <select value={st} onChange={(e) => setSt(e.target.value)}>
            <option value="">all</option><option value="pass">pass</option><option value="fail">fail</option>
          </select>
        </div>
        <div className="rv-rows">
          {rows.map((t) => (
            <div key={t.id} className={"rv-row" + (sel && sel.id === t.id ? " on" : "")} onClick={() => open(t)}>
              <span className={"dot " + t.status} />
              <div style={{ minWidth: 0 }}>
                <div className="tid">{t.id}</div>
                <div className="dim ell">{t.section} · {t.expect}{t.error ? " · " + t.error : ""}</div>
              </div>
            </div>
          ))}
          <div className="dim" style={{ padding: 8 }}>{rows.length} shown</div>
        </div>
      </div>
      <div className="rv-detail">
        {!sel ? (
          <div className="rv-empty">Select a test to inspect its source and status.</div>
        ) : (
          <>
            <div className="rv-detail-top">
              <b>{sel.id}</b>
              <span className="dim ell" style={{ marginLeft: 8 }}>{sel.rel}</span>
              <span style={{ flex: 1 }} />
              <button onClick={save}>save .ag</button>
              {msg && <span className={msg.ok ? "ok" : "bad"} style={{ marginLeft: 8 }}>{msg.t}</span>}
            </div>
            <div className="dim" style={{ padding: "6px 14px 0" }}>spec: {sel.spec}</div>
            {sel.status === "fail"
              ? <div className="rv-reason">✗ {sel.reason}</div>
              : <div className="ok" style={{ padding: "6px 14px" }}>✓ passing</div>}
            <div style={{ flex: 1, minHeight: 0 }}>
              <Editor height="100%" language={AGAPE_LANG_ID} theme="agape-dark" value={src}
                onChange={(v) => setSrc(v ?? "")} beforeMount={registerAgape}
                options={{ fontSize: 13, minimap: { enabled: false }, automaticLayout: true, scrollBeyondLastLine: false, tabSize: 2 }} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function SpecView({ spec, onSaved }) {
  const edRef = useRef(null);
  const [instr, setInstr] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [dirty, setDirty] = useState(false);

  const editWithLLM = async () => {
    const ed = edRef.current;
    if (!ed) return;
    const range = ed.getSelection();
    const selText = ed.getModel().getValueInRange(range);
    if (!selText.trim()) { setMsg({ ok: false, t: "select a span of the spec in the editor first" }); return; }
    if (!instr.trim()) { setMsg({ ok: false, t: "write an instruction" }); return; }
    setBusy(true);
    setMsg(null);
    try {
      const { edited } = await review.specEdit(`SPEC.md:${range.startLineNumber}`, selText, instr);
      ed.executeEdits("llm", [{ range, text: edited }]);
      setDirty(true);
      setMsg({ ok: true, t: "applied to the editor — review the change, then Save" });
    } catch (e) {
      setMsg({ ok: false, t: e.message });
    }
    setBusy(false);
  };
  const save = async () => {
    setBusy(true);
    try {
      await review.specSave(edRef.current.getValue());
      setDirty(false);
      setMsg({ ok: true, t: "SPEC.md saved" });
      onSaved && onSaved();
    } catch (e) {
      setMsg({ ok: false, t: e.message });
    }
    setBusy(false);
  };
  return (
    <div className="rv-spec">
      <div className="rv-spec-bar">
        <input style={{ flex: 1 }} placeholder="instruction for the SELECTED span — e.g. 'tighten this', 'fix the §6b cross-ref', 'add an example'"
          value={instr} onChange={(e) => setInstr(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") editWithLLM(); }} />
        <button className="primary" onClick={editWithLLM} disabled={busy}>{busy ? "thinking…" : "✦ edit selection"}</button>
        <button onClick={save} disabled={busy || !dirty}>{dirty ? "save SPEC.md*" : "save SPEC.md"}</button>
        {msg && <span className={msg.ok ? "ok" : "bad"}>{msg.t}</span>}
      </div>
      <div className="dim" style={{ padding: "4px 14px" }}>
        Select text in the editor → write an instruction → ✦ edit. The LLM rewrites just that span in place; review and Save.
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <Editor height="100%" language="markdown" theme="agape-dark" defaultValue={spec}
          onMount={(ed) => { edRef.current = ed; }} onChange={() => setDirty(true)}
          options={{ fontSize: 13, wordWrap: "on", minimap: { enabled: false }, automaticLayout: true, scrollBeyondLastLine: false }} />
      </div>
    </div>
  );
}

function ResultsView({ data }) {
  const bySec = {};
  data.tests.forEach((t) => {
    const k = t.section;
    bySec[k] = bySec[k] || { p: 0, n: 0 };
    bySec[k][t.status === "pass" ? "p" : "n"]++;
  });
  return (
    <div className="rv-results">
      <div className="dim" style={{ marginBottom: 18 }}>{data.summary || `${data.passed}/${data.total} pass`}</div>
      {Object.keys(bySec).sort().map((s) => {
        const { p, n } = bySec[s], tot = p + n, pct = tot ? Math.round((p / tot) * 100) : 0;
        return (
          <div key={s} className="rv-rrow">
            <span className="rsec">{s}</span>
            <div className="rbar"><i style={{ width: pct + "%" }} /></div>
            <span className="dim" style={{ width: 56, textAlign: "right" }}>{p}/{tot}</span>
          </div>
        );
      })}
    </div>
  );
}

const STYLE = `
.rv{position:fixed;inset:0;display:flex;flex-direction:column;background:#0f1115;color:#e6e9ef;
font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif}
.rv code{font:12px ui-monospace,Menlo,Consolas,monospace;color:#9aa4b2}
.rv-top{display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid #2a3140;background:#161a22}
.rv-badge{font:600 12px ui-monospace,monospace;padding:4px 9px;border-radius:6px;background:#1d2330}
.rv-badge.ok{color:#3fb950}.rv-badge.bad{color:#f85149}
.rv-tabs{display:flex;gap:4px;margin-left:6px}
.rv button{font:inherit;cursor:pointer;border:1px solid #2a3140;background:#1d2330;color:#e6e9ef;border-radius:7px;padding:6px 12px}
.rv-tabs button{text-transform:capitalize;color:#9aa4b2}
.rv-tabs button.on{background:#243049;color:#e6e9ef;border-color:#345}
.rv button.primary{background:#58a6ff;border-color:#58a6ff;color:#04101f;font-weight:600}
.rv button:disabled{opacity:.5;cursor:default}
.rv-err{padding:14px 18px;color:#f85149;background:#1a1113;border-bottom:1px solid #3a2226}
.rv-load{padding:40px;text-align:center;color:#9aa4b2}
.dim{color:#9aa4b2}.ok{color:#3fb950}.bad{color:#f85149}
.ell{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rv-split{flex:1;display:flex;min-height:0}
.rv-list{width:330px;border-right:1px solid #2a3140;display:flex;flex-direction:column;background:#13161d}
.rv-filters{display:flex;gap:6px;padding:10px;border-bottom:1px solid #2a3140}
.rv-filters input,.rv-filters select{font:inherit;background:#1d2330;border:1px solid #2a3140;color:#e6e9ef;border-radius:7px;padding:5px 8px}
.rv-filters input{flex:1;min-width:0}
.rv-rows{flex:1;overflow:auto}
.rv-row{display:flex;gap:9px;align-items:center;padding:8px 12px;cursor:pointer;border-bottom:1px solid #1b2230}
.rv-row:hover{background:#1d2330}.rv-row.on{background:#243049}
.dot{width:9px;height:9px;border-radius:50%;flex:none}.dot.pass{background:#3fb950}.dot.fail{background:#f85149}
.tid{font:600 13px ui-monospace,monospace}
.rv-detail{flex:1;display:flex;flex-direction:column;min-width:0}
.rv-empty{margin:auto;color:#9aa4b2}
.rv-detail-top{display:flex;align-items:center;padding:10px 14px;border-bottom:1px solid #2a3140;background:#161a22}
.rv-reason{padding:8px 14px;color:#f85149;font:12.5px ui-monospace,monospace;white-space:pre-wrap;border-bottom:1px solid #2a1e22}
.rv-spec{flex:1;display:flex;flex-direction:column;min-height:0}
.rv-spec-bar{display:flex;gap:8px;align-items:center;padding:10px 14px;border-bottom:1px solid #2a3140;background:#161a22}
.rv-spec-bar input{font:inherit;background:#1d2330;border:1px solid #2a3140;color:#e6e9ef;border-radius:7px;padding:7px 10px}
.rv-results{flex:1;overflow:auto;padding:24px 28px}
.rv-rrow{display:grid;grid-template-columns:180px 1fr 56px;gap:14px;align-items:center;margin:7px 0}
.rsec{font:600 13px ui-monospace,monospace;color:#9aa4b2}
.rbar{height:18px;border-radius:5px;background:#241b1d;overflow:hidden}.rbar i{display:block;height:100%;background:#3fb950}
`;
