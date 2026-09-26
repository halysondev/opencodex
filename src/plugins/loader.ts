/**
 * Local plugin loader.
 *
 * `ocx start` imports every `*.ts`, `*.js` and `*.mjs` file in `$OPENCODEX_HOME/plugins/`
 * before the server binds, so a plugin's hooks are in place for the first request. A missing
 * directory means no plugins and no work. `OCX_PLUGINS=0` disables loading for one start.
 *
 * A plugin is a module whose default export is `{ name?, setup(ctx) }`. It runs in the proxy
 * process with the operator's credentials, so the loader accepts only files owned by the
 * current user that no other user can write — the same trust boundary as `config.json`.
 * Plugins cannot import ocx internals (a compiled binary keeps them inside `$bunfs`); they
 * receive everything they may use through `OcxPluginContext`.
 *
 * Every failure is contained: a plugin that throws, times out or has the wrong shape is
 * reported and skipped, and the remaining plugins and the proxy start normally.
 */

import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { getConfigDir } from "../config/paths";
import { registerOptionalShutdownHook } from "../lib/optional-shutdown-hooks";
import { registerUpstreamRewriter, type UpstreamRewriter } from "./upstream-hooks";

export type { UpstreamRewriter, UpstreamTarget, UpstreamTransport } from "./upstream-hooks";

export interface OcxPluginContext {
  /** The plugin's own name, as reported in logs. */
  readonly name: string;
  /** `$OPENCODEX_HOME`, for plugins that keep state next to the proxy's. */
  readonly configDir: string;
  /** `$OPENCODEX_HOME/plugins`. */
  readonly pluginDir: string;
  log(message: string): void;
  /** See `src/plugins/upstream-hooks.ts`. Called synchronously on every provider send. */
  registerUpstreamRewriter(rewrite: UpstreamRewriter): void;
  /** Runs once when the proxy shuts down. Must not throw or block. */
  onShutdown(teardown: () => void): void;
}

export interface OcxPlugin {
  name?: string;
  setup(context: OcxPluginContext): void | Promise<void>;
}

export interface PluginLoadResult {
  file: string;
  name: string;
  loaded: boolean;
  error?: string;
}

const PLUGIN_EXTENSIONS = [".ts", ".js", ".mjs"];
const SETUP_TIMEOUT_MS = 5_000;

export function pluginDirectory(): string {
  return join(getConfigDir(), "plugins");
}

function listPluginFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter(entry => !entry.startsWith(".") && !entry.startsWith("_") && !entry.endsWith(".d.ts"))
    .filter(entry => PLUGIN_EXTENSIONS.some(extension => entry.endsWith(extension)))
    .sort()
    .map(entry => join(dir, entry));
}

/** Null when the file is safe to execute, otherwise the reason it is refused. */
export function pluginFileTrustError(file: string): string | null {
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(file);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (!stats.isFile()) return "not a regular file";
  if (process.platform === "win32") return null;
  const uid = process.getuid?.();
  if (uid !== undefined && stats.uid !== uid) return "owned by another user";
  if ((stats.mode & 0o022) !== 0) return "writable by group or others (chmod go-w)";
  return null;
}

function isPlugin(value: unknown): value is OcxPlugin {
  return typeof value === "object" && value !== null && typeof (value as OcxPlugin).setup === "function";
}

async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not finish within ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function loadOcxPlugins(dir = pluginDirectory()): Promise<PluginLoadResult[]> {
  if (process.env["OCX_PLUGINS"] === "0") return [];
  const results: PluginLoadResult[] = [];
  for (const file of listPluginFiles(dir)) {
    const fallbackName = basename(file).replace(/\.(ts|js|mjs)$/, "");
    const refused = pluginFileTrustError(file);
    if (refused) {
      results.push({ file, name: fallbackName, loaded: false, error: `refused: ${refused}` });
      continue;
    }
    const unregister: Array<() => void> = [];
    try {
      const module = await import(pathToFileURL(file).href) as { default?: unknown; plugin?: unknown };
      const plugin = module.default ?? module.plugin;
      if (!isPlugin(plugin)) throw new Error("default export must be { name?, setup(context) }");
      const name = typeof plugin.name === "string" && plugin.name.trim() ? plugin.name.trim() : fallbackName;
      const context: OcxPluginContext = {
        name,
        configDir: getConfigDir(),
        pluginDir: dir,
        log: message => console.log(`[plugin:${name}] ${message}`),
        registerUpstreamRewriter: rewrite => { unregister.push(registerUpstreamRewriter(name, rewrite)); },
        onShutdown: teardown => { unregister.push(registerOptionalShutdownHook(`plugin:${name}`, teardown)); },
      };
      await withTimeout(Promise.resolve(plugin.setup(context)), SETUP_TIMEOUT_MS, `plugin "${name}" setup`);
      results.push({ file, name, loaded: true });
    } catch (error) {
      // A half-initialised plugin must not leave hooks behind.
      for (const undo of unregister) undo();
      results.push({
        file,
        name: fallbackName,
        loaded: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

/** `ocx start` entry: load and print one line per plugin. Never throws. */
export async function loadAndReportOcxPlugins(): Promise<void> {
  try {
    for (const result of await loadOcxPlugins()) {
      if (result.loaded) console.log(`🔌 Plugin loaded: ${result.name}`);
      else console.error(`⚠️  Plugin ${result.name} skipped: ${result.error}`);
    }
  } catch (error) {
    console.error(`⚠️  Plugin loading failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
