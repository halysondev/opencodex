import { expect, spyOn, test } from "bun:test";
import { handleRtkCommand } from "../../src/cli/rtk";
import { parseCliHead, runCli } from "../../src/cli/root";
import * as preflight from "../../src/cli/codex-shim-autorestore";
import { RtkBundleError } from "../../src/rtk/bundle";
import { findCommand } from "../../src/cli/registry";
import { DISPATCH_COMMANDS } from "../../src/cli/dispatch";

test.each([{ tail: ["--version"] }, { tail: ["--help"] }, { tail: ["git", "status", "--", "file with spaces"] }])("RTK owns its help/version and command arguments: %j", ({ tail }) => {
  expect(parseCliHead(["rtk", ...tail])).toEqual({ kind: "command", command: "rtk", args: ["rtk", ...tail] });
});
test("RTK dispatch skips the Codex shim preflight", async () => {
  const restore = spyOn(preflight, "maybeAutoRestoreCodexShim").mockImplementation(() => { throw new Error("unexpected preflight"); });
  try {
    expect((await runCli(["rtk", "git", "status"])).command).toBe("rtk");
    expect(restore).not.toHaveBeenCalled();
  } finally { restore.mockRestore(); }
});
test("argv stays an argument vector and the delegated exit code survives", async () => {
  const argv = ["proxy", "command", "argument with spaces", "; not a shell program", "--json"];
  const seen: string[][] = [];
  const signalsBefore = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  expect(await handleRtkCommand(argv, {
    resolveBinary: () => "/owned/package/rtk",
    spawn: args => { seen.push(args); return { exited: Promise.resolve(23), kill() {} }; },
  })).toBe(23);
  expect(seen).toEqual([["/owned/package/rtk", ...argv]]);
  expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(signalsBefore);
});
test("a missing bundle fails without attempting a PATH fallback", async () => {
  const error = spyOn(console, "error").mockImplementation(() => {});
  let spawned = false;
  try {
    expect(await handleRtkCommand([], {
      resolveBinary: () => { throw new RtkBundleError("missing owned bundle"); },
      spawn: () => { spawned = true; return { exited: Promise.resolve(0), kill() {} }; },
    })).toBe(1);
    expect(spawned).toBe(false);
    expect(error.mock.calls.flat().join(" ")).toContain("missing owned bundle");
  } finally { error.mockRestore(); }
});
test("spawn failures never echo potentially sensitive command arguments", async () => {
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await handleRtkCommand(["sensitive-command-argument"], {
      resolveBinary: () => "/owned/package/rtk",
      spawn: () => { throw new Error("sensitive-command-argument"); },
    })).toBe(1);
    expect(error.mock.calls.flat().join(" ")).not.toContain("sensitive-command-argument");
  } finally { error.mockRestore(); }
});
test("RTK is a discoverable command with a dispatch runner", () => {
  expect(findCommand("rtk")?.usage).toBe("ocx rtk <args...>");
  expect(DISPATCH_COMMANDS).toContain("rtk");
});
