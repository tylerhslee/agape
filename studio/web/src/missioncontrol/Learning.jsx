import { useEffect, useState, useCallback } from "react";
import { inspect, recall, ingest, step } from "./learnApi.js";

// The agent-memory inspector: browse the spine and the three stores (§10) for free,
// run a recall, and drive the learning loop (ingest/step cost Claude calls).
export default function Learning() {
  const [snap, setSnap] = useState(null);
  const [tab, setTab] = useState("spine");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null); // "ingest" | "step" | null
  const [task, setTask] = useState("Write a minimal Agape program: an agent HelpDesk granted to perform a Refund action.");
  const [chunks, setChunks] = useState(6);
  const [lastStep, setLastStep] = useState(null);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState(null);

  const refresh = useCallback(async () => {
    try {
      setSnap(await inspect());
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const runIngest = async () => {
    setBusy("ingest");
    setError(null);
    try {
      await ingest(Number(chunks) || 6);
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };

  const runStep = async () => {
    if (!task.trim()) return;
    setBusy("step");
    setError(null);
    try {
      setLastStep(await step(task.trim()));
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };

  const runRecall = async () => {
    if (!q.trim()) return;
    try {
      setHits((await recall(q.trim())).hits);
    } catch (e) {
      setError(e.message);
    }
  };

  const c = snap?.counts || { spine: 0, facts: 0, triples: 0, embeddings: 0 };

  return (
    <div className="mc-col">
      <div className="mc-banner">
        <i className="ti ti-database mc-flag" />
        <span className="mc-banner-title">agent memory — the builder learning Agape</span>
        <button className="ghost mc-btn-sm" onClick={refresh}><i className="ti ti-refresh" /> refresh</button>
      </div>
      <div className="mc-hint">
        browsing the spine and memory is <strong style={{ fontWeight: 500, color: "var(--vsc-ok)" }}>free</strong> — it never calls Claude. only <span className="mc-cost">$ ingest</span> and <span className="mc-cost">$ step</span> spend API calls.
      </div>

      {error && <div className="mc-needs-empty" style={{ color: "var(--vsc-error)" }}><i className="ti ti-alert-triangle" /> {error} — is the agent server running? (studio/agent-server: npm run dev)</div>}

      <div className="mc-metrics mc-metrics-4">
        <Metric label="spine events" value={c.spine} />
        <Metric label="facts" value={c.facts} />
        <Metric label="relationships" value={c.triples} />
        <Metric label="vectors" value={c.embeddings} />
      </div>

      <div className="mc-learn-controls">
        <div className="mc-learn-ctl">
          <label>ingest spec chunks</label>
          <div className="mc-assign-row">
            <input type="number" min="1" max="40" value={chunks} onChange={(e) => setChunks(e.target.value)} style={{ width: 64 }} />
            <button className="mc-btn-sm" onClick={runIngest} disabled={busy}>
              {busy === "ingest" ? "internalizing…" : "ingest"} <span className="mc-cost">$</span>
            </button>
          </div>
        </div>
        <div className="mc-learn-ctl mc-grow">
          <label>run a learning step (retrieve → write → run → reflect)</label>
          <div className="mc-assign-row">
            <input className="mc-input" value={task} onChange={(e) => setTask(e.target.value)} placeholder="task for the builder…" />
            <button className="mc-btn-sm" onClick={runStep} disabled={busy}>
              {busy === "step" ? "running…" : "step"} <span className="mc-cost">$</span>
            </button>
          </div>
        </div>
      </div>

      {lastStep && (
        <div className="mc-card" style={{ marginTop: 12 }}>
          <div className="mc-card-head">
            <span className={"mc-chip " + (lastStep.result.ok ? "mc-st-done" : "mc-st-waiting")}>{lastStep.result.ok ? "accepted" : "rejected"}</span>
            <span className="mc-card-title">last step</span>
            <span className="mc-muted-sm" style={{ marginLeft: "auto" }}>runner: {lastStep.result.runner} · retrieved {lastStep.retrieved.hits} hits / {lastStep.retrieved.triples} triples / {lastStep.retrieved.lessons} lessons</span>
          </div>
          <pre className="mc-code">{lastStep.code}</pre>
          {!lastStep.result.ok && <div className="mc-card-line warn"><i className="ti ti-bug" /> {lastStep.result.error}</div>}
          {lastStep.lesson && <div className="mc-card-line"><i className="ti ti-bulb" /> lesson: {lastStep.lesson}</div>}
        </div>
      )}

      <div className="mc-subtabs">
        {["spine", "facts", "relationships", "semantics"].map((t) => (
          <span key={t} className={"mc-subtab" + (tab === t ? " active" : "")} onClick={() => setTab(t)}>{t}</span>
        ))}
      </div>

      {tab === "spine" && (
        <div className="mc-rows">
          {(snap?.spine || []).map((e) => (
            <div key={e.tick} className="mc-evrow">
              <span className="mc-tick">#{e.tick}</span>
              <span className="mc-etype">{e.etype}</span>
              <span className="mc-subj">{e.subject}</span>
              <span className="mc-pay">{trunc(e.payload, 110)}</span>
            </div>
          ))}
          {!snap?.spine?.length && <Empty />}
        </div>
      )}

      {tab === "facts" && (
        <div className="mc-rows">
          {(snap?.facts || []).map((f, i) => (
            <div key={i} className="mc-factrow">
              <span className="mc-key">{f.key}</span>
              <span className="mc-val">{trunc(f.value, 140)}</span>
              <span className="mc-prov">#{f.origin_tick} · {f.taint}</span>
            </div>
          ))}
          {!snap?.facts?.length && <Empty />}
        </div>
      )}

      {tab === "relationships" && (
        <div className="mc-rows">
          {(snap?.triples || []).map((t, i) => (
            <div key={i} className="mc-triplerow">
              <span className="mc-s">{t.s}</span>
              <span className="mc-p">—{t.p}→</span>
              <span className="mc-o">{t.o}</span>
              <span className="mc-prov">#{t.origin_tick}</span>
            </div>
          ))}
          {!snap?.triples?.length && <Empty />}
        </div>
      )}

      {tab === "semantics" && (
        <div>
          <div className="mc-input-row" style={{ marginTop: 0 }}>
            <input className="mc-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="recall: search the vector store (free)…" onKeyDown={(e) => e.key === "Enter" && runRecall()} />
            <button className="mc-btn-sm" onClick={runRecall}>match</button>
          </div>
          {hits && (
            <div className="mc-rows" style={{ marginTop: 10 }}>
              {hits.map((h, i) => (
                <div key={i} className="mc-hitrow">
                  <span className="mc-score">{h.score.toFixed(2)}</span>
                  <span className="mc-pay">{trunc(h.text, 160)}</span>
                  <span className="mc-prov">#{h.origin_tick}</span>
                </div>
              ))}
              {!hits.length && <div className="mc-needs-empty">no hits above threshold.</div>}
            </div>
          )}
          <div className="mc-subcap">vector entries (internalized chunks):</div>
          <div className="mc-rows">
            {(snap?.embeddings || []).map((e, i) => (
              <div key={i} className="mc-hitrow">
                <span className="mc-pay">{trunc(e.text, 160)}</span>
                <span className="mc-prov">#{e.origin_tick}</span>
              </div>
            ))}
            {!snap?.embeddings?.length && <Empty />}
          </div>
        </div>
      )}
    </div>
  );
}

function Metric({ label, value }) {
  return (
    <div className="mc-metric">
      <div className="mc-metric-label">{label}</div>
      <div className="mc-metric-value">{value}</div>
    </div>
  );
}

function Empty() {
  return <div className="mc-needs-empty">empty — ingest the spec to fill the agent's memory.</div>;
}

function trunc(s, n) {
  if (!s) return "";
  const flat = String(s).replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n) + "…" : flat;
}
