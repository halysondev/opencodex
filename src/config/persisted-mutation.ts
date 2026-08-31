import type { OcxConfig } from "../types";
import { projectCustomModelCatalogMigration } from "../codex/custom-model-catalog-migration";
import { readConfigFileSnapshot, type ConfigFileSnapshot } from "./diagnostics";
import { bumpGenerationForCooperatingConfigWrite, withConfigMutationLockSync } from "./mutation-lock";
import { persistConfigUnlocked } from "./persist-unlocked";
import { projectConfigRebaseProvenance } from "./rebase-provenance";

export type PersistedConfigMutation<T> = {
  changed: boolean;
  value: T;
};

export type PersistedConfigMutationOutcome<T> =
  | { status: "committed" | "unchanged"; value: T }
  | { status: "unavailable"; reason: "missing" | "invalid" | "conflict" };

export type PersistedConfigMutationOptions = {
  /**
   * Explicit opt-in for an interactive setting that is safe to be the first
   * writer of config.json. The initializer runs only while the shared lock is
   * held and only if config.json is still absent.
   */
  initializeMissingConfig?: () => OcxConfig;
};

const CONFIG_MUTATION_MAX_REBASE_ATTEMPTS = 3;
let persistedConfigMutationBeforeCommitForTests: (() => void) | null = null;

/** Test-only one-shot seam: inject a competing mutation after the first decision, before freshness revalidation. */
export function setPersistedConfigMutationBeforeCommitForTests(hook: (() => void) | null): void {
  persistedConfigMutationBeforeCommitForTests = hook;
}

function unavailableConfigMutationReason(snapshot: ConfigFileSnapshot): "missing" | "invalid" {
  return snapshot.diagnostics.source === "default" ? "missing" : "invalid";
}

/**
 * Patch a schema-valid on-disk config under the shared mutation lock. Cooperating writers are
 * serialized; the callback is rerun on the newest snapshot so observed direct byte changes rebase
 * and credential predicates are re-evaluated immediately before the atomic commit. A writer that
 * ignores the coordinator can still change bytes after the final check because the filesystem has
 * no portable conditional rename. Missing or malformed config fails closed unless the caller
 * explicitly supplies an initializer for a first interactive write; malformed files are never
 * recreated from a prior snapshot.
 */
export function mutatePersistedConfig<T>(
  mutate: (config: OcxConfig) => PersistedConfigMutation<T>,
  options: PersistedConfigMutationOptions = {},
): PersistedConfigMutationOutcome<T> {
  const observed = readConfigFileSnapshot();
  let sawPersistedConfig = observed.diagnostics.source === "file" && observed.raw !== undefined;
  const canInitializeMissingConfig = options.initializeMissingConfig !== undefined;
  const canMutateSnapshot = (snapshot: ConfigFileSnapshot): boolean =>
    (snapshot.diagnostics.source === "file" && snapshot.raw !== undefined)
    || (snapshot.diagnostics.source === "default" && canInitializeMissingConfig && !sawPersistedConfig);
  const configForSnapshot = (snapshot: ConfigFileSnapshot): OcxConfig => {
    if (snapshot.diagnostics.source === "file" && snapshot.raw !== undefined) {
      return snapshot.diagnostics.config;
    }
    const initializer = options.initializeMissingConfig;
    if (!initializer) throw new Error("Missing config initializer is unavailable.");
    return initializer();
  };

  // Avoid creating/opening the coordinator database for a read-path update that already knows
  // there is no valid config and no caller explicitly owns first-run initialization. The same
  // check runs again under the transaction for authority.
  if (!canMutateSnapshot(observed)) {
    return { status: "unavailable", reason: unavailableConfigMutationReason(observed) };
  }
  return withConfigMutationLockSync(() => {
    let base = readConfigFileSnapshot();
    for (let attempt = 0; attempt < CONFIG_MUTATION_MAX_REBASE_ATTEMPTS; attempt += 1) {
      if (base.diagnostics.source === "file" && base.raw !== undefined) sawPersistedConfig = true;
      if (!canMutateSnapshot(base)) {
        return { status: "unavailable", reason: unavailableConfigMutationReason(base) };
      }

      const tentativeConfig = structuredClone(configForSnapshot(base));
      const tentative = mutate(tentativeConfig);
      if (!tentative.changed) return { status: "unchanged", value: tentative.value };

      const hook = persistedConfigMutationBeforeCommitForTests;
      persistedConfigMutationBeforeCommitForTests = null;
      hook?.();

      const latest = readConfigFileSnapshot();
      if (latest.diagnostics.source === "file" && latest.raw !== undefined) sawPersistedConfig = true;
      if (!canMutateSnapshot(latest)) {
        return { status: "unavailable", reason: unavailableConfigMutationReason(latest) };
      }
      if (latest.raw !== base.raw) {
        base = latest;
        continue;
      }

      // Re-run against a fresh clone even when config bytes are unchanged: a Codex credential
      // generation lives in a separate file and may have changed at the injected seam.
      const confirmedConfig = structuredClone(configForSnapshot(latest));
      const confirmed = mutate(confirmedConfig);
      if (!confirmed.changed) return { status: "unchanged", value: confirmed.value };

      const commitBase = readConfigFileSnapshot();
      if (commitBase.diagnostics.source === "file" && commitBase.raw !== undefined) sawPersistedConfig = true;
      if (!canMutateSnapshot(commitBase)) {
        return { status: "unavailable", reason: unavailableConfigMutationReason(commitBase) };
      }
      if (commitBase.raw !== latest.raw) {
        base = commitBase;
        continue;
      }

      const projected = projectCustomModelCatalogMigration(
        commitBase.diagnostics.config,
        projectConfigRebaseProvenance(confirmedConfig),
      );
      if (persistConfigUnlocked(projected)) bumpGenerationForCooperatingConfigWrite();
      return { status: "committed", value: confirmed.value };
    }
    return { status: "unavailable", reason: "conflict" };
  });
}
