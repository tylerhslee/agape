import { useEffect, useState, useCallback } from "react";
import { inspect, recall, ingest, step, context as getContext } from "./learnApi.js";

const DEFAULT_TASK =
  "Build a support agent that classifies requests, replies for reversible outcomes, and defers consequential refunds to a principal.";

export default function Learning({ initialTab = "context", focus = "builder" }) {
  const [snap, setSnap] = useState(null);
  const [tab, setTab] = useState(initialTab);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [task, setTask] = useState(DEFAULT_TASK);
  const [chunks, setChunks] = useState(10);
  const [lastStep, setLastStep] = useState(null);
  const [ctx, setCtx] = useState(null);
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

  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);

  const runIngest = async () => {
    setBusy("ingest");
    setError(null);
    try {
      await ingest(Number(chunks) || 10);
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };

  const runContext = async () => {
    if (!task.trim()) return;
    setBusy("context");
    setError(null);
    try {
      setCtx(await getContext(task.trim()));
      setTab("context");
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
      setTab("last");
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
  const memoryReady = c.embeddings > 0 || c.facts > 0 || c.triples > 0;

  return (
    <div className="builder-page">
      {focus !== "memory" && (
        <header className="builder-hero">
          <div>
            <div className="builder-kicker"><i className="ti ti-sparkles" /> Agape Builder</div>
            <h1>Agentic coding memory</h1>
            <p>
              Retrieve the right Agape rules, draft source, run the checker, and fold useful failures back into memory.
            </p>
          </div>
          <div className="builder-loop" aria-label="builder loop">
            <span>Recall</span>
            <i className="ti ti-arrow-right" />
            <span>Write</span>
            <i className="ti ti-arrow-right" />
            <span>Check</span>
            <i className="ti ti-arrow-right" />
            <span>Learn</span>
          </div>
        </header>
      )}

      {error && (
        <div className="builder-alert">
          <i className="ti ti-alert-triangle" /> {error}
        </div>
      )}

      {focus !== "memory" && <section className="builder-grid">
        <div className="builder-command">
          <div className="builder-card-head">
            <div>
              <div className="builder-card-title">Task</div>
              <div className="builder-card-sub">Describe the Agape program you want the builder to write.</div>
            </div>
            <button className="ghost mc-btn-sm" onClick={refresh}><i className="ti ti-refresh" /> Refresh</button>
          </div>
          <textarea
            className="builder-task"
            value={task}
            onChange={(e) => setTask(e.target.value)}
            placeholder="What should the Agape agents do?"
          />
          <div className="builder-actions">
            <button className="mc-btn-sm" onClick={runContext} disabled={!!busy}>
              <i className="ti ti-search" /> {busy === "context" ? "Recalling..." : "Recall context"}
            </button>
            <button className="accent mc-btn-sm" onClick={runStep} disabled={!!busy}>
              <i className="ti ti-player-play" /> {busy === "step" ? "Running..." : "Draft and check"} <span className="mc-cost">$</span>
            </button>
          </div>
        </div>

        <div className="builder-memory">
          <div className="builder-card-title">Memory State</div>
          <div className="builder-memory-grid">
            <Metric label="ledger" value={c.spine} />
            <Metric label="facts" value={c.facts} />
            <Metric label="graphs" value={c.triples} />
            <Metric label="vectors" value={c.embeddings} />
          </div>
          <div className="builder-ingest">
            <span>{memoryReady ? "Spec memory is available." : "Seed the builder with spec memory."}</span>
            <div className="mc-assign-row">
              <input type="number" min="1" max="60" value={chunks} onChange={(e) => setChunks(e.target.value)} />
              <button className="mc-btn-sm" onClick={runIngest} disabled={!!busy}>
                {busy === "ingest" ? "Ingesting..." : "Ingest spec"} <span className="mc-cost">$</span>
              </button>
            </div>
          </div>
        </div>
      </section>}

      <nav className="builder-tabs">
        {[
          ["context", "Context"],
          ["last", "Last run"],
          ["memory", "Memory"],
          ["recall", "Recall"],
        ].map(([id, label]) => (
          <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>{label}</button>
        ))}
      </nav>

      {tab === "context" && <ContextPanel ctx={ctx} memoryReady={memoryReady} />}
      {tab === "last" && <LastStepPanel lastStep={lastStep} />}
      {tab === "memory" && <MemoryPanel snap={snap} />}
      {tab === "recall" && (
        <RecallPanel q={q} setQ={setQ} hits={hits} runRecall={runRecall} snap={snap} />
      )}
    </div>
  );
}

function ContextPanel({ ctx, memoryReady }) {
  if (!ctx) {
    return (
      <section className="builder-panel empty-state">
        <i className="ti ti-map-search" />
        <div>{memoryReady ? "Recall context for a task before drafting." : "Ingest the spec, then recall context for a task."}</div>
      </section>
    );
  }
  return (
    <section className="builder-panel">
      <div className="builder-card-head">
        <div>
          <div className="builder-card-title">Orientation Packet</div>
          <div className="builder-card-sub">Runner: {ctx.runner} · hits {ctx.hits?.length || 0} · triples {ctx.triples?.length || 0} · lessons {ctx.lessons?.length || 0}</div>
        </div>
      </div>
      <div className="builder-rule-grid">
        {(ctx.rules || []).map((r, i) => (
          <div key={i} className="builder-rule"><i className="ti ti-shield-check" /> {r}</div>
        ))}
      </div>
      {ctx.context ? <pre className="builder-context">{ctx.context}</pre> : <div className="empty-state compact">No memory matched yet.</div>}
    </section>
  );
}

function LastStepPanel({ lastStep }) {
  if (!lastStep) {
    return (
      <section className="builder-panel empty-state">
        <i className="ti ti-code" />
        <div>No draft has run yet.</div>
      </section>
    );
  }
  return (
    <section className="builder-panel">
      <div className="builder-card-head">
        <div>
          <div className="builder-card-title">Last Draft</div>
          <div className="builder-card-sub">
            {lastStep.result.ok ? "Accepted by the runner." : "Rejected; the lesson was stored for the next pass."}
          </div>
        </div>
        <span className={"builder-result " + (lastStep.result.ok ? "ok" : "bad")}>
          {lastStep.result.ok ? "accepted" : "rejected"}
        </span>
      </div>
      <pre className="mc-code">{lastStep.code}</pre>
      {!lastStep.result.ok && <div className="builder-alert inline"><i className="ti ti-bug" /> {lastStep.result.error}</div>}
      {lastStep.lesson && <div className="builder-lesson"><i className="ti ti-bulb" /> {lastStep.lesson}</div>}
    </section>
  );
}

function MemoryPanel({ snap }) {
  const [sub, setSub] = useState("facts");
  return (
    <section className="builder-panel">
      <div className="builder-subtabs">
        {["facts", "relationships", "ledger"].map((t) => (
          <button key={t} className={sub === t ? "active" : ""} onClick={() => setSub(t)}>{t}</button>
        ))}
      </div>
      {sub === "facts" && <Rows rows={snap?.facts || []} kind="fact" />}
      {sub === "relationships" && <Rows rows={snap?.triples || []} kind="triple" />}
      {sub === "ledger" && <Rows rows={snap?.spine || []} kind="ledger" />}
    </section>
  );
}

function RecallPanel({ q, setQ, hits, runRecall, snap }) {
  return (
    <section className="builder-panel">
      <div className="builder-search">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search semantic memory..."
          onKeyDown={(e) => e.key === "Enter" && runRecall()}
        />
        <button className="mc-btn-sm" onClick={runRecall}><i className="ti ti-search" /> Match</button>
      </div>
      {hits && <Rows rows={hits} kind="hit" />}
      <div className="builder-card-sub" style={{ marginTop: 18 }}>Vector entries</div>
      <Rows rows={snap?.embeddings || []} kind="embedding" />
    </section>
  );
}

function Rows({ rows, kind }) {
  if (!rows.length) return <div className="empty-state compact">Empty.</div>;
  return (
    <div className="builder-rows">
      {rows.map((r, i) => {
        if (kind === "fact") return <div key={i} className="builder-row"><b>{r.key}</b><span>{trunc(r.value, 150)}</span><em>#{r.origin_tick} · {r.taint}</em></div>;
        if (kind === "triple") return <div key={i} className="builder-row"><b>{r.s}</b><span>{r.p} {"->"} {r.o}</span><em>#{r.origin_tick}</em></div>;
        if (kind === "ledger") return <div key={i} className="builder-row"><b>#{r.tick}</b><span>{r.etype} · {r.subject}</span><em>{trunc(r.payload, 80)}</em></div>;
        if (kind === "hit") return <div key={i} className="builder-row"><b>{r.score.toFixed(2)}</b><span>{trunc(r.text, 180)}</span><em>#{r.origin_tick}</em></div>;
        return <div key={i} className="builder-row"><span>{trunc(r.text, 180)}</span><em>#{r.origin_tick}</em></div>;
      })}
    </div>
  );
}

function Metric({ label, value }) {
  return (
    <div className="builder-mini-metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function trunc(s, n) {
  if (!s) return "";
  const flat = String(s).replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n) + "..." : flat;
}
