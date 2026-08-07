import { describe, expect, it } from "vitest";
import { windowsCmdCommand, windowsCmdSpawnPlan } from "./harness.js";

describe("production CLI Windows shim", () => {
  it("[P01.windows-cmd] quotes paths with spaces and rejects cmd.exe metacharacters", () => {
    expect(windowsCmdCommand("C:\\Program Files\\Agape\\bin\\agape.cmd", [
      "run", "C:\\review projects\\main.ag", "--json",
    ])).toBe('call "C:\\Program Files\\Agape\\bin\\agape.cmd" "run" "C:\\review projects\\main.ag" "--json"');
    for (const unsafe of ["bad&next", "bad|next", "bad%PATH%", "bad!VAR!", "bad\"quote"] ) {
      expect(() => windowsCmdCommand("C:\\Agape\\agape.cmd", [unsafe])).toThrow(/unsafe cmd\.exe metacharacter/);
    }
    expect(windowsCmdSpawnPlan("C:\\Program Files\\Agape\\bin\\agape.cmd", [
      "run", "C:\\review projects\\main.ag", "--json",
    ], "C:\\Windows\\System32\\cmd.exe")).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", 'call "C:\\Program Files\\Agape\\bin\\agape.cmd" "run" "C:\\review projects\\main.ag" "--json"'],
      shell: false,
    });
  });
});
