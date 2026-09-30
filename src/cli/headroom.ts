import {
  CliUsageError, printData, rejectArgs, runCliAction, runtimeRequest,
  summaryLines, takeFlag, takeOption, type RuntimeApiDeps,
} from "./runtime-api";

const USAGE = "Usage: ocx headroom [status|stats|config] [--enabled <true|false>] [--base-url <url>] [--json]";

/** Headless access to the same optional sidecar settings and metrics as the dashboard. */
export async function handleHeadroomCommand(argv: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  return runCliAction(async () => {
    const args = [...argv];
    const wantsJson = takeFlag(args, "--json");
    const sub = args[0] && !args[0].startsWith("--") ? args.shift()! : "status";
    if (sub === "status" || sub === "stats") {
      rejectArgs(args, USAGE);
      const result = await runtimeRequest(sub === "stats" ? "/api/headroom/stats" : "/api/headroom", {}, deps);
      printData(result, wantsJson, summaryLines(result));
      return;
    }
    if (sub !== "config") throw new CliUsageError(`unknown headroom command ${sub}`, USAGE);
    const enabled = takeOption(args, "--enabled");
    const baseUrl = takeOption(args, "--base-url");
    rejectArgs(args, USAGE);
    if (enabled !== undefined && enabled !== "true" && enabled !== "false") {
      throw new CliUsageError("--enabled must be true or false", USAGE);
    }
    const body = {
      ...(enabled === undefined ? {} : { enabled: enabled === "true" }),
      ...(baseUrl === undefined ? {} : { baseUrl }),
    };
    const result = await runtimeRequest("/api/headroom", Object.keys(body).length ? {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    } : {}, deps);
    printData(result, wantsJson, summaryLines(result));
  });
}
