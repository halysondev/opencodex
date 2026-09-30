import { lstatSync } from "node:fs";
import { posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { packagedResourceCandidates } from "../lib/packaged-resources";
import { isStandaloneBinary, standaloneRoot } from "../lib/standalone";
import { RTK_ARTIFACTS, rtkTarget } from "./assets";

export class RtkBundleError extends Error {}
export interface RtkLocationOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  /** Test/build seam. Normal source/npm resolution remains inside this package. */
  packageRoot?: string;
  /** Test seam for the canonical compiled-executable directory. */
  standaloneDir?: string;
}

export function bundledRtkCandidates(options: RtkLocationOptions = {}): string[] {
  const platform = options.platform ?? process.platform;
  const target = rtkTarget(platform, options.arch ?? process.arch);
  if (!target) return [];
  const artifact = RTK_ARTIFACTS[target];
  const root = options.standaloneDir ?? (isStandaloneBinary() ? standaloneRoot() : undefined);
  if (root !== undefined) return packagedResourceCandidates(root, ["rtk", target, artifact.filename], platform);
  const packageRoot = options.packageRoot ?? fileURLToPath(new URL("../../", import.meta.url));
  const path = platform === "win32" ? win32 : posix;
  return [path.join(packageRoot, "vendor", "rtk", "bin", target, artifact.filename)];
}

/** Executables are verified during assembly; platform signing may rewrite their signatures. */
export function resolveBundledRtk(options: RtkLocationOptions = {}): string {
  const candidates = bundledRtkCandidates(options);
  if (!candidates.length) throw new RtkBundleError("Bundled RTK is not available for this operating system and architecture.");
  for (const candidate of candidates) {
    let stat;
    try { stat = lstatSync(candidate, { throwIfNoEntry: false }); }
    catch { throw new RtkBundleError("The bundled RTK executable could not be inspected."); }
    if (!stat) continue;
    if (!stat.isFile() || stat.isSymbolicLink()) throw new RtkBundleError("The bundled RTK entry is not a regular executable.");
    if ((options.platform ?? process.platform) !== "win32" && !(stat.mode & 0o111)) {
      throw new RtkBundleError("The bundled RTK file is not executable; repair the OpenCodex installation.");
    }
    return candidate;
  }
  throw new RtkBundleError("The RTK bundle is missing. Reinstall OpenCodex; source checkouts can run `bun run prepare:rtk`.");
}
