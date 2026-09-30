import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bundledRtkCandidates, resolveBundledRtk } from "../../src/rtk/bundle";
import { RTK_ARTIFACTS, rtkTarget } from "../../src/rtk/assets";
import { standaloneTargets } from "../../scripts/standalone-targets";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "ocx-rtk-bundle-")); });
afterEach(() => { removeTreeWithRetry(root); });

test("every released standalone platform has a pinned RTK executable", () => {
  expect(Object.keys(RTK_ARTIFACTS).sort()).toEqual([...standaloneTargets].sort());
  expect(rtkTarget("freebsd", "x64")).toBeUndefined();
  expect(rtkTarget("linux", "riscv64")).toBeUndefined();
});
test("npm resolution stays inside its package, including simulated Windows paths", () => {
  expect(bundledRtkCandidates({ packageRoot: "/installed/package", platform: "linux", arch: "x64" }))
    .toEqual(["/installed/package/vendor/rtk/bin/bun-linux-x64/rtk"]);
  expect(bundledRtkCandidates({ packageRoot: "C:\\installed\\package", platform: "win32", arch: "x64" }))
    .toEqual(["C:\\installed\\package\\vendor\\rtk\\bin\\bun-windows-x64\\rtk.exe"]);
});
test("desktop layouts use executable-owned resources and keep architecture selection", () => {
  expect(bundledRtkCandidates({ standaloneDir: "/Applications/OpenCodex.app/Contents/MacOS", platform: "darwin", arch: "arm64" })).toEqual([
    "/Applications/OpenCodex.app/Contents/MacOS/rtk/bun-darwin-arm64/rtk",
    "/Applications/OpenCodex.app/Contents/Resources/rtk/bun-darwin-arm64/rtk",
  ]);
  expect(bundledRtkCandidates({ standaloneDir: "/bundle/usr/bin", platform: "linux", arch: "x64" })).toEqual([
    "/bundle/usr/bin/rtk/bun-linux-x64/rtk", "/bundle/usr/lib/OpenCodex/rtk/bun-linux-x64/rtk",
  ]);
  expect(bundledRtkCandidates({ standaloneDir: "/opt/ocx", platform: "linux", arch: "arm64" })).toEqual(["/opt/ocx/rtk/bun-linux-arm64/rtk"]);
});
test("a missing package executable does not resolve the workstation's separate RTK", () => {
  expect(() => resolveBundledRtk({ packageRoot: root, platform: "linux", arch: "x64" })).toThrow("bundle is missing");
});
test("a packaged regular executable is usable and a non-executable file is refused", () => {
  const target = rtkTarget(process.platform, process.arch)!;
  const directory = join(root, "vendor", "rtk", "bin", target);
  mkdirSync(directory, { recursive: true });
  const binary = join(directory, RTK_ARTIFACTS[target].filename);
  writeFileSync(binary, "fixture", { mode: 0o755 });
  expect(resolveBundledRtk({ packageRoot: root })).toBe(binary);
  if (process.platform !== "win32") {
    chmodSync(binary, 0o644);
    expect(() => resolveBundledRtk({ packageRoot: root })).toThrow("not executable");
  }
});
test.skipIf(process.platform === "win32")("a symlink cannot replace the owned executable", () => {
  const directory = join(root, "vendor", "rtk", "bin", "bun-linux-x64");
  mkdirSync(directory, { recursive: true });
  const other = join(root, "other"); writeFileSync(other, "fixture", { mode: 0o755 });
  symlinkSync(other, join(directory, "rtk"));
  expect(() => resolveBundledRtk({ packageRoot: root, platform: "linux", arch: "x64" })).toThrow("not a regular executable");
});
