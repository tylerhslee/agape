// The Review studio's window into the spec + conformance suite + live results.
// /review/data runs the agape-rs conformance (a few seconds); spec-edit costs a
// Claude call; the saves write SPEC.md / a .ag test. Proxied to the agent-server.

async function get(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`review: HTTP ${r.status}`);
  return r.json();
}
async function post(path, body) {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `review: HTTP ${r.status}`);
  return d;
}

export const data = () => get("/review/data");
export const specEdit = (anchor, selection, instruction) => post("/review/spec-edit", { anchor, selection, instruction });
export const specSave = (text) => post("/review/spec-save", { text });
export const testSave = (rel, body) => post("/review/test-save", { rel, body });
