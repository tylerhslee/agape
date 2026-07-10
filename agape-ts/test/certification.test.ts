import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertEventOrder,
  assertPayloadObject,
  eventTypes,
  normalizedLedger,
  requireEvent,
  withAgapeRun,
} from "../src/testkit.js";

const GATED_REPLY = `
enum Verdict { Publish, Revise }
action Announce(text body);
agent Greeter grants { perform Announce } {
  on awake {
    text draft = "hello from testkit";
    Credence<Verdict> c = self <- f"safe to publish: {draft}";
    Decision<Verdict> d = decide c by confidence 0.5;
    if (d.committed == Publish) {
      Endorsement<text> e = endorse draft by d;
      perform Announce(e);
    }
  }
}
spawn Greeter g;
awake g;
`;

describe("Agape core certification suite", () => {
  it("certifies the typed gate chain reaches a granted sink only after endorsement", async () => {
    await withAgapeRun(GATED_REPLY, (run) => {
      assertEventOrder(run, ["Spawned", "AgentAwake", "Sent", "Delivered", "Resolved", "Decided", "Endorsed", "Announce"]);
      expect(eventTypes(run)).toContain("Endorsed");
      expect(requireEvent(run, "Announce").payload).toEqual(["hello from testkit"]);
      expect(normalizedLedger(run)[0]).toMatchObject({ tick: 0, etype: "Spawned" });
    });
  });

  it("certifies default markdown memory is project-rooted and runtime-wrapped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agape-cert-memory-"));
    try {
      await withAgapeRun(`
        agent A {
          on awake {
            mem notes <- "remember that certification writes project markdown";
          }
        }
        spawn A a;
        awake a;
      `, { memoryRoot: dir }, (run) => {
        const internalized = requireEvent(run, "Internalized");
        const payload = assertPayloadObject(internalized);
        expect(payload.policy).toMatchObject({ driver: "markdown", memory_runtime: "agape-default" });
      });

      await expect(readFile(join(dir, ".agape", "memory", "MEMORY.md"), "utf8"))
        .resolves.toContain("default/a/notes");
      await expect(readFile(join(dir, ".agape", "memory", "scopes", "default", "a", "notes.md"), "utf8"))
        .resolves.toContain("certification writes project markdown");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("certifies built-in HTTP tool bindings route consequential actions to real adapters", async () => {
    const requests: unknown[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        requests.push(JSON.parse(body));
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ result: "adapter receipt" }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("expected TCP address");
      await withAgapeRun(`
        action Search(text q);
        event SearchEvidence(text hits);
        agent A grants { perform Search } {
          on awake {
            text hit = perform Search("northwind") expires 5;
            say(hit);
          }
        }
        spawn A a;
        awake a;
      `, {
        manifest: {
          provider: { backend: "mock" },
          tools: { search: { driver: "http", url: `http://127.0.0.1:${address.port}/tool` } },
          actions: { Search: { tool: "search", result_event: "SearchEvidence" } },
        },
      }, (run) => {
        expect(run.stdout).toEqual(["adapter receipt"]);
        expect(requests[0]).toMatchObject({ tool: "search", args: ["northwind"] });
        expect(assertPayloadObject(requireEvent(run, "ToolResolved"))).toMatchObject({ binding: { driver: "http" } });
        expect(assertPayloadObject(requireEvent(run, "SearchEvidence"))).toMatchObject({ hits: { value: "adapter receipt" } });
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
  });
});