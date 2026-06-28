import { describe, it, expect } from "vitest";
import path from "node:path";
import { pickVariant, agentsAndPrompts, safeProjectPath } from "./lib.ts";

describe("pickVariant", () => {
  const vs = ["true", "false"];
  it("matches an exact label", () => expect(pickVariant("true", vs)).toBe("true"));
  it("is case-insensitive and trims", () => expect(pickVariant("  TRUE\n", vs)).toBe("true"));
  it("matches a label embedded in prose", () => expect(pickVariant("The answer is false.", vs)).toBe("false"));
  it("returns null when no label is present", () => expect(pickVariant("maybe", vs)).toBeNull());
  it("works over a multi-variant enum", () =>
    expect(pickVariant("Contradicts", ["Entails", "Contradicts", "Neutral"])).toBe("Contradicts"));
});

describe("agentsAndPrompts", () => {
  it("extracts agents and prompt sensors", () => {
    const src = `
prompt text question;
event Draft(text a);
agent Responder { on awake {} }
agent FactChecker grants { perform Reply } {}
`;
    expect(agentsAndPrompts(src)).toEqual({ agents: ["Responder", "FactChecker"], prompts: ["question"] });
  });
  it("returns empty arrays for a program with neither", () => {
    expect(agentsAndPrompts("int x = 1;")).toEqual({ agents: [], prompts: [] });
  });
});

describe("safeProjectPath (security: path traversal)", () => {
  const root = path.resolve("/tmp/proj");
  it("resolves a normal project file", () => {
    expect(safeProjectPath(root, "main.ag")).toBe(path.join(root, "main.ag"));
    expect(safeProjectPath(root, "agents/a.ag")).toBe(path.join(root, "agents", "a.ag"));
  });
  it("rejects traversal that escapes the root", () => {
    expect(safeProjectPath(root, "../secret.ag")).toBeNull();
    expect(safeProjectPath(root, "../../etc/passwd.ag")).toBeNull();
    expect(safeProjectPath(root, "a/../../b.ag")).toBeNull();
  });
  it("rejects an absolute path outside the root", () => {
    expect(safeProjectPath(root, "/etc/passwd.ag")).toBeNull();
  });
  it("rejects a sibling dir that merely shares the prefix", () => {
    expect(safeProjectPath(root, "../proj-evil/x.ag")).toBeNull();
  });
  it("rejects non-.ag files (e.g. exfiltrating source/config)", () => {
    expect(safeProjectPath(root, "agape.toml")).toBeNull();
    expect(safeProjectPath(root, "main.ag.txt")).toBeNull();
    expect(safeProjectPath(root, "../../.env")).toBeNull();
  });
});
