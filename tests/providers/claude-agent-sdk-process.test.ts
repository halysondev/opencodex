import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, SpawnOptions as NodeSpawnOptions } from "node:child_process";
import type { SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { createClaudeAgentSdkProcessOwner } from "../../src/adapters/claude-agent-sdk/sdk-process";
import type { SpawnFn } from "../../src/adapters/coding-agent/turn";

interface FakeChild {
  child: ChildProcess;
  signals: string[];
  exit(): void;
}

function fakeChild(pid = 4242): FakeChild {
  const emitter = new EventEmitter();
  const signals: string[] = [];
  const state = { exitCode: null as number | null };
  const child = Object.assign(emitter, {
    pid,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: false,
    signalCode: null,
    get exitCode() { return state.exitCode; },
    kill(signal: string) { signals.push(signal); return true; },
  }) as unknown as ChildProcess;
  return {
    child,
    signals,
    exit() {
      state.exitCode = 0;
      emitter.emit("close", 0, null);
    },
  };
}

function recordingSpawn(fake: FakeChild): { spawn: SpawnFn; calls: { file: string; args: readonly string[]; options: NodeSpawnOptions }[] } {
  const calls: { file: string; args: readonly string[]; options: NodeSpawnOptions }[] = [];
  return {
    calls,
    spawn: (file, args, options) => {
      calls.push({ file, args, options });
      return fake.child;
    },
  };
}

function sdkSpawnOptions(signal: AbortSignal, command = "/opt/claude/claude"): SpawnOptions {
  return { command, args: ["--output-format", "stream-json"], cwd: "/tmp/scratch", env: { HOME: "/home/u", DROP: undefined }, signal };
}

describe("claude-agent-sdk process owner", () => {
  test("spawns the harness with the SDK's argv, cwd and a defined-only env", () => {
    const fake = fakeChild();
    const spawn = recordingSpawn(fake);
    const owner = createClaudeAgentSdkProcessOwner({ spawn: spawn.spawn, platform: "linux" });
    owner.spawn(sdkSpawnOptions(new AbortController().signal));
    expect(spawn.calls).toHaveLength(1);
    expect(spawn.calls[0]!.file).toBe("/opt/claude/claude");
    expect(spawn.calls[0]!.args).toEqual(["--output-format", "stream-json"]);
    expect(spawn.calls[0]!.options).toMatchObject({ cwd: "/tmp/scratch", env: { HOME: "/home/u" }, windowsHide: true });
    expect(spawn.calls[0]!.options.env).not.toHaveProperty("DROP");
  });

  test("a Windows cmd shim runs through cmd.exe instead of a bare spawn", () => {
    const fake = fakeChild();
    const spawn = recordingSpawn(fake);
    const owner = createClaudeAgentSdkProcessOwner({ spawn: spawn.spawn, platform: "win32" });
    owner.spawn(sdkSpawnOptions(new AbortController().signal, "C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd"));
    expect(spawn.calls[0]!.file).toMatch(/cmd(\.exe)?$/i);
    expect(spawn.calls[0]!.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(spawn.calls[0]!.options).toMatchObject({ windowsVerbatimArguments: true });
  });

  test("abort kills the whole tree on Windows and exited() waits for the observed close", async () => {
    const fake = fakeChild(777);
    const killed: number[] = [];
    const owner = createClaudeAgentSdkProcessOwner({
      spawn: recordingSpawn(fake).spawn,
      platform: "win32",
      killWindowsProcessTree: pid => { killed.push(pid); },
    });
    const controller = new AbortController();
    owner.spawn(sdkSpawnOptions(controller.signal, "C:\\claude\\claude.exe"));
    let settled = false;
    const exited = owner.exited().then(() => { settled = true; });
    controller.abort();
    expect(killed).toEqual([777]);
    await Promise.resolve();
    expect(settled).toBe(false);
    fake.exit();
    await exited;
    expect(settled).toBe(true);
  });

  test("terminate() signals a live POSIX harness and skips one that already exited", () => {
    const live = fakeChild();
    const owner = createClaudeAgentSdkProcessOwner({ spawn: recordingSpawn(live).spawn, platform: "darwin" });
    owner.spawn(sdkSpawnOptions(new AbortController().signal));
    owner.terminate();
    expect(live.signals).toEqual(["SIGTERM"]);
    live.exit();
    owner.terminate();
    expect(live.signals).toEqual(["SIGTERM"]);
  });

  test("forwards harness stderr to the turn sink", async () => {
    const fake = fakeChild();
    const chunks: string[] = [];
    const owner = createClaudeAgentSdkProcessOwner({ spawn: recordingSpawn(fake).spawn, platform: "linux", onStderr: c => chunks.push(c) });
    owner.spawn(sdkSpawnOptions(new AbortController().signal));
    (fake.child.stderr as PassThrough).write("boom\n");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(chunks.join("")).toBe("boom\n");
  });
});
