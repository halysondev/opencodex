import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { unzipSync } from "fflate";
import { isRtkTarget, RTK_ARTIFACTS, RTK_RELEASE_URL, type RtkArtifact, type RtkTarget } from "../src/rtk/assets";

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export function verifyRtkBytes(bytes: Uint8Array, size: number, digest: string, label: string): void {
  if (bytes.byteLength !== size || sha256(bytes) !== digest) throw new Error(`RTK ${label} failed its pinned size/SHA-256 check`);
}

/** Nothing is extracted to the filesystem: only the exact executable member is accepted. */
export async function extractRtkArchive(bytes: Uint8Array, artifact: RtkArtifact): Promise<Uint8Array> {
  verifyRtkBytes(bytes, artifact.archiveSize, artifact.archiveSha256, "archive");
  let binary: Uint8Array;
  if (artifact.archive.endsWith(".zip")) {
    const files = unzipSync(bytes, { filter: file => file.name === artifact.filename && file.originalSize === artifact.binarySize });
    const entry = files[artifact.filename];
    if (!entry) throw new Error("RTK ZIP does not contain the declared executable");
    binary = entry;
  } else {
    const files = await new Bun.Archive(bytes).files(artifact.filename);
    const entry = files.get(artifact.filename);
    if (!entry || entry.size !== artifact.binarySize) throw new Error("RTK TAR does not contain the declared executable");
    binary = new Uint8Array(await entry.arrayBuffer());
  }
  verifyRtkBytes(binary, artifact.binarySize, artifact.binarySha256, "executable");
  return binary;
}

async function boundedDownload(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.ok || !response.body) throw new Error(`RTK download failed (HTTP ${response.status})`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) throw new Error("RTK download exceeds its declared archive size");
      chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

function writeAtomic(path: string, bytes: Uint8Array, mode: number): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, bytes, { flag: "wx", mode });
    chmodSync(temporary, mode);
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

/** Reject link redirection inside the owned generated tree before creating any file. */
function ownedDirectory(root: string, parts: string[]): string {
  let current = resolve(root);
  for (const part of parts) {
    current = join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error("RTK generated directory is not an owned directory");
    if (!stat) mkdirSync(current);
  }
  return current;
}

export async function prepareBundledRtk({
  repoRoot,
  targets = Object.keys(RTK_ARTIFACTS) as RtkTarget[],
  fetchImpl = fetch,
}: {
  repoRoot: string;
  targets?: readonly RtkTarget[];
  fetchImpl?: typeof fetch;
}): Promise<void> {
  for (const target of targets) {
    if (!isRtkTarget(target)) throw new Error(`Unsupported RTK target: ${target}`);
    const artifact = RTK_ARTIFACTS[target];
    const destination = join(ownedDirectory(repoRoot, ["vendor", "rtk", "bin", target]), artifact.filename);
    const present = lstatSync(destination, { throwIfNoEntry: false });
    if (present?.isFile() && !present.isSymbolicLink()) {
      try {
        verifyRtkBytes(readFileSync(destination), artifact.binarySize, artifact.binarySha256, "cached executable");
        chmodSync(destination, 0o755);
        continue;
      } catch { /* rebuild from the verified archive below */ }
    }
    const cached = join(ownedDirectory(repoRoot, [".tmp", "rtk-archives"]), artifact.archive);
    let archive: Uint8Array | undefined;
    if (existsSync(cached) && lstatSync(cached).isFile() && !lstatSync(cached).isSymbolicLink()) {
      const bytes = readFileSync(cached);
      try { verifyRtkBytes(bytes, artifact.archiveSize, artifact.archiveSha256, "cached archive"); archive = bytes; }
      catch { /* never extract unverified cached bytes */ }
    }
    if (!archive) {
      const response = await fetchImpl(`${RTK_RELEASE_URL}/${artifact.archive}`, {
        signal: AbortSignal.timeout(45_000), headers: { "user-agent": "opencodex-rtk-packager" },
      });
      archive = await boundedDownload(response, artifact.archiveSize);
      verifyRtkBytes(archive, artifact.archiveSize, artifact.archiveSha256, "downloaded archive");
      writeAtomic(cached, archive, 0o644);
    }
    writeAtomic(destination, await extractRtkArchive(archive, artifact), 0o755);
    console.log(`Prepared bundled RTK for ${target}`);
  }
}

/** Standalone and desktop packages consume one target; npm packages contain all targets. */
export async function stageStandaloneRtk(repoRoot: string, output: string, target: string): Promise<string> {
  if (!isRtkTarget(target)) throw new Error(`No RTK executable is declared for standalone target ${target}`);
  await prepareBundledRtk({ repoRoot, targets: [target] });
  const artifact = RTK_ARTIFACTS[target];
  const destination = join(ownedDirectory(output, ["rtk", target]), artifact.filename);
  const binary = readFileSync(join(repoRoot, "vendor", "rtk", "bin", target, artifact.filename));
  verifyRtkBytes(binary, artifact.binarySize, artifact.binarySha256, "staged executable");
  writeAtomic(destination, binary, 0o755);
  for (const name of ["LICENSE", "NOTICE"]) {
    writeAtomic(join(output, "rtk", name), readFileSync(join(repoRoot, "vendor", "rtk", name)), 0o644);
  }
  return destination;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const target = args.length === 2 && args[0] === "--target" ? args[1] : undefined;
  if (args.length && (!target || !isRtkTarget(target))) throw new Error("Usage: bun run prepare:rtk [--target <bun-platform-arch>]");
  await prepareBundledRtk({ repoRoot: resolve(import.meta.dir, ".."), ...(target ? { targets: [target as RtkTarget] } : {}) });
}
