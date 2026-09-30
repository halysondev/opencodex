import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { zipSync } from "fflate";
import { extractRtkArchive, prepareBundledRtk } from "../../scripts/prepare-rtk";
import { RTK_ARTIFACTS, RTK_VERSION, type RtkArtifact } from "../../src/rtk/assets";
import { repoPath } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "ocx-rtk-packaging-")); });
afterEach(() => { removeTreeWithRetry(root); });
const digest = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");
function artifact(archive: Uint8Array, binary: Uint8Array, zip = false): RtkArtifact {
  return { archive: zip ? "fixture.zip" : "fixture.tar.gz", filename: zip ? "rtk.exe" : "rtk",
    archiveSha256: digest(archive), archiveSize: archive.byteLength,
    binarySha256: digest(binary), binarySize: binary.byteLength };
}

test("TAR and Windows ZIP require both the archive and executable digests", async () => {
  const binary = new TextEncoder().encode("synthetic executable fixture");
  const tar = await new Bun.Archive({ rtk: binary }).bytes();
  expect(await extractRtkArchive(tar, artifact(tar, binary))).toEqual(binary);
  const zip = zipSync({ "rtk.exe": binary });
  expect(await extractRtkArchive(zip, artifact(zip, binary, true))).toEqual(binary);
  await expect(extractRtkArchive(zip, { ...artifact(zip, binary, true), archiveSha256: "0".repeat(64) })).rejects.toThrow("archive failed");
  await expect(extractRtkArchive(zip, { ...artifact(zip, binary, true), binarySha256: "0".repeat(64) })).rejects.toThrow("executable failed");
});
test("an archive cannot substitute a traversal path for the declared member", async () => {
  const binary = new TextEncoder().encode("fixture");
  const zip = zipSync({ "../rtk.exe": binary });
  await expect(extractRtkArchive(zip, artifact(zip, binary, true))).rejects.toThrow("does not contain");
  expect(existsSync(join(root, "rtk.exe"))).toBe(false);
});
test("a bad download is never installed or retained as a verified cache entry", async () => {
  const urls: string[] = [];
  const fetchImpl = (async input => { urls.push(String(input)); return new Response("unverified bytes"); }) as typeof fetch;
  await expect(prepareBundledRtk({ repoRoot: root, targets: ["bun-linux-x64"], fetchImpl })).rejects.toThrow("pinned size/SHA-256");
  expect(urls).toEqual([`https://github.com/rtk-ai/rtk/releases/download/v${RTK_VERSION}/${RTK_ARTIFACTS["bun-linux-x64"].archive}`]);
  expect(existsSync(join(root, "vendor", "rtk", "bin", "bun-linux-x64", "rtk"))).toBe(false);
  expect(existsSync(join(root, ".tmp", "rtk-archives", RTK_ARTIFACTS["bun-linux-x64"].archive))).toBe(false);
});
test("download size is bounded before extraction", async () => {
  const fetchImpl = (async () => new Response(new Uint8Array(RTK_ARTIFACTS["bun-linux-x64"].archiveSize + 1))) as typeof fetch;
  await expect(prepareBundledRtk({ repoRoot: root, targets: ["bun-linux-x64"], fetchImpl })).rejects.toThrow("exceeds its declared archive size");
});
test.skipIf(process.platform === "win32")("a generated directory symlink is rejected before network access", async () => {
  const other = join(root, "other"); mkdirSync(other);
  symlinkSync(other, join(root, "vendor"));
  let fetched = false;
  const fetchImpl = (async () => { fetched = true; throw new Error("unexpected network"); }) as typeof fetch;
  await expect(prepareBundledRtk({ repoRoot: root, targets: ["bun-linux-x64"], fetchImpl })).rejects.toThrow("not an owned directory");
  expect(fetched).toBe(false);
});
test("npm, standalone and desktop ship the executable and its redistribution notices", () => {
  const pkg = JSON.parse(readFileSync(repoPath("package.json"), "utf8"));
  for (const path of ["vendor/rtk/bin", "vendor/rtk/LICENSE", "vendor/rtk/NOTICE"]) expect(pkg.files).toContain(path);
  expect(readFileSync(repoPath("vendor/rtk/LICENSE"), "utf8")).toContain("Apache License");
  expect(readFileSync(repoPath("vendor/rtk/NOTICE"), "utf8")).toContain(RTK_VERSION);
  const config = JSON.parse(readFileSync(repoPath("desktop/src-tauri/tauri.conf.json"), "utf8"));
  expect(config.bundle.resources["resources/rtk"]).toBe("rtk");
  const release = readFileSync(repoPath(".github/workflows/release.yml"), "utf8");
  expect(release).toContain("ocx.exe,gui,keyring,rtk");
  expect(release).toContain("ocx gui keyring rtk");
  expect(release).toContain("rtk_tools=(desktop/src-tauri/resources/rtk/bun-darwin-*/rtk)");
  expect(release).toContain('addons+=("${rtk_tools[@]}")');
  expect(release).toContain('"$binary" rtk --version');
  expect(readFileSync(repoPath("desktop/scripts/verify-linux-sidecar.sh"), "utf8")).toContain('"$sidecar" rtk --version');
});
