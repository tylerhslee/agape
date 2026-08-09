import { describe, expect, it, vi } from "vitest";
import { RuntimeSessionClient } from "./runtimeSessionClient.js";

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

const response = (body, status = 200) => Promise.resolve({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

describe("RuntimeSessionClient", () => {
  it("keeps the bearer in sessionStorage, persists only conversation lineage, and reuses the session", async () => {
    const sessionStorage = new MemoryStorage();
    const localStorage = new MemoryStorage();
    const fetchImpl = vi.fn()
      .mockImplementationOnce(() => response({
        sessionId: "session-1", accessToken: "secret-capability", conversationId: "conversation-1",
        sourceRef: "fact_checker.ag", state: "ready", ledger: [], certificates: [], stdout: [],
      }, 201))
      .mockImplementationOnce(() => response({
        sessionId: "session-1", conversationId: "conversation-1", sourceRef: "fact_checker.ag",
        state: "ready", ledger: [], certificates: [], stdout: [],
      }));
    const client = new RuntimeSessionClient({ fetchImpl, sessionStorage, localStorage });

    await client.session("project", "fact_checker.ag");
    await client.session("project", "fact_checker.ag");

    expect([...sessionStorage.values.values()].join(" ")).toContain("secret-capability");
    expect([...localStorage.values.values()]).toEqual(["conversation-1"]);
    expect(fetchImpl.mock.calls[1][1].headers.authorization).toBe("Bearer secret-capability");
  });

  it("sends evidence requests with the session capability and no reusable evidence authorization", async () => {
    const sessionStorage = new MemoryStorage();
    const localStorage = new MemoryStorage();
    const fetchImpl = vi.fn()
      .mockImplementationOnce(() => response({
        sessionId: "session-2", accessToken: "session-only", conversationId: "conversation-2",
        sourceRef: "fact_checker.ag", state: "ready", ledger: [], certificates: [], stdout: [],
      }, 201))
      .mockImplementationOnce(() => response({ decision_id: 9, evidence_ref: "protected:evidence:v1:abc" }));
    const client = new RuntimeSessionClient({ fetchImpl, sessionStorage, localStorage });
    await client.session("project", "fact_checker.ag");

    await client.inspectEvidence("project", "fact_checker.ag", "protected:evidence:v1:abc", 9);

    const [, options] = fetchImpl.mock.calls[1];
    expect(options.headers.authorization).toBe("Bearer session-only");
    expect(JSON.parse(options.body)).toEqual({ evidenceRef: "protected:evidence:v1:abc", decisionId: 9 });
    expect(options.body).not.toContain("authorization");
  });

  it("closes a ready source session before clearing it and refuses to abandon a pending ruling", async () => {
    const readySession = new MemoryStorage();
    const readyFetch = vi.fn()
      .mockImplementationOnce(() => response({
        sessionId: "session-3", accessToken: "close-me", conversationId: "conversation-3",
        sourceRef: "fact_checker.ag", state: "ready", ledger: [], certificates: [], stdout: [],
      }, 201))
      .mockImplementationOnce(() => response({ state: "ready" }))
      .mockImplementationOnce(() => response({ state: "closed" }));
    const ready = new RuntimeSessionClient({ fetchImpl: readyFetch, sessionStorage: readySession, localStorage: new MemoryStorage() });
    await ready.session("project", "fact_checker.ag");
    await ready.reset("project", "fact_checker.ag");
    expect(readyFetch.mock.calls[2][0]).toContain("/close");
    expect(ready.credentials("project", "fact_checker.ag")).toBeNull();

    const pendingSession = new MemoryStorage();
    const pendingFetch = vi.fn()
      .mockImplementationOnce(() => response({
        sessionId: "session-4", accessToken: "keep-me", conversationId: "conversation-4",
        sourceRef: "fact_checker.ag", state: "ready", ledger: [], certificates: [], stdout: [],
      }, 201))
      .mockImplementationOnce(() => response({ state: "pending-ruling" }));
    const pending = new RuntimeSessionClient({ fetchImpl: pendingFetch, sessionStorage: pendingSession, localStorage: new MemoryStorage() });
    await pending.session("project", "fact_checker.ag");
    await expect(pending.reset("project", "fact_checker.ag")).rejects.toMatchObject({ code: "ruling_pending" });
    expect(pending.credentials("project", "fact_checker.ag")).toMatchObject({ sessionId: "session-4", accessToken: "keep-me" });
    expect(pendingFetch).toHaveBeenCalledTimes(2);
  });

  it("retains the capability when a ruling appears between reset inspection and close", async () => {
    const sessionStorage = new MemoryStorage();
    const fetchImpl = vi.fn()
      .mockImplementationOnce(() => response({
        sessionId: "session-race", accessToken: "keep-race", conversationId: "conversation-race",
        sourceRef: "fact_checker.ag", state: "ready", ledger: [], certificates: [], stdout: [],
      }, 201))
      .mockImplementationOnce(() => response({ state: "ready" }))
      .mockImplementationOnce(() => response({ error: "a principal ruling is pending", code: "ruling_pending" }, 409));
    const client = new RuntimeSessionClient({ fetchImpl, sessionStorage, localStorage: new MemoryStorage() });
    await client.session("project", "fact_checker.ag");

    await expect(client.reset("project", "fact_checker.ag")).rejects.toMatchObject({ code: "ruling_pending" });
    expect(client.credentials("project", "fact_checker.ag")).toMatchObject({
      sessionId: "session-race", accessToken: "keep-race",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["session busy", () => response({ error: "session is busy", code: "session_busy" }, 409), "session_busy"],
    ["network failure", () => Promise.reject(new Error("connection lost")), undefined],
  ])("retains the capability when close fails with %s", async (_label, closeResult, code) => {
    const sessionStorage = new MemoryStorage();
    const fetchImpl = vi.fn()
      .mockImplementationOnce(() => response({
        sessionId: "session-failure", accessToken: "keep-failure", conversationId: "conversation-failure",
        sourceRef: "fact_checker.ag", state: "ready", ledger: [], certificates: [], stdout: [],
      }, 201))
      .mockImplementationOnce(() => response({ state: "ready" }))
      .mockImplementationOnce(closeResult);
    const client = new RuntimeSessionClient({ fetchImpl, sessionStorage, localStorage: new MemoryStorage() });
    await client.session("project", "fact_checker.ag");

    let failure;
    try { await client.reset("project", "fact_checker.ag"); }
    catch (error) { failure = error; }
    expect(failure).toBeTruthy();
    if (code) expect(failure).toMatchObject({ code });
    expect(client.credentials("project", "fact_checker.ag")).toMatchObject({
      sessionId: "session-failure", accessToken: "keep-failure",
    });
  });
});
