const PREFIX = "agape.studio.runtime.v1";

export class RuntimeSessionClientError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = "RuntimeSessionClientError";
    this.status = status;
    this.code = code;
  }
}

function browserStorage(name) {
  try { return globalThis?.[name]; } catch { return undefined; }
}

function safeGet(storage, key) {
  try { return storage?.getItem(key) || null; } catch { return null; }
}

function safeSet(storage, key, value) {
  try { storage?.setItem(key, value); } catch { /* storage is an optimization */ }
}

function safeRemove(storage, key) {
  try { storage?.removeItem(key); } catch { /* storage is an optimization */ }
}

async function responseJson(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new RuntimeSessionClientError(data.error || `runtime session: HTTP ${response.status}`, {
      status: response.status,
      code: data.code,
    });
  }
  return data;
}

/**
 * Browser capability holder for one attached Studio project.
 *
 * The reusable bearer capability lives only in sessionStorage (or this object's
 * memory when storage is unavailable). localStorage receives only the opaque
 * conversation id, allowing a fresh runtime session to retain lineage without
 * making a session capability survive the browser session.
 */
export class RuntimeSessionClient {
  constructor({ fetchImpl = (...args) => globalThis.fetch(...args), sessionStorage, localStorage } = {}) {
    this.fetchImpl = fetchImpl;
    this.sessionStorage = sessionStorage ?? browserStorage("sessionStorage");
    this.localStorage = localStorage ?? browserStorage("localStorage");
    this.memory = new Map();
  }

  keys(projectKey, rel) {
    const suffix = encodeURIComponent(`${projectKey || "attached-project"}\0${rel}`);
    return {
      capability: `${PREFIX}.capability.${suffix}`,
      conversation: `${PREFIX}.conversation.${suffix}`,
    };
  }

  credentials(projectKey, rel) {
    const { capability } = this.keys(projectKey, rel);
    const raw = safeGet(this.sessionStorage, capability) ?? this.memory.get(capability);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed.sessionId !== "string" || typeof parsed.accessToken !== "string") return null;
      return parsed;
    } catch {
      return null;
    }
  }

  remember(projectKey, rel, created) {
    const keys = this.keys(projectKey, rel);
    const encoded = JSON.stringify({ sessionId: created.sessionId, accessToken: created.accessToken });
    this.memory.set(keys.capability, encoded);
    safeSet(this.sessionStorage, keys.capability, encoded);
    safeSet(this.localStorage, keys.conversation, created.conversationId);
  }

  clear(projectKey, rel) {
    const { capability } = this.keys(projectKey, rel);
    this.memory.delete(capability);
    safeRemove(this.sessionStorage, capability);
  }

  async reset(projectKey, rel) {
    const credentials = this.credentials(projectKey, rel);
    if (!credentials) return;
    const view = await this.request(`/runtime/sessions/${encodeURIComponent(credentials.sessionId)}`, {
      token: credentials.accessToken,
    });
    if (view.state === "pending-ruling") {
      throw new RuntimeSessionClientError("resolve or decline the pending ruling before replacing this source session", {
        status: 409,
        code: "ruling_pending",
      });
    }
    await this.request(`/runtime/sessions/${encodeURIComponent(credentials.sessionId)}/close`, {
      method: "POST",
      token: credentials.accessToken,
      body: {},
    });
    this.clear(projectKey, rel);
  }
  async request(path, { method = "GET", body, token } = {}) {
    const headers = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (token) headers.authorization = `Bearer ${token}`;
    return responseJson(await this.fetchImpl(path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
  }

  async session(projectKey, rel) {
    const credentials = this.credentials(projectKey, rel);
    if (credentials) {
      try {
        const view = await this.request(`/runtime/sessions/${encodeURIComponent(credentials.sessionId)}`, {
          token: credentials.accessToken,
        });
        if (view.sourceRef === rel && view.state !== "closed") return { view, credentials };
      } catch (error) {
        if (!(error instanceof RuntimeSessionClientError) || ![401, 404, 409].includes(error.status)) throw error;
      }
      this.clear(projectKey, rel);
    }

    const keys = this.keys(projectKey, rel);
    const conversationId = safeGet(this.localStorage, keys.conversation) || undefined;
    const created = await this.request("/runtime/sessions", {
      method: "POST",
      body: { rel, ...(conversationId ? { conversationId } : {}) },
    });
    this.remember(projectKey, rel, created);
    return {
      view: created,
      credentials: { sessionId: created.sessionId, accessToken: created.accessToken },
    };
  }

  async sendPrompt(projectKey, rel, input) {
    const { view, credentials } = await this.session(projectKey, rel);
    if (view.state === "pending-ruling") {
      throw new RuntimeSessionClientError("resolve the pending ruling before sending another prompt", {
        status: 409,
        code: "ruling_pending",
      });
    }
    return this.request(`/runtime/sessions/${encodeURIComponent(credentials.sessionId)}/prompts`, {
      method: "POST",
      token: credentials.accessToken,
      body: input,
    });
  }

  async rule(projectKey, rel, pending, outcome, decision) {
    const credentials = this.credentials(projectKey, rel);
    if (!credentials) throw new RuntimeSessionClientError("runtime session capability is unavailable", { status: 401, code: "invalid_session_capability" });
    return this.request(`/runtime/sessions/${encodeURIComponent(credentials.sessionId)}/rulings`, {
      method: "POST",
      token: credentials.accessToken,
      body: {
        requestId: pending.requestId,
        principal: pending.principal,
        outcome,
        ...(decision === undefined ? {} : { decision }),
      },
    });
  }

  async inspectEvidence(projectKey, rel, evidenceRef, decisionId) {
    const credentials = this.credentials(projectKey, rel);
    if (!credentials) throw new RuntimeSessionClientError("runtime session capability is unavailable", { status: 401, code: "invalid_session_capability" });
    return this.request(`/runtime/sessions/${encodeURIComponent(credentials.sessionId)}/evidence`, {
      method: "POST",
      token: credentials.accessToken,
      body: { evidenceRef, decisionId },
    });
  }
}

export const runtimeSessions = new RuntimeSessionClient();
