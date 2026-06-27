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

export const info = () => get("/project/info");
export const file = (rel) => get("/project/file?rel=" + encodeURIComponent(rel));
export const saveFile = (rel, body) => post("/project/file", { rel, body });
export const run = (rel, prompts) => post("/project/run", { rel, prompts });
