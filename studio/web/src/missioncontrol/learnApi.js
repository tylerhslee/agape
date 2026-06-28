// The studio's window into the builder agent's runtime. Reads (inspect/recall) are
// FREE — they hit only the spine + local memory, no Claude. ingest/step cost API
// calls. See studio/agent-server/RUNTIME.md.

async function get(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`agent server: HTTP ${r.status}`);
  return r.json();
}
async function post(path, body) {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || `agent server: HTTP ${r.status}`);
  }
  return r.json();
}

// free
export const inspect = () => get("/learn/inspect");
export const recall = (q) => get(`/learn/recall?q=${encodeURIComponent(q)}`);

// cost Claude API calls
export const ingest = (maxChunks) => post("/learn/ingest", { maxChunks });
export const step = (task) => post("/learn/step", { task });

// free retrieval/orientation for a coding task
export const context = (task) => post("/learn/context", { task });
