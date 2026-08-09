// The project studio's window into the user's Agape project: list/read/write the
// .ag files and run one through the `agape` CLI. Proxied to the agent-server.

async function get(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`project: HTTP ${r.status}`);
  return r.json();
}
async function post(path, body) {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `project: HTTP ${r.status}`);
  return d;
}
async function put(path, body) {
  const r = await fetch(path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const error = new Error(d.error || ("project: HTTP " + r.status));
    error.status = r.status;
    error.code = d.code;
    error.diagnostics = d.diagnostics;
    error.currentRevision = d.currentRevision;
    throw error;
  }
  return d;
}

export const info = () => get("/project/info");
export const agentConfig = () => get("/agent/config");
export const saveAgentConfig = (config) => post("/agent/config", config);
export const runtimeConfig = () => get("/runtime/config");
export const saveRuntimeConfig = (config) => post("/runtime/config", config);
export const file = (rel) => get("/project/file?rel=" + encodeURIComponent(rel));
export const saveFile = (rel, body) => post("/project/file", { rel, body });
export const flow = (rel) => get("/project/flow?rel=" + encodeURIComponent(rel));
export const saveFlow = (rel, revision, changes) => put("/project/flow?rel=" + encodeURIComponent(rel), { revision, changes });
export const saveFlowStructure = (rel, revision, patch) => put("/project/flow?rel=" + encodeURIComponent(rel), { revision, patch });
export const run = (rel, prompts, opts) => post("/project/run", { rel, prompts, ...(opts || {}) });
