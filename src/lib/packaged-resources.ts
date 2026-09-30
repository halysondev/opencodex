import { posix, win32 } from "node:path";

/** Must match Tauri productName, which owns Linux's usr/lib resource directory. */
export const PACKAGED_DESKTOP_PRODUCT_NAME = "OpenCodex";

/** Fixed executable-owned locations; cwd and PATH never contribute a candidate. */
export function packagedResourceCandidates(
  root: string,
  segments: readonly string[],
  platform: NodeJS.Platform,
): string[] {
  const { basename, dirname, join, resolve } = platform === "win32" ? win32 : posix;
  const executableDir = resolve(root);
  const adjacent = join(executableDir, ...segments);
  if (platform === "linux") {
    const usrDir = dirname(executableDir);
    return basename(executableDir) === "bin" && basename(usrDir) === "usr"
      ? [adjacent, join(usrDir, "lib", PACKAGED_DESKTOP_PRODUCT_NAME, ...segments)]
      : [adjacent];
  }
  return platform === "darwin"
    ? [adjacent, join(executableDir, "..", "Resources", ...segments)]
    : [adjacent];
}
