import { createHash } from "node:crypto";
import type { OcxConfig } from "../types";
import { readConfigAdmissionSnapshot } from "./diagnostics";
import { projectConfigRebaseProvenance } from "./rebase-provenance";

// SHA-256 of the config bytes the running process last loaded or wrote (armed at server
// start, refreshed on every changed in-process save). Compared to the current file digest
// by `ocx status` / the dashboard to warn when config.json changed without a reload.
// Only the server admission load (loadConfig({ captureResident: true })) arms this
// identity; incidental loads during runtime must not wipe it.
let residentConfigSha256: string | null = null;
/** Whether the resident identity came from a real config.json or from serving defaults. */
let residentConfigSource: "file" | "default" | null = null;

export interface ConfigDivergenceStatus {
  /** SHA-256 of the config bytes the running process last loaded or wrote. */
  residentVersion: string | null;
  /** SHA-256 of the current config.json bytes on disk (null when unreadable). */
  diskVersion: string | null;
  /** True when a restart would serve something different: bytes changed, a file-backed
   *  resident lost its file, or a defaults-backed resident gained a config.json. */
  diverged: boolean;
}

/**
 * Compare the running process's resident config identity to the current file. A CLI
 * process without an armed live config reports `residentVersion: null` and never claims
 * divergence; only the proxy process can answer this truthfully.
 */
export function readConfigDivergenceStatus(): ConfigDivergenceStatus {
  const admission = readConfigAdmissionSnapshot();
  const diskVersion = admission.kind === "read" ? admission.contentSha256 : null;
  const diskFile = admission.kind === "read";
  let diverged = false;
  if (residentConfigSource === "file" && residentConfigSha256 !== null) {
    // A file-backed resident diverges when the file vanished/unreadable or its
    // bytes differ: a restart would serve something else.
    diverged = !diskFile || diskVersion !== residentConfigSha256;
  } else if (residentConfigSource === "default") {
    // A defaults-backed resident diverges when a config.json now exists.
    diverged = diskFile;
  }
  return {
    residentVersion: residentConfigSha256,
    diskVersion,
    diverged,
  };
}

/**
 * Arm the resident identity from what loadConfig() actually observed. `fileBytes` is the
 * raw byte content the process parsed (a leading BOM included, so the digest matches the
 * admission digest of the same bytes); null means no config.json exists and the process
 * is serving defaults, and a reload after deletion must not retain the old identity.
 */
export function armResidentFromLoad(fileBytes: Uint8Array | null): void {
  if (fileBytes === null) {
    residentConfigSha256 = null;
    residentConfigSource = "default";
    return;
  }
  residentConfigSha256 = createHash("sha256").update(fileBytes).digest("hex");
  residentConfigSource = "file";
}

/**
 * A load that fell back to getDefaultConfig() records a defaults-backed resident so a
 * later repair is reported as divergent.
 */
export function armResidentFromDefaults(): void {
  residentConfigSha256 = null;
  residentConfigSource = "default";
}

/** Test-only seam: reset the resident identity so isolated test files cannot leak state. */
export function setResidentConfigSha256ForTests(value: string | null): void {
  residentConfigSha256 = value;
  residentConfigSource = value === null ? null : "file";
}

/**
 * Re-anchor the resident identity to the exact serialized served snapshot.
 *
 * Disk-first mutations (\`mutatePersistedConfig\`) deliberately skip the resident
 * refresh because the server has not adopted their document yet. Adopters that
 * then mirror the committed change into the long-lived config must call this so
 * \`ocx status\` / the dashboard stop claiming divergence once disk matches what
 * the running process actually serves. No-op when no identity is armed (CLI
 * processes cannot truthfully claim divergence).
 */
export function refreshResidentConfigIdentity(config: OcxConfig): void {
  if (residentConfigSha256 === null) return;
  anchorResidentToServed(config);
}

/**
 * Keep the resident identity bound to the SERVED document, not the merged bytes:
 * withPreservedDiskOnlyProviders() folds hand-added disk rows into the file, but
 * those rows are still unrouted until the process reloads. Hashing the pre-merge
 * config keeps diverged=true for exactly that gap (and matches the file hash when
 * there is nothing disk-only to preserve). Uses the same projection as the
 * committed bytes: unsorted deletedTopLevelKeys in the runtime object must not
 * produce a resident digest different from the file.
 */
export function anchorResidentToServed(servedSnapshot: OcxConfig): void {
  residentConfigSource = "file";
  residentConfigSha256 = createHash("sha256").update(
    JSON.stringify(projectConfigRebaseProvenance(servedSnapshot), null, 2) + "\n",
  ).digest("hex");
}

/**
 * A cooperating writer can canonicalize the served document to the exact bytes an
 * unchanged save would produce. When the served snapshot itself serializes to those
 * bytes, the stale resident digest can be re-anchored; when disk-only preserved
 * rows or a next-start binding make the served serialization differ from the
 * file, divergence must stay visible.
 */
export function reanchorResidentIfServedMatchesBytes(servedSnapshot: OcxConfig, bytes: string): void {
  const servedBytes = JSON.stringify(projectConfigRebaseProvenance(servedSnapshot), null, 2) + "\n";
  if (servedBytes === bytes) anchorResidentToServed(servedSnapshot);
}
