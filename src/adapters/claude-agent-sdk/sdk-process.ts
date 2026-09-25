/**
 * The harness process of one Claude Agent SDK turn, spawned and reaped by OpenCodex.
 *
 * The SDK's own spawn is a bare `child_process.spawn` of whatever `pathToClaudeCodeExecutable`
 * names. That leaves two gaps the spawned-CLI families already close in `../coding-agent/turn.ts`:
 * a Windows `claude.cmd` shim (the npm install, and the only `claude` a compiled build can drive)
 * cannot be spawned without `cmd.exe`, and killing the direct child on Windows leaves its
 * descendants running. Routing the spawn through `Options.spawnClaudeCodeProcess` reuses the same
 * `commandInvocation` and taskkill tree kill, and records an exit barrier: the turn is only over
 * once the harness process has actually closed, not once the SDK stopped reading from it.
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { commandInvocation } from "../../lib/win-exec";
import { killWindowsProcessTree, type KillWindowsProcessTreeFn, type SpawnFn } from "../coding-agent/turn";

export interface ClaudeAgentSdkProcessDeps {
  spawn?: SpawnFn;
  platform?: NodeJS.Platform;
  killWindowsProcessTree?: KillWindowsProcessTreeFn;
  /** Receives the harness stderr; a custom spawn takes it over from `Options.stderr`. */
  onStderr?: (chunk: string) => void;
}

export interface ClaudeAgentSdkProcessOwner {
  /** `Options.spawnClaudeCodeProcess` for this turn. */
  spawn(options: SpawnOptions): SpawnedProcess;
  /** Terminate every process this turn spawned that has not exited yet. */
  terminate(): void;
  /** Resolves once every spawned process has closed (or failed to launch). */
  exited(): Promise<void>;
}

export function createClaudeAgentSdkProcessOwner(deps: ClaudeAgentSdkProcessDeps = {}): ClaudeAgentSdkProcessOwner {
  const platform = deps.platform ?? process.platform;
  const spawnFn = deps.spawn ?? nodeSpawn;
  const live = new Set<ChildProcess>();
  const exits: Promise<void>[] = [];

  const kill = (child: ChildProcess): void => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (platform === "win32" && child.pid !== undefined) {
      try {
        (deps.killWindowsProcessTree ?? killWindowsProcessTree)(child.pid);
        return;
      } catch { /* fall back to terminating the direct child */ }
    }
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
  };

  return {
    spawn(options: SpawnOptions): SpawnedProcess {
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(options.env)) {
        if (typeof value === "string") env[key] = value;
      }
      const invocation = commandInvocation(options.command, options.args, platform, { env });
      const child = spawnFn(invocation.file, invocation.args, {
        ...invocation.options,
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      live.add(child);
      const onAbort = (): void => kill(child);
      exits.push(new Promise<void>(resolve => {
        const settle = (): void => {
          live.delete(child);
          options.signal.removeEventListener("abort", onAbort);
          resolve();
        };
        child.once("close", settle);
        // A launch failure has no process to reap and is not guaranteed to emit `close`.
        child.once("error", () => { if (child.pid === undefined) settle(); });
      }));
      options.signal.addEventListener("abort", onAbort, { once: true });
      if (options.signal.aborted) onAbort();
      // The SDK reads stdout itself and never touches stderr of a process it did not spawn, so the
      // owner drains it: forwarded when a sink is set, discarded otherwise so a full pipe cannot stall.
      if (child.stderr) {
        child.stderr.setEncoding("utf8");
        if (deps.onStderr) child.stderr.on("data", deps.onStderr);
        else child.stderr.resume();
      }
      return child as SpawnedProcess;
    },
    terminate(): void {
      for (const child of live) kill(child);
    },
    async exited(): Promise<void> {
      await Promise.all(exits);
    },
  };
}
