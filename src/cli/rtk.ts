import { resolveBundledRtk, RtkBundleError } from "../rtk/bundle";

interface RtkChild {
  exited: Promise<number>;
  kill(signal: NodeJS.Signals): void;
}
export interface RtkCommandDeps {
  resolveBinary?: () => string;
  spawn?: (argv: string[]) => RtkChild;
}

/** Native argv/stdin/stdout/stderr forwarding; the proxy and client configuration are untouched. */
export async function handleRtkCommand(argv: string[], deps: RtkCommandDeps = {}): Promise<number> {
  let child: RtkChild;
  try {
    const binary = (deps.resolveBinary ?? resolveBundledRtk)();
    const spawn = deps.spawn ?? (args => Bun.spawn(args, { stdin: "inherit", stdout: "inherit", stderr: "inherit" }));
    child = spawn([binary, ...argv]);
  } catch (error) {
    // A spawn error can contain the user's command arguments. Never echo those here.
    console.error(error instanceof RtkBundleError ? error.message : "The bundled RTK process could not be started.");
    return 1;
  }
  const forwardInterrupt = () => { try { child.kill("SIGINT"); } catch { /* already exited */ } };
  const forwardTerminate = () => { try { child.kill("SIGTERM"); } catch { /* already exited */ } };
  process.on("SIGINT", forwardInterrupt);
  process.on("SIGTERM", forwardTerminate);
  try {
    const code = await child.exited;
    return code < 0 ? 128 + Math.abs(code) : code;
  } finally {
    process.off("SIGINT", forwardInterrupt);
    process.off("SIGTERM", forwardTerminate);
  }
}
