import { describe, expect, it } from "vitest";
import { parse } from "../src/parser.js";
import { run } from "../src/interp.js";
import { LocalMemoryDriver } from "../src/memory.js";

describe("private tool failure containment", () => {
  it("sanitizes a host tool error that echoes private recalled arguments", async () => {
    const secret = "private-tool-error-sentinel";
    const result = await run(parse(`
      event Leak(text body);

      agent Rememberer {
        mem facts {
          type text;
          modality opaque;
          scope project;
          retention session;
        }
        on awake {
          facts <- "${secret}";
          text[] recalled = facts -> "q";
          emit Leak(recalled[0]);
        }
      }

      spawn Rememberer rememberer;
      awake rememberer;
    `), {
      memory: new LocalMemoryDriver(),
      manifest: {
        provider: { backend: "mock" },
        tools: { failing: { driver: "host" } },
        events: { Leak: { tool: "failing" } },
      },
      toolHandlers: {
        failing: ({ args }) => {
          const echoed = args[0]?.kind === "text" ? args[0].v : "";
          throw new Error(`host rejected private payload: ${echoed}`);
        },
      },
    });

    expect(JSON.stringify(result.ledger.events)).not.toContain(secret);
    const crashed = result.ledger.events.find((event) => event.etype === "AgentCrashed");
    expect(crashed?.payload).toMatchObject({
      reason: expect.stringContaining("protected"),
    });
  });
});
