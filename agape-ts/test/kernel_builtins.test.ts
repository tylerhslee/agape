import { afterEach, describe, expect, it } from "vitest";
import { parse } from "../src/parser.js";
import { run as runtimeRun } from "../src/interp.js";
import { MockProvider, render } from "../src/runtime.js";
import { check } from "../src/check.js";

import { LocalMemoryDriver } from "../src/memory.js";

function run(program: Parameters<typeof runtimeRun>[0], opts: Parameters<typeof runtimeRun>[1] = {}) {
  return runtimeRun(program, { ...opts, memory: opts.memory ?? new LocalMemoryDriver() });
}
// now() and take(xs, n): the two kernel builtins. now() is the kernel's own
// clock — settled world-fact, pinned by AGAPE_FIXED_NOW for determinism, and
// a world reach a `pure` body may not observe. take + array `+` concat form
// the rolling-window primitive.
describe("kernel builtins", () => {
  afterEach(() => {
    delete process.env.AGAPE_FIXED_NOW;
  });

  it("now() renders the pinned kernel clock as settled text", async () => {
    process.env.AGAPE_FIXED_NOW = "2026-07-11T13:05:00";
    const prog = `
      prompt text ping;
      agent A {
        when (Prompt p about ping) {
          text stamp = now();
          say(stamp);
        }
      }
      spawn A a; awake a;
    `;
    const res = await run(parse(prog), {
      provider: new MockProvider(() => ({})),
      promptInputs: [{ name: "ping", value: "hi" }],
    });
    expect(res.stdout.join("\n")).toContain("Sat 2026-07-11 01:05 PM");
  });

  it("take + array concat keep a bounded rolling window, newest first", async () => {
    const prog = `
      prompt text ping;
      agent A {
        text[] window;
        window = [];
        when (Prompt p about ping) {
          window = take([p.text] + window, 2);
          say(window);
        }
      }
      spawn A a; awake a;
    `;
    const res = await run(parse(prog), {
      provider: new MockProvider(() => ({})),
      promptInputs: [
        { name: "ping", value: "one" },
        { name: "ping", value: "two" },
        { name: "ping", value: "three" },
      ],
    });
    // After three deliveries the window holds the newest two, one per line.
    expect(res.stdout.at(-1)).toBe("three\ntwo");
  });

  it("len and skip walk a list head-to-tail (the re-dispatch iteration idiom)", async () => {
    const prog = `
      prompt text ping;
      agent A {
        when (Prompt p about ping) {
          text[] xs = ["a", "b", "c"];
          say(len(xs));
          say(take(xs, 1));
          say(skip(xs, 1));
          say(len(skip(xs, 3)));
        }
      }
      spawn A a; awake a;
    `;
    const res = await run(parse(prog), {
      provider: new MockProvider(() => ({})),
      promptInputs: [{ name: "ping", value: "go" }],
    });
    expect(res.stdout).toEqual(["3", "a", "b\nc", "0"]);
  });

  it("arrays interpolate one item per line in prompt text", () => {
    expect(
      render({
        kind: "array",
        items: [
          { kind: "text", v: "User: hi | You: hey", trust: "settled" },
          { kind: "text", v: "User: bye | You: later", trust: "settled" },
        ],
        trust: "settled",
      }),
    ).toBe("User: hi | You: hey\nUser: bye | You: later");
  });

  it("a `pure` function may not read the kernel clock", () => {
    const prog = `
      pure text stamp() { return now(); }
      agent A {}
      spawn A a; awake a;
    `;
    expect(() => check(parse(prog))).toThrow(/pure.*kernel clock|kernel clock.*pure/i);
  });

  // §5b type-safety: a bare assignment to a typed lvalue must thread the target's declared type into
  // the RHS so a `self <- prompt {…}` structured send requests the SAME schema a typed declaration would.
  // Without it the structured path is skipped and a scalar text lands in a typed slot — a silent hole.
  it("assigns a self<-prompt array reply into a pre-declared text[] as an array, not a scalar", async () => {
    const prog = `
      prompt text ping;
      agent A {
        when (Prompt p about ping) {
          text[] xs = [];
          xs = self <- prompt {
            List items about \${p.text}.
          };
          say(f"len=\${len(xs)}");
          say(xs[0]);
        }
      }
      spawn A a; awake a;
    `;
    // MockProvider returns ["ok"] for a text[] structured schema; a bare scalar reply would land as
    // text and crash len(xs), so the handler would produce no output.
    const res = await run(parse(prog), {
      provider: new MockProvider(() => ({})),
      promptInputs: [{ name: "ping", value: "go" }],
    });
    expect(res.stdout).toContain("len=1");
    expect(res.stdout).toContain("ok");
  });

  it("calls to undeclared functions other than the builtins still fail closed", async () => {
    const prog = `
      prompt text ping;
      agent A {
        when (Prompt p about ping) {
          text x = clock();
        }
      }
      spawn A a; awake a;
    `;
    await expect(
      run(parse(prog), { provider: new MockProvider(() => ({})), promptInputs: [{ name: "ping", value: "hi" }] }),
    ).rejects.toThrow(/undeclared function 'clock'|general calls/);
  });
});
