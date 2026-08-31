import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { OcxConfig } from "./types";
import { configReasoningPinsConfigError } from "./config/provider-validation";
import { recordOwnedConfigPath } from "./lib/config-ownership";
import { assertNotRealHomeUnderTest } from "./lib/test-home-guard";
import {
  adoptCustomModelCatalogMigration,
  projectCustomModelCatalogMigration,
} from "./codex/custom-model-catalog-migration";
import { refreshConfigDerivedRegistries } from "./config/derived-registries";
import {
  clearPendingConfigDeletions,
  projectConfigRebaseProvenance,
} from "./config/rebase-provenance";
import { getConfigDir, getConfigPath, hardenConfigDir } from "./config/paths";
export { DEFAULT_SUBAGENT_MODELS } from "./config/subagent-models";
export {
  AtomicWriteResidualTempError,
  AtomicWriteSecretResidualError,
  atomicWriteFile,
  atomicWriteFileAsync,
  renameAtomicFile,
  resolveWriteTarget,
  type AtomicRenameIO,
  type AtomicWriteAsyncIO,
  type AtomicWriteAsyncTestSeam,
  type AtomicWriteIO,
} from "./config/atomic-write";
export { expandUserPath, getConfigDir, getConfigPath, hardenConfigDir } from "./config/paths";
export {
  getPidPath,
  getRuntimePortPath,
  isOcxStartCommandLine,
  ocxStartProcessCacheSizeForTests,
  parsePidFile,
  readAlivePid,
  readPid,
  readPidFileValue,
  readRuntimePort,
  removePid,
  removePidIfValueIs,
  removeRuntimePort,
  removeRuntimePortIfPidIs,
  setOcxStartProcessCacheForTests,
  setOcxStartProcessProbeForTests,
  setProcessCommandLineExecForTests,
  setProcessCommandLinePlatformForTests,
  sweepDeadOcxStartProcessCache,
  verifyPidIdentity,
  writePid,
  writeRuntimePort,
  type RuntimePortState,
} from "./config/process-state";
export { deleteConfigTopLevelKey } from "./config/rebase-provenance";
export {
  mutatePersistedConfig,
  setPersistedConfigMutationBeforeCommitForTests,
  type PersistedConfigMutation,
  type PersistedConfigMutationOutcome,
} from "./config/persisted-mutation";
export { isValidProviderName, hasOwnProvider } from "./config/provider-name";
export {
  apiKeyTransportConfigError,
  booleanRecordConfigError,
  modelAdapterRecordConfigError,
  modelDisplayNamesConfigError,
  autoReviewModelOverridesConfigError,
  autoReviewModelTargetConfigError,
  nonBlankStringArrayConfigError,
  normalizeNonBlankStringArray,
  normalizeAutoReviewModelOverrides,
  positiveIntegerConfigError,
  positiveIntegerRecordConfigError,
  providerBaseUrlConfigError,
  providerHeadersConfigError,
  reasoningSummaryDeliveryRecordConfigError,
  upstreamHttpVersionConfigError,
} from "./config/provider-validation";
export { reconcileConfigWarningMemos } from "./config/warn-memo";
export {
  OpenAiTierBackupCleanupError,
  OpenAiTierBackupRollbackError,
  OpenAiTierBackupCollisionError,
  OpenAiTierRollbackPreserveError,
  OpenAiTierBackupSecretResidualError,
  classifyOpenAiTierBackup,
  backupConfigBeforeOpenAiTierMigration,
  preserveOpenAiTierRollbackSnapshot,
  type OpenAiTierBackupIO,
  type OpenAiTierRollbackPreserveIO,
} from "./config/openai-tier-backup";
export {
  websocketsEnabled,
  ultraFastTierEnabled,
  CATALOG_AUTO_REFRESH_DEFAULT_INTERVAL_MS,
  CATALOG_AUTO_REFRESH_MIN_INTERVAL_MS,
  isCatalogAutoRefreshEnabled,
  resolveCatalogAutoRefreshIntervalMs,
} from "./config/feature-flags";
export {
  codexAutoStartEnabled,
  CODEX_SHIM_AUTO_RESTORE_ENV,
  codexShimAutoRestoreEnabled,
  multiAgentGuidanceEnabled,
  runtimeRole,
  getDefaultConfig,
  resolveEnvValue,
  applyProxyEnv,
  applyProxyEnvWith,
} from "./config/proxy-env";
export {
  requestPacingConfigError,
  providerWebSearchBridgeConfigError,
  providerModelCostsConfigError,
  sanitizeModelCostsForDisplay,
  modelPreferHostedToolsConfigError,
} from "./config/schema/leaf-validators";
export { hardenExistingSecret, retryOn429PolicyConfigError, retryOnResetPolicyConfigError } from "./config/load-degrade";
export { backupInvalidConfig } from "./config/salvage";
export type { ConfigDiagnostics, ConfigAdmissionSnapshot } from "./config/diagnostics";
export {
  subagentDefaultSyncEffective,
  loopbackCompanionBindError,
  validateConfigCandidate,
  readConfigDiagnostics,
  observeInitialConfigState,
  readConfigAdmissionSnapshot,
} from "./config/diagnostics";
export {
  ConfigMutationLockError,
  NestedConfigMutationError,
  prepareConfigMutationDatabasePathForWrite,
  withConfigMutationLockSync,
  readConfigGeneration,
  observeConfigGeneration,
  readConfigGenerationInCurrentMutationTransaction,
  bumpConfigGeneration,
  withExpectedConfigGenerationSync,
} from "./config/mutation-lock";
export {
  armClaudeCodeBaseline, armDetachedConfigBaseline,
  adoptPersistedClaudeCode, adoptPersistedProviderIntoLiveConfig,
  adoptPersistedGuardrailsIntoLiveConfig,
  claudeCodeBaselineArmed,
  reconcileLiveConfigFromDisk,
  saveConfigPreservingClaudeCode,
} from "./config/live-reconcile";

// create-only path — never persist-unlocked / atomicWriteFile
import { InitialConfigPublicationError, publishInitialConfigNoReplace, type InitialConfigPublicationIO } from "./config/initialize";
import { observeInitialConfigState } from "./config/diagnostics";
import {
  configDiagnosticsFromRaw,
  mergeConfigDefaults,
  validateConfigCandidate,
} from "./config/diagnostics";

// replace path — never publishInitialConfigNoReplace
import { persistConfigUnlocked, readRawConfigJson } from "./config/persist-unlocked";

import { withConfigMutationLockSync, bumpGenerationForCooperatingConfigWrite } from "./config/mutation-lock";
import { getDefaultConfig } from "./config/proxy-env";
import { configSchema } from "./config/schema/config-schema";
import {
  hardenExistingSecret,
  normalizeApiKeyIds,
  normalizeClaudeSubagentEffort,
  normalizeNativeSubagentSync,
  sanitizeAliasesForLoad,
  sanitizeReasoningPinsForLoad,
  sanitizeModelDisplayNamesForLoad,
  sanitizeAutoReviewForLoad,
  sanitizeRetryOn429ForLoad,
  sanitizeModelCostsForLoad,
  sanitizeCapabilityDeclarationsForLoad,
  warnInheritedFastWireConflicts,
  warnDegradedTopLevelOptIns,
  warnDegradedHostname,
  warnDegradedListeners,
  warnDegradedApiKeys,
  warnDegradedCodexAccountPriorities,
  warnDegradedCodexQuotaAutoRefresh,
  warnDegradedClaudeSubagentEffort,
  warnDegradedNativeSubagentConfig,
  warnDegradedCodexAccountPicker,
  warnDegradedUpstreamHostCircuitThreshold,
  warnDegradedPlaintextV2AgentMessages,
  warnDegradedAgentTaskRecovery,
  warnDegradedRuntimeRole,
  warnDegradedOptionalRemoteBlocks,
  warnDegradedQuotaResetNotify,
  warnDegradedCatalogAutoRefresh,
  warnDegradedCodexPool,
  warnDegradedCredentialGroups,
  warnDegradedGuardrailsConfig,
  withRefreshedCostOverlays,
} from "./config/load-degrade";
import {
  salvageConfigCandidate,
  warnConfigRepaired,
  warnDroppedConfigSections,
  warnAndBackupInvalidConfig,
} from "./config/salvage";

/**
 * Load and validate config.json into an OcxConfig. Missing files reset to
 * defaults and clear stale overlays. Broken existing files also fall back to
 * default routing (after backup), but keep the last-good cost-overlay registry
 * until a valid config or a genuinely missing file is observed. A partially-
 * invalid config is merged with defaults so providers and pool accounts survive.
 */
export function loadConfig(): OcxConfig {
  const dir = getConfigDir();
  const configPath = getConfigPath();
  hardenConfigDir();
  hardenExistingSecret(configPath);
  hardenExistingSecret(join(dir, "auth.json"));
  if (!existsSync(configPath)) {
    return withRefreshedCostOverlays(getDefaultConfig());
  }
  try {
    const raw = readFileSync(configPath, "utf-8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw);
    sanitizeAliasesForLoad(parsed);
    sanitizeReasoningPinsForLoad(parsed);
    sanitizeModelDisplayNamesForLoad(parsed);
    sanitizeAutoReviewForLoad(parsed);
    sanitizeRetryOn429ForLoad(parsed);
    sanitizeModelCostsForLoad(parsed);
    sanitizeCapabilityDeclarationsForLoad(parsed);
    const result = configSchema.safeParse(parsed);
    if (result.success) {
      const config = normalizeApiKeyIds(result.data as OcxConfig);
      warnInheritedFastWireConflicts(configPath, config);
      warnDegradedTopLevelOptIns(parsed, config);
      warnDegradedHostname(parsed, config);
      warnDegradedListeners(parsed, config);
      warnDegradedApiKeys(parsed, config);
      warnDegradedCodexAccountPriorities(parsed, config);
      warnDegradedCodexQuotaAutoRefresh(parsed, config);
      warnDegradedClaudeSubagentEffort(parsed);
      warnDegradedNativeSubagentConfig(parsed, config);
      warnDegradedCodexAccountPicker(parsed);
      warnDegradedUpstreamHostCircuitThreshold(parsed);
      warnDegradedPlaintextV2AgentMessages(parsed);
      warnDegradedAgentTaskRecovery(parsed);
      warnDegradedRuntimeRole(parsed);
      warnDegradedOptionalRemoteBlocks(parsed);
      warnDegradedQuotaResetNotify(parsed);
      warnDegradedCatalogAutoRefresh(parsed);
      warnDegradedCodexPool(parsed);
      warnDegradedCredentialGroups(parsed);
      warnDegradedGuardrailsConfig(parsed);
      return withRefreshedCostOverlays(normalizeClaudeSubagentEffort(normalizeNativeSubagentSync(config, parsed), parsed));
    }
    // Only object-shaped configs are repairable. Spreading another JSON value
    // into defaults can manufacture a valid config and bypass the invalid-file
    // backup.
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      warnAndBackupInvalidConfig(configPath, result.error);
      return getDefaultConfig();
    }
    // Schema validation failed — merge defaults into the raw object instead of
    // discarding it entirely, so pool accounts and providers survive a missing
    // field like defaultProvider.
    const merged = mergeConfigDefaults(parsed);
    const retryResult = configSchema.safeParse(merged);
    if (retryResult.success) {
      warnConfigRepaired(configPath, result.error);
      const config = normalizeApiKeyIds(retryResult.data as OcxConfig);
      warnInheritedFastWireConflicts(configPath, config);
      warnDegradedHostname(parsed, config);
      warnDegradedListeners(parsed, config);
      warnDegradedApiKeys(parsed, config);
      warnDegradedCodexAccountPriorities(parsed, config);
      warnDegradedCodexQuotaAutoRefresh(parsed, config);
      warnDegradedClaudeSubagentEffort(parsed);
      warnDegradedNativeSubagentConfig(parsed, config);
      warnDegradedCodexAccountPicker(parsed);
      warnDegradedUpstreamHostCircuitThreshold(parsed);
      warnDegradedPlaintextV2AgentMessages(parsed);
      warnDegradedAgentTaskRecovery(parsed);
      warnDegradedRuntimeRole(parsed);
      warnDegradedOptionalRemoteBlocks(parsed);
      warnDegradedQuotaResetNotify(parsed);
      warnDegradedCatalogAutoRefresh(parsed);
      warnDegradedCodexPool(parsed);
      warnDegradedCredentialGroups(parsed);
      warnDegradedGuardrailsConfig(parsed);
      return withRefreshedCostOverlays(normalizeClaudeSubagentEffort(normalizeNativeSubagentSync(config, parsed), parsed));
    }
    // Still failing, but if every complaint is about one or more named entries
    // in an independent section, drop exactly those and keep the rest. Falling
    // back to defaults here would silently retire the operator's providers,
    // keys and prices over a mistake in one routing profile.
    const salvaged = salvageConfigCandidate(merged, retryResult.error);
    if (salvaged) {
      {
        warnDroppedConfigSections(configPath, salvaged.dropped, salvaged.issues);
        const config = normalizeApiKeyIds(salvaged.parsed);
        warnInheritedFastWireConflicts(configPath, config);
        warnDegradedHostname(parsed, config);
        warnDegradedListeners(parsed, config);
        warnDegradedApiKeys(parsed, config);
        warnDegradedCodexAccountPriorities(parsed, config);
        warnDegradedCodexQuotaAutoRefresh(parsed, config);
        warnDegradedClaudeSubagentEffort(parsed);
        warnDegradedNativeSubagentConfig(parsed, config);
        warnDegradedCodexAccountPicker(parsed);
        warnDegradedUpstreamHostCircuitThreshold(parsed);
        warnDegradedPlaintextV2AgentMessages(parsed);
        warnDegradedAgentTaskRecovery(parsed);
        warnDegradedRuntimeRole(parsed);
        warnDegradedOptionalRemoteBlocks(parsed);
        warnDegradedQuotaResetNotify(parsed);
        warnDegradedCatalogAutoRefresh(parsed);
        warnDegradedCodexPool(parsed);
        warnDegradedCredentialGroups(parsed);
        return withRefreshedCostOverlays(normalizeClaudeSubagentEffort(normalizeNativeSubagentSync(config, parsed), parsed));
      }
    }
    // Merge couldn't fix it — truly broken config
    warnAndBackupInvalidConfig(configPath, result.error);
    return getDefaultConfig();
  } catch (error) {
    warnAndBackupInvalidConfig(configPath, error);
    return getDefaultConfig();
  }
}

export type PersistedConfigInitializationOutcome = "created" | "exists" | "invalid";

/** Initialize only a missing config; ordinary explicit updates still use saveConfig. */
export function initializePersistedConfigIfMissing(
  config: OcxConfig,
  io?: Partial<InitialConfigPublicationIO>,
): PersistedConfigInitializationOutcome {
  assertNotRealHomeUnderTest(getConfigDir());
  const before = observeInitialConfigState();
  if (before !== "missing") return before;
  let published = false;
  try {
    const persisted = withConfigMutationLockSync((): OcxConfig | "exists" | "invalid" => {
      const current = observeInitialConfigState();
      if (current !== "missing") return current;
      const projected = projectCustomModelCatalogMigration(undefined, projectConfigRebaseProvenance(config));
      if (!validateConfigCandidate(projected).ok) throw new Error("Initial configuration is invalid.");
      if (!publishInitialConfigNoReplace(getConfigPath(), JSON.stringify(projected, null, 2) + "\n", io)) {
        return observeInitialConfigState() === "exists" ? "exists" : "invalid";
/** Hand-edited display-name mistakes disable only the bad label. */
function sanitizeModelDisplayNamesForLoad(raw: unknown): void {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  const root = raw as Record<string, unknown>;
  if (!root.providers || typeof root.providers !== "object" || Array.isArray(root.providers)) return;
  for (const [providerName, providerValue] of Object.entries(root.providers as Record<string, unknown>)) {
    if (!providerValue || typeof providerValue !== "object" || Array.isArray(providerValue)) continue;
    const provider = providerValue as Record<string, unknown>;
    const value = provider.modelDisplayNames;
    if (value === undefined) continue;
    const providerLabel = JSON.stringify(redactSecretString(providerName));
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.entries(value).length > MODEL_DISCOVERY_MAX_MODELS) {
      console.warn(`Ignoring invalid modelDisplayNames map for provider ${providerLabel} in config.json`);
      delete provider.modelDisplayNames;
      continue;
    }
    const labels = value as Record<string, unknown>;
    for (const [modelId, rawDisplayName] of Object.entries(labels)) {
      const displayName = typeof rawDisplayName === "string" ? rawDisplayName.trim() : rawDisplayName;
      if (modelDisplayNamesConfigError({ [modelId]: displayName })) {
        const safeModelId = JSON.stringify(redactSecretString(modelId));
        console.warn(`Ignoring invalid modelDisplayNames entry ${safeModelId} for provider ${providerLabel} in config.json`);
        delete labels[modelId];
      } else {
        labels[modelId] = displayName;
      }
    }
    if (Object.keys(labels).length === 0) delete provider.modelDisplayNames;
  }
}

/** Refresh the user cost-overlay registry from `config` and return it unchanged. */
function withRefreshedCostOverlays(config: OcxConfig): OcxConfig {
  refreshUserCostOverlays(config);
  return config;
}

export type ConfigDiagnostics = {
  config: OcxConfig;
  source: "default" | "file" | "fallback";
  error: string | null;
  /** Non-fatal config concerns; absent when there are no warnings. */
  warnings?: string[];
};

type ConfigFileSnapshot = {
  diagnostics: ConfigDiagnostics;
  /** Exact file contents, including a possible BOM, used as the optimistic revision. */
  raw?: string;
};

function configPlaceholderWarnings(config: OcxConfig): string[] {
  const warnings: string[] = [];
  for (const [name, provider] of Object.entries(config.providers)) {
    const placeholder = provider.baseUrl.match(/\{[^}]*\}/)?.[0];
    if (placeholder) {
      warnings.push(`providers.${name}.baseUrl contains unresolved ${placeholder}; set the real provider URL`);
    }
  }
  return warnings;
}

function validFileConfigDiagnostics(config: OcxConfig, rawParsed: unknown): ConfigDiagnostics {
  // Unsafe hand-edited optional values are disabled in memory instead of rejecting
  // the entire config, which would hide unrelated providers/accounts. The next
  // ordinary save persists the normalized absence.
  const syncDisabledReason = nativeSubagentSyncDisabledReason(config, rawParsed);
  const rawEffort = rawClaudeSubagentEffort(rawParsed);
  const normalized = normalizeClaudeSubagentEffort(normalizeNativeSubagentSync(config, rawParsed), rawParsed);
  const warnings = configPlaceholderWarnings(normalized);
  warnings.push(...inheritedFastWireConflictProviderNames(normalized).map(inheritedFastWireConflictWarning));
  warnings.push(...degradedCodexAccountPriorityWarnings(rawParsed, normalized));
  const quotaAutoRefreshWarning = degradedCodexQuotaAutoRefreshWarning(rawParsed, normalized);
  if (quotaAutoRefreshWarning) warnings.push(quotaAutoRefreshWarning);
  if (rawEffort !== undefined && !isClaudeSubagentEffort(rawEffort)) {
    warnings.push(`claudeCode.subagentEffort ignored: expected one of ${CLAUDE_SUBAGENT_EFFORTS.join(", ")}`);
  }
  warnings.push(...malformedNativeSubagentFields(rawParsed).map(malformedNativeSubagentFieldWarning));
  const pickerWarning = malformedCodexAccountPickerWarning(rawParsed);
  if (pickerWarning) warnings.push(pickerWarning);
  const hostCircuitWarning = malformedUpstreamHostCircuitThresholdWarning(rawParsed);
  if (hostCircuitWarning) warnings.push(hostCircuitWarning);
  const recoveryWarning = malformedAgentTaskRecoveryWarning(rawParsed);
  if (recoveryWarning) warnings.push(recoveryWarning);
  const runtimeRoleWarning = malformedRuntimeRoleWarning(rawParsed);
  if (runtimeRoleWarning) warnings.push(runtimeRoleWarning);
  const hubWarning = malformedOptionalRemoteBlockWarning(rawParsed, "hub");
  if (hubWarning) warnings.push(hubWarning);
  const remoteGuiWarning = malformedOptionalRemoteBlockWarning(rawParsed, "remoteGui");
  if (remoteGuiWarning) warnings.push(remoteGuiWarning);
  const clientWarning = malformedClientConnectionWarning(rawParsed);
  if (clientWarning) warnings.push(clientWarning);
  const notifyWarning = malformedQuotaResetNotifyWarning(rawParsed);
  if (notifyWarning) warnings.push(notifyWarning);
  const guardrailsWarning = malformedGuardrailsConfigWarning(rawParsed);
  if (guardrailsWarning) warnings.push(guardrailsWarning);
  if (syncDisabledReason) {
    warnings.push(`syncCodexSubagentDefaults ignored: ${syncDisabledReason}`);
  }
  return {
    config: normalized,
    source: "file",
    error: null,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

export function subagentDefaultSyncEffective(
  config: Pick<OcxConfig, "syncCodexSubagentDefaults" | "injectionModel">,
): boolean {
  return config.syncCodexSubagentDefaults === true && Boolean(config.injectionModel?.trim());
}

function mergeConfigDefaults(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== "object") return parsed;
  const defaults = getDefaultConfig();
  const raw = parsed as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...defaults, ...raw, subagentModelsVersion: raw.subagentModelsVersion };
  if (raw.providers && typeof raw.providers === "object" && defaults.providers) {
    merged.providers = { ...defaults.providers, ...(raw.providers as Record<string, unknown>) };
  }
  return merged;
}

function schemaDiagnosticsError(error: z.ZodError): string {
  const details = error.issues.map(issue => {
    const path = issue.path.join(".") || "config";
    return `${path}: ${issue.message}`;
  });
  return details.length > 0 ? `schema_invalid: ${details.join("; ")}` : "schema_invalid";
}

/**
 * Reject a hostname the schema deliberately degrades on read. Load-time has to keep a
 * blank value non-fatal (see the `hostname` field comment), but an incoming write is a
 * live caller who can be told the value is wrong — silently rewriting it to loopback
 * would look like the bind succeeded on the address they asked for.
 */
function blankHostnameError(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const hostname = (value as Record<string, unknown>).hostname;
  if (hostname === undefined) return null;
  if (typeof hostname !== "string" || !hostname.trim()) {
    return "schema_invalid: hostname: must be a nonblank bind address";
  }
  return null;
}

function claudeSubagentEffortError(value: unknown): string | null {
  const effort = rawClaudeSubagentEffort(value);
  if (effort === undefined || isClaudeSubagentEffort(effort)) return null;
  return `schema_invalid: claudeCode.subagentEffort: must be one of ${CLAUDE_SUBAGENT_EFFORTS.join(", ")}`;
}

function appOwnedMemoryBudgetError(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const budget = (value as Record<string, unknown>).appOwnedMemoryBudgetMb;
  if (budget === undefined) return null;
  if (typeof budget !== "number" || !Number.isInteger(budget)
    || budget < MIN_APP_OWNED_MEMORY_BUDGET_MB || budget > MAX_APP_OWNED_MEMORY_BUDGET_MB) {
    return `schema_invalid: appOwnedMemoryBudgetMb: must be an integer from ${MIN_APP_OWNED_MEMORY_BUDGET_MB} to ${MAX_APP_OWNED_MEMORY_BUDGET_MB}`;
  }
  return null;
}

function upstreamHostCircuitThresholdError(value: unknown): string | null {
  const raw = rawConfigRecord(value);
  if (!raw || !Object.hasOwn(raw, "upstreamHostCircuitThreshold")) return null;
  const threshold = raw.upstreamHostCircuitThreshold;
  if (threshold === undefined) return null;
  if (typeof threshold === "number"
    && Number.isInteger(threshold)
    && threshold >= 0
    && threshold <= UPSTREAM_HOST_CIRCUIT_MAX_THRESHOLD) return null;
  return `schema_invalid: upstreamHostCircuitThreshold: must be an integer from 0 to ${UPSTREAM_HOST_CIRCUIT_MAX_THRESHOLD}`;
}

function agentTaskRecoveryError(value: unknown): string | null {
  const raw = rawConfigRecord(value);
  if (!raw || !Object.hasOwn(raw, "agentTaskRecovery") || raw.agentTaskRecovery === undefined) return null;
  const result = agentTaskRecoverySchema.safeParse(raw.agentTaskRecovery);
  if (result.success) return null;
  const issue = result.error.issues[0];
  const field = issue?.path.join(".");
  return `schema_invalid: agentTaskRecovery${field ? `.${field}` : ""}: ${issue?.message ?? "invalid configuration"}`;
}

function runtimeRoleError(value: unknown): string | null {
  const raw = rawConfigRecord(value);
  if (!raw || !Object.hasOwn(raw, "runtimeRole") || raw.runtimeRole === undefined) return null;
  if (runtimeRoleSchema.safeParse(raw.runtimeRole).success) return null;
  return 'schema_invalid: runtimeRole: must be one of "standalone", "hub", or "client"';
}

function remoteGuiConfigError(value: unknown): string | null {
  const raw = rawConfigRecord(value);
  if (!raw) return null;
  for (const [key, schema] of [
    ["hub", hubConfigSchema],
    ["remoteGui", remoteGuiConfigSchema],
  ] as const) {
    if (!Object.hasOwn(raw, key) || raw[key] === undefined) continue;
    const result = schema.safeParse(raw[key]);
    if (result.success) continue;
    const issue = result.error.issues[0];
    const field = issue?.path.join(".");
    return `schema_invalid: ${key}${field ? `.${field}` : ""}: ${issue?.message ?? "invalid configuration"}`;
  }
  return null;
}

function clientConnectionConfigError(value: unknown): string | null {
  const raw = rawConfigRecord(value);
  if (!raw || !Object.hasOwn(raw, "client") || raw.client === undefined) return null;
  const result = clientConnectionSchema.safeParse(raw.client);
  if (result.success) return null;
  const issue = result.error.issues[0];
  const field = issue?.path.join(".");
  return `schema_invalid: client${field ? `.${field}` : ""}: ${issue?.message ?? "invalid client connection"}`;
}

function clientRolePairError(value: unknown): string | null {
  const raw = rawConfigRecord(value);
  if (!raw) return null;
  const hasClient = Object.hasOwn(raw, "client") && raw.client !== undefined;
  if (raw.runtimeRole === "client" && !hasClient) {
    return "schema_invalid: runtimeRole client requires a complete client connection";
  }
  if (hasClient && raw.runtimeRole !== "client") {
    return "schema_invalid: client connection requires runtimeRole client";
  }
  return null;
}

function quotaResetNotifyError(value: unknown): string | null {
  const raw = rawConfigRecord(value);
  if (!raw || !Object.hasOwn(raw, "quotaResetNotify") || raw.quotaResetNotify === undefined) return null;
  const result = quotaResetNotifySchema.safeParse(raw.quotaResetNotify);
  if (result.success) return null;
  const issue = result.error.issues[0];
  const field = issue?.path.join(".");
  return `schema_invalid: quotaResetNotify${field ? `.${field}` : ""}: ${issue?.message ?? "invalid configuration"}`;
}

function warnDegradedGuardrailsConfig(rawParsed: unknown): void {
  const warning = malformedGuardrailsConfigWarning(rawParsed);
  if (warning) console.warn(`⚠️  config.json ${warning}. Other settings were preserved.`);
}

/**
 * Same reasoning as {@link blankHostnameError}, and more urgent: the read path degrades a
 * malformed selection-order map to undefined, which on a write would drop every entry the
 * user had accumulated and still report success. A load-time degrade leaves the raw map in
 * the file to be repaired by hand; a degraded write erases it. One bad `ocx config set`
 * must not cost the whole map, so a live caller is told instead.
 */
function codexAccountPrioritiesError(value: unknown): string | null {
  const raw = rawConfigRecord(value);
  if (!raw) return null;
  if (raw.codexAccountPriorities !== undefined) {
    const parsed = codexAccountPrioritiesSchema.safeParse(raw.codexAccountPriorities);
    if (!parsed.success) {
      return schemaDiagnosticsError(parsed.error).replace("schema_invalid: ", "schema_invalid: codexAccountPriorities.");
    }
  }
  // Tested as a string rather than coerced: `String(123)` matches the id pattern, so a
  // coercing guard waves a non-string pin through to the schema, where `.catch(undefined)`
  // drops it and reports the write as a success — the exact silent-degrade this guards.
  const pin = raw.activeCodexAccountPinned;
  if (pin !== undefined && (typeof pin !== "string" || !CODEX_ACCOUNT_PIN_PATTERN.test(pin))) {
    return "schema_invalid: activeCodexAccountPinned: must be an account id";
  }
  return null;
}

function codexQuotaAutoRefreshError(value: unknown): string | null {
  const raw = rawConfigRecord(value);
  if (!raw || raw.codexQuotaAutoRefresh === undefined) return null;
  const parsed = codexQuotaAutoRefreshSchema.safeParse(raw.codexQuotaAutoRefresh);
  if (parsed.success) return null;
  const details = parsed.error.issues.map(issue => {
    const path = issue.path.join(".");
    const message = path === ""
      ? issue.message.replace(/^codexQuotaAutoRefresh\s*/, "")
      : issue.message;
    return `codexQuotaAutoRefresh${path ? `.${path}` : ""}: ${message}`;
  });
  return `schema_invalid: ${details.join("; ")}`;
}

function googleAntigravityStaticCatalogVersionError(value: unknown): string | null {
  const raw = rawConfigRecord(value);
  if (!raw || !Object.hasOwn(raw, "googleAntigravityStaticCatalogVersion")) return null;
  const version = raw.googleAntigravityStaticCatalogVersion;
  if (version === undefined || version === 1 || version === 2) return null;
  return "schema_invalid: googleAntigravityStaticCatalogVersion: must be 1, 2, or omitted";
}

function codexAccountPickerEnabledError(value: unknown): string | null {
  const raw = rawConfigRecord(value);
  if (!raw) return null;
  const descriptor = Object.getOwnPropertyDescriptor(raw, "codexAccountPickerEnabled");
  if (!descriptor) {
    return "codexAccountPickerEnabled" in raw
      ? "schema_invalid: codexAccountPickerEnabled: must be an own boolean data property or omitted"
      : null;
  }
  if (!("value" in descriptor)) {
    return "schema_invalid: codexAccountPickerEnabled: must be an own boolean data property or omitted";
  }
  const enabled = descriptor.value;
  if (enabled === undefined || typeof enabled === "boolean") return null;
  return "schema_invalid: codexAccountPickerEnabled: must be a boolean or omitted";
}

function emptyCompletionRetryError(value: unknown): string | null {
  const raw = rawConfigRecord(value);
  if (!raw || !Object.hasOwn(raw, "emptyCompletionRetry")) return null;
  const enabled = raw.emptyCompletionRetry;
  if (enabled === undefined || typeof enabled === "boolean") return null;
  return "schema_invalid: emptyCompletionRetry: must be a boolean or omitted";
}

function oauthOpenBrowserError(value: unknown): string | null {
  const raw = rawConfigRecord(value);
  if (!raw || !Object.hasOwn(raw, "oauthOpenBrowser")) return null;
  const enabled = raw.oauthOpenBrowser;
  if (enabled === undefined || typeof enabled === "boolean") return null;
  return "schema_invalid: oauthOpenBrowser: must be a boolean or omitted";
}

/** Validate an in-memory config candidate without touching disk. Used by headless CLI import/set. */
/**
 * Reject a loopback-listener port that collides with the proxy port (#1102).
 *
 * The schema can only check the shape of each field on its own; the two ports being distinct
 * is a relationship between them. Letting the pair through would surface as a startup failure
 * after the public listener already bound, which reads like an unrelated port conflict.
 *
 * This is write-time only, matching `blankHostnameError`: a live caller can be told the value
 * is wrong, whereas a hand-edited config on the read path degrades to undefined rather than
 * resetting the whole file.
 */
function loopbackListenerPortError(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const listener = (value as Record<string, unknown>).unauthenticatedLoopbackListener;
  if (listener === undefined) return null;
  if (!listener || typeof listener !== "object" || Array.isArray(listener)) {
    return "schema_invalid: unauthenticatedLoopbackListener: must be an object or omitted";
  }
  const entry = listener as Record<string, unknown>;
  // `enabled` must be a real boolean. The schema's `.catch(undefined)` would otherwise DELETE
  // a `"true"` string entry and report success, leaving an operator convinced they enabled an
  // unauthenticated listener that is in fact off. Load-time still degrades quietly — a hand
  // edit must not reset the file — but a live caller gets told.
  if (typeof entry.enabled !== "boolean") {
    return "schema_invalid: unauthenticatedLoopbackListener.enabled: must be a boolean";
  }
  if (entry.enabled !== true) return null;
  const listenerPort = entry.port;
  if (typeof listenerPort !== "number" || !Number.isInteger(listenerPort) || listenerPort < 1 || listenerPort > 65535) {
    return "schema_invalid: unauthenticatedLoopbackListener.port: must be an integer port when enabled";
  }
  const proxyPort = (value as Record<string, unknown>).port;
  if (typeof proxyPort === "number" && proxyPort === listenerPort) {
    return "schema_invalid: unauthenticatedLoopbackListener.port: must differ from the proxy port";
  }
  return null;
}

/**
 * Validate the hub management ingress at the live-write boundary.
 *
 * The persisted schema intentionally degrades a malformed hand edit to disabled so a typo in
 * this opt-in listener cannot discard providers or credentials. A live config mutation must not
 * get that leniency: it receives an exact field error before the degrading schema is applied.
 */
function managementIngressConfigError(value: unknown): string | null {
  const raw = rawConfigRecord(value);
  if (!raw) return null;
  const hub = rawConfigRecord(raw.hub);
  if (!hub || !Object.hasOwn(hub, "managementIngress") || hub.managementIngress === undefined) return null;
  const ingress = rawConfigRecord(hub.managementIngress);
  if (!ingress) {
    return "schema_invalid: hub.managementIngress: must be an object or omitted";
  }
  if (typeof ingress.enabled !== "boolean") {
    return "schema_invalid: hub.managementIngress.enabled: must be a boolean";
  }
  const keys = Object.keys(ingress);
  if (ingress.enabled === false) {
    return keys.length === 1
      ? null
      : "schema_invalid: hub.managementIngress: disabled ingress accepts only enabled";
  }
  if (keys.some(key => key !== "enabled" && key !== "port")) {
    return "schema_invalid: hub.managementIngress: contains an unsupported field";
  }
  const ingressPort = ingress.port;
  if (typeof ingressPort !== "number" || !Number.isInteger(ingressPort) || ingressPort < 1 || ingressPort > 65535) {
    return "schema_invalid: hub.managementIngress.port: must be an integer port when enabled";
  }
  if (raw.runtimeRole !== "hub") {
    return "schema_invalid: hub.managementIngress: enabled ingress requires runtimeRole hub";
  }
  const proxyPort = typeof raw.port === "number" ? raw.port : 10100;
  if (proxyPort === ingressPort) {
    return "schema_invalid: hub.managementIngress.port: must differ from the proxy port";
  }
  const loopback = rawConfigRecord(raw.unauthenticatedLoopbackListener);
  if (loopback?.enabled === true && loopback.port === ingressPort) {
    return "schema_invalid: hub.managementIngress.port: must differ from unauthenticatedLoopbackListener.port";
  }
  return null;
}

export function validateConfigCandidate(value: unknown): { ok: true; config: OcxConfig } | { ok: false; error: string } {
  const boundaryError = blankHostnameError(value)
    ?? claudeSubagentEffortError(value)
    ?? appOwnedMemoryBudgetError(value)
    ?? upstreamHostCircuitThresholdError(value)
    ?? agentTaskRecoveryError(value)
    ?? quotaResetNotifyError(value)
    ?? guardrailsConfigError(value)
    ?? googleAntigravityStaticCatalogVersionError(value)
    ?? codexAccountPrioritiesError(value)
    ?? codexQuotaAutoRefreshError(value)
    ?? codexAccountPickerEnabledError(value)
    ?? emptyCompletionRetryError(value)
    ?? oauthOpenBrowserError(value)
    ?? runtimeRoleError(value)
    ?? remoteGuiConfigError(value)
    ?? clientConnectionConfigError(value)
    ?? clientRolePairError(value)
    ?? loopbackListenerPortError(value)
    ?? managementIngressConfigError(value);
  if (boundaryError) return { ok: false, error: boundaryError };
  const result = configSchema.safeParse(value);
  if (result.success) {
    const config = normalizeApiKeyIds(result.data as OcxConfig);
    return { ok: true, config };
  }
  return { ok: false, error: schemaDiagnosticsError(result.error) };
}

function configDiagnosticsFromRaw(raw: string): ConfigDiagnostics {
  try {
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
    // Same degradation as loadConfig: a hand-edited invalid retryOn429 must not trip the
    // schema and send the caller a default-config fallback (the config command could then
    // persist that fallback over the user's providers/keys).
    sanitizeModelDisplayNamesForLoad(parsed);
    sanitizeRetryOn429ForLoad(parsed);
    sanitizeModelCostsForLoad(parsed);
    const result = configSchema.safeParse(parsed);
    if (result.success) {
      return validFileConfigDiagnostics(normalizeApiKeyIds(result.data as OcxConfig), parsed);
    }

    const merged = mergeConfigDefaults(parsed);
    const retryResult = configSchema.safeParse(merged);
    if (retryResult.success) {
      return validFileConfigDiagnostics(normalizeApiKeyIds(retryResult.data as OcxConfig), parsed);
    }

    // #1785: one invalid routing profile must not make diagnostics report the built-in
    // defaults AS the config, because a later config write persists those defaults over the
    // operator's providers, keys and prices.
    //
    // The failure is still reported. `source` stays "fallback" and `error` keeps the real
    // schema message -- diagnostics is the surface that tells callers the file is invalid,
    // and every consumer that must refuse an invalid config (provider reload, catalog sync,
    // cost reconcile, codex admission) gates on exactly those two fields. Only `config`
    // changes: it carries the salvaged document instead of factory defaults, so a caller
    // that ignores the error and writes it back preserves what the operator configured.
    const salvaged = salvageConfigCandidate(merged, retryResult.error);
    if (salvaged) {
      return {
        config: normalizeApiKeyIds(salvaged.parsed),
        source: "fallback",
        error: schemaDiagnosticsError(result.error),
      };
    }

    return { config: getDefaultConfig(), source: "fallback", error: schemaDiagnosticsError(result.error) };
  } catch {
    return { config: getDefaultConfig(), source: "fallback", error: "invalid_json" };
  }
}

function readConfigFileSnapshot(): ConfigFileSnapshot {
  try {
    const raw = readFileSync(getConfigPath(), "utf-8");
    return { diagnostics: configDiagnosticsFromRaw(raw), raw };
  } catch (error) {
    if (isMissingPathError(error)) {
      return {
        diagnostics: { config: getDefaultConfig(), source: "default", error: null },
      };
    }
    return {
      diagnostics: { config: getDefaultConfig(), source: "fallback", error: "invalid_json" },
    };
  }
}

export function readConfigDiagnostics(): ConfigDiagnostics {
  return readConfigFileSnapshot().diagnostics;
}

/**
 * The persisted config, plus a digest of the EXACT bytes it was parsed from.
 *
 * A union rather than a nullable digest, because `{ kind: "read" }` with no
 * digest is a state that cannot occur — and a state that cannot occur should
 * not be a state that can be written down. Refusing it at runtime is a check
 * somebody eventually forgets; making it unrepresentable is not.
 *
 * Why a byte digest at all: the Codex write lock compares an authority snapshot
 * taken before the lock against one taken while holding it, and its config
 * component used to hash the PARSED object. Two files that differ only in
 * whitespace or key order parse identically, so a non-cooperating writer could
 * rewrite the file between admission and commit and the comparison would see
 * nothing. Hashing what was actually read closes that.
 *
 * `readConfigFileSnapshot` stays private on purpose. Its `raw` carries provider
 * API keys and admission tokens, and `privacy:scan` reads tracked source text,
 * not runtime values — so it would not catch a caller that logged or serialized
 * that string. The digest travels; the bytes do not.
 */
export type ConfigAdmissionSnapshot =
  | Readonly<{ kind: "read"; diagnostics: ConfigDiagnostics; contentSha256: string }>
  | Readonly<{ kind: "unreadable"; diagnostics: ConfigDiagnostics; contentSha256: null }>;

export function readConfigAdmissionSnapshot(): ConfigAdmissionSnapshot {
  let bytes: Buffer;
  try {
    // ONE read. Hashing the file and then reading it again to parse would leave
    // a window for the two to disagree, which is the exact hazard this exists
    // to detect — the check would become a second chance to be wrong.
    bytes = readFileSync(getConfigPath());
  } catch (error) {
    return {
      kind: "unreadable",
      diagnostics: isMissingPathError(error)
        ? { config: getDefaultConfig(), source: "default", error: null }
        : { config: getDefaultConfig(), source: "fallback", error: "invalid_json" },
      contentSha256: null,
    };
  }
  return {
    kind: "read",
    // Decoded from the same buffer that was hashed, not re-read from disk.
    diagnostics: configDiagnosticsFromRaw(bytes.toString("utf-8")),
    contentSha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

const CONFIG_MUTATION_DB_FILENAME = "config-mutation.sqlite";
const CONFIG_MUTATION_DB_SIDECARS = ["-journal", "-wal", "-shm"] as const;
let warnedConfigMutationDirectoryAcl = false;

export class ConfigMutationLockError extends Error {
  readonly code = "CONFIG_MUTATION_LOCK_UNAVAILABLE";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ConfigMutationLockError";
  }
}

function configMutationDatabasePath(): string {
  const dir = getConfigDir();
  // First statement on purpose: a rejected mutation must leave nothing behind, not a
  // freshly created/chmod'd directory or database. See src/lib/test-home-guard.ts.
  assertNotRealHomeUnderTest(dir);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } else {
    try { chmodSync(dir, 0o700); } catch { /* best-effort on existing dir */ }
  }
  if (windowsSecretAclApplies()) {
    try {
      // Distinct timeout memo from management-token directory harden: a required
      // management-dir timeout must not poison config mutation on the same home
      // (windows-latest server-management-auth cases).
      hardenSecretDir(dir, { required: true, timeoutMemoKey: `${dir}::config-mutation` });
    } catch (error) {
      if (!warnedConfigMutationDirectoryAcl) {
        warnedConfigMutationDirectoryAcl = true;
        const diagnostics = error instanceof Error ? error.message : "ACL hardening failed";
        console.warn(
          `[opencodex] Config mutation coordination directory ACL hardening did not complete; continuing without it. ${diagnostics}`,
        );
      }
    }
  }
  const path = join(dir, CONFIG_MUTATION_DB_FILENAME);
  recordOwnedConfigPath(dir, path);
  for (const suffix of CONFIG_MUTATION_DB_SIDECARS) {
    recordOwnedConfigPath(dir, `${path}${suffix}`);
  }
  return path;
}

/** Raised when an independent config-mutation transaction is requested recursively. */
export class NestedConfigMutationError extends Error {
  constructor() {
    super("prepareConfigMutationDatabasePathForWrite must not run inside withConfigMutationLockSync");
    this.name = "NestedConfigMutationError";
  }
}

/**
 * Prepare the shared config-mutation database path for an independent top-level
 * SQLite transaction. Callers must not invoke this while holding
 * {@link withConfigMutationLockSync}; a second `BEGIN IMMEDIATE` deliberately
 * fails busy instead of joining an uncommitted transaction.
 *
 * @throws {NestedConfigMutationError} If a config mutation lock is already held.
 */
export function prepareConfigMutationDatabasePathForWrite(): string {
  if (configMutationLockDepth > 0) {
    throw new NestedConfigMutationError();
  }
  return configMutationDatabasePath();
}

let configMutationLockDepth = 0;
let configMutationDatabase: Database | null = null;

/**
 * Serialize synchronous config and Codex credential-generation commits across processes with an
 * OS-backed SQLite write transaction. `busy_timeout=0` is deliberate: runtime request paths must
 * fail immediately under contention rather than freeze the Bun event loop. Process exit releases
 * SQLite locks without stale-owner deletion or lease recovery races.
 *
 * Reentrancy is limited to the current synchronous call stack; never return a Promise from `fn`.
 */
export function withConfigMutationLockSync<T>(fn: () => T): T {
  if (configMutationLockDepth > 0) {
    configMutationLockDepth += 1;
    try {
      return fn();
    } finally {
      configMutationLockDepth -= 1;
    }
  }
  const path = configMutationDatabasePath();
  let database: Database | undefined;
  let transactionOpen = false;
  try {
    database = new Database(path, { create: true });
    try { chmodSync(path, 0o600); } catch { /* platform may ignore chmod */ }
    database.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
    transactionOpen = true;
    initializeConfigGeneration(database);
  } catch (cause) {
    if (transactionOpen) {
      try { database?.exec("ROLLBACK"); } catch { /* close below still releases the OS lock */ }
    }
    try { database?.close(); } catch { /* acquisition already failed */ }
    const code = cause && typeof cause === "object" && "code" in cause
      ? String((cause as { code?: unknown }).code)
      : "";
    throw new ConfigMutationLockError(
      code === "SQLITE_BUSY" ? "Config mutation already in progress" : "Could not acquire config mutation transaction",
      { cause },
    );
  }

  configMutationLockDepth = 1;
  configMutationDatabase = database;
  try {
    const value = fn();
    database.exec("COMMIT");
    transactionOpen = false;
    return value;
  } catch (error) {
    if (transactionOpen) {
      try { database.exec("ROLLBACK"); } catch { /* close below still releases the OS lock */ }
      transactionOpen = false;
    }
    throw error;
  } finally {
    configMutationLockDepth = 0;
    configMutationDatabase = null;
    try { database.close(); } catch { /* the OS lock is released with the handle */ }
  }
}

function bumpGenerationForCooperatingConfigWrite(): void {
  if (!configMutationDatabase) {
    throw new Error("A cooperating config write requires the config mutation transaction.");
  }
  bumpCurrentConfigGeneration(configMutationDatabase);
}

export const readConfigGeneration: ReadConfigGeneration = () => {
  try {
    return readConfigGenerationAtPath(configMutationDatabasePath());
  } catch {
    return { kind: "unavailable", reason: "database" };
  }
};

export function observeConfigGeneration(): ConfigGenerationObservation {
  return observeConfigGenerationAtPath(join(getConfigDir(), CONFIG_MUTATION_DB_FILENAME));
}

/**
 * Read the generation from the transaction that is open RIGHT NOW.
 *
 * The observer cannot do this job. On the very first acquisition the
 * `BEGIN IMMEDIATE` that creates the table has not committed yet, so a separate
 * read-only connection cannot read a generation from it — measured, not
 * assumed. A caller that compared a pre-lock observation against an observer
 * re-read would therefore refuse every first write as stale.
 *
 * Throwing when no transaction is open is deliberate. Being called outside the
 * lock is broken plumbing, and returning a typed "unavailable" would let that
 * bug arrive disguised as an environmental failure — retried forever, on a
 * machine where nothing is wrong.
 */
export function readConfigGenerationInCurrentMutationTransaction(): ConfigGeneration {
  if (configMutationLockDepth < 1 || !configMutationDatabase) {
    throw new Error(
      "readConfigGenerationInCurrentMutationTransaction requires an open config mutation transaction.",
    );
  }
  return readConfigGenerationInTransaction(configMutationDatabase);
}

export const bumpConfigGeneration: BumpConfigGeneration = expected => {
  try {
    return bumpConfigGenerationAtPath(configMutationDatabasePath(), expected);
  } catch {
    return { kind: "unavailable", reason: "database" };
  }
};

function configGenerationFailureReason(error: unknown): "busy" | "database" {
  const cause = error instanceof ConfigMutationLockError ? error.cause : error;
  const code = cause && typeof cause === "object" && "code" in cause
    ? String((cause as { code?: unknown }).code)
    : "";
  const message = cause instanceof Error ? cause.message : "";
  return code === "SQLITE_BUSY"
    || code === "SQLITE_LOCKED"
    || /database (?:is|table is) locked/i.test(message)
    ? "busy"
    : "database";
}

export const withExpectedConfigGenerationSync: WithExpectedConfigGenerationSync = (
  expected,
  commit,
) => {
  let callbackThrew = false;
  let callbackError: unknown;
  try {
    return withConfigMutationLockSync(() => {
      const database = configMutationDatabase;
      if (!database) throw new Error("Config mutation transaction database is unavailable.");
      const current = readConfigGenerationInTransaction(database);
      if (current.value !== expected.value) return { kind: "conflict", current };
      try {
        return { kind: "matched", generation: current, value: commit() };
      } catch (error) {
        callbackThrew = true;
        callbackError = error;
        throw error;
      }
      published = true;
      recordOwnedConfigPath(getConfigDir(), getConfigPath());
      bumpGenerationForCooperatingConfigWrite();
      return projected;
    });
    if (typeof persisted === "string") return persisted;
    adoptCustomModelCatalogMigration(config, persisted);
    if (persisted.configRebaseProvenance === undefined) delete config.configRebaseProvenance;
    else config.configRebaseProvenance = structuredClone(persisted.configRebaseProvenance);
    clearPendingConfigDeletions(config);
    refreshConfigDerivedRegistries(persisted);
    return "created";
  } catch (cause) {
    if (published) throw new InitialConfigPublicationError("published", false, false, { cause });
    throw cause;
  }
}

/** Persist `config` to config.json under the config-mutation lock. */
export function saveConfig(config: OcxConfig): void {
  const pinError = configReasoningPinsConfigError(config);
  if (pinError) throw new Error(pinError);
  // Keep the real-home assertion ahead of even lock-directory preparation.
  assertNotRealHomeUnderTest(getConfigDir());
  withConfigMutationLockSync(() => {
    const withProvenance = projectCustomModelCatalogMigration(
      readRawConfigJson(),
      projectConfigRebaseProvenance(config),
    );
    if (persistConfigUnlocked(withProvenance)) bumpGenerationForCooperatingConfigWrite();
    adoptCustomModelCatalogMigration(config, withProvenance);
    if (withProvenance.configRebaseProvenance === undefined) delete config.configRebaseProvenance;
    else config.configRebaseProvenance = structuredClone(withProvenance.configRebaseProvenance);
    clearPendingConfigDeletions(config);
  });
}
