// api.js — the one place the frontend talks to the Agape backend.
// All calls are same-origin "/api/..." (Vite proxies to :8765 in dev; the Python
// backend serves both the API and the built app in production).

async function req(path, opts) {
  const r = await fetch(path, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data.error || `${r.status} ${r.statusText}`);
    err.kind = data.kind;
    throw err;
  }
  return data;
}

const post = (path, body) =>
  req(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

export const api = {
  state: () => req("/api/state"),
  spineSince: (tick) => req(`/api/spine?since=${tick}`),
  load: (source, path) => post("/api/load", path ? { path } : { source }),
  eval: (source) => post("/api/eval", { source }),
  spawn: (type, name, args = []) => post("/api/spawn", { type, name, args }),
  awake: (name) => post("/api/awake", { name }),
  sleep: (name) => post("/api/sleep", { name }),
  send: (dest, message, schema = "text") => post("/api/send", { dest, message, schema }),
  prompt: (source, value) => post("/api/prompt", { source, value }),
};
