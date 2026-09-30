/**
 * The `/v1/models` public list, factored out of serve-options so the same
 * projection can answer two questions:
 *
 *   - the endpoint itself (rows serialized byte-identically to before), and
 *   - "which public ids may this admission see" for `/v1/catalog` filtering
 *     and the management scope-options picker.
 *
 * `loadPublicModelUniverse` gathers everything the response shapes (OpenAI
 * list, Anthropic list, Codex catalog, Desktop config) are computed from.
 * `buildPublicModelRows` emits the OpenAI-list rows plus an internal
 * `destination` naming where a request for that id would actually bill —
 * stripped before JSON serialization.
 */
import type { CatalogModel } from "../../codex/catalog";
import { resolveAdmittedCodexModelEntitlements } from "../../codex/model-entitlement-admission";
import {
  availableAccountGatedNativeModels,
  codexModelEntitlementStateForAccount,
  type CodexModelEntitlementSnapshot,
} from "../../codex/model-entitlements";
import {
  codexAccountNamespaceEntries,
  isMainCodexAccountTarget,
} from "../../codex/account-namespaces";
import { MAIN_CODEX_ACCOUNT_ID } from "../../codex/main-account";
import { providerCodexAccountMode } from "../../providers/registry";
import { OPENAI_CODEX_PROVIDER_ID } from "../../providers/openai-tiers";
import { grokDefaultReasoningEffort } from "../../grok/effort";
import { knownModelIdsForProvider } from "../../router";
import {
  buildDesktopDiscoveryInputs,
  type DesktopDiscoveryInputs,
} from "../../claude/desktop-discovery-inputs";
import { resolveAdmissionModelScope, routeAllowedByScope } from "../admission-model-scope";
import type { DataPlaneAdmission } from "../auth-cors";
import { modelCapabilityFields } from "../models-capabilities";
import { expandCursorEffortRow, knownEffortRowIds } from "../effort-row";
import { catalogFastRowEligible, expandFastRow } from "../fast-row";
import { detectCursorInstalls } from "../../integrations/cursor-detect";
import { loadCursorEffortTable } from "../../integrations/cursor-effort-table";
import type { CursorInstall } from "../../integrations/cursor-detect";
import type { CursorEffortTable } from "../../integrations/cursor-effort-table";
import type { OcxConfig } from "../../types";

/** One public-list row plus the billing destination its id resolves to. */
export interface PublicModelRow {
  row: Record<string, unknown>;
  destination: { providerName: string; modelId: string };
}

export interface PublicModelUniverse {
  goModels: CatalogModel[];
  modelEntitlements: CodexModelEntitlementSnapshot;
  includeNativeOpenAi: boolean;
  includeAccountBoundNativeOpenAi: boolean;
  availableBareGatedNativeSlugs: ReadonlySet<string>;
  availableAccountGatedNativeSlugs: ReadonlySet<string>;
  availableBareNativeSlugs: string[];
  availableAccountNativeSlugs: string[];
  nativeSlugs: string[];
  disabledNatives: ReadonlySet<string>;
  disabledModels: Set<string>;
  exactComboSlugs: ReadonlySet<string>;
  shadowedNativeSlugs: Set<string>;
  suppressedBareNativeSlugs: Set<string>;
  accountSelectors: string[];
  accountNativeSlugsBySelector: Map<string, readonly string[]>;
  accountNativeSlugs: string[];
  desktopInputs: DesktopDiscoveryInputs;
  desktopNativeSlugs: string[];
  goOrdered: CatalogModel[];
  nativeFastEligible: (metadataId: string) => boolean;
  catalogRowFastEligible: (m: { provider: string; id: string; native?: boolean; supportsServiceTier?: boolean }) => boolean;
}

export interface PublicModelListDeps {
  /** Route-test seam for the catalog gather; production uses management-api's fetchAllModels. */
  fetchAllModels?: (config: OcxConfig) => Promise<CatalogModel[]>;
  /** Route-test seam for the Cursor effort table. */
  loadCursorEffortTable?: (install: CursorInstall | undefined) => CursorEffortTable | null;
}

/**
 * Everything `/v1/models` computes before a response shape is chosen.
 *
 * The gather is identical to what the endpoint used to do inline: the routed
 * catalog fetch and the entitlement resolution run concurrently, so a
 * CatalogGatherBusyError from either surfaces exactly as before.
 */
export async function loadPublicModelUniverse(
  config: OcxConfig,
  options: {
    clientVersion?: string | null;
    signal?: AbortSignal;
    fetchAllModels?: (config: OcxConfig) => Promise<CatalogModel[]>;
  } = {},
): Promise<PublicModelUniverse> {
  const fetchAll = options.fetchAllModels
    ?? (await import("../management-api")).fetchAllModels;
  const [goModels, modelEntitlements] = await Promise.all([
    fetchAll(config),
    // Codex sends its own client_version on this request, and upstream filters the
    // entitlement roster by it. Passing it through is what stops an entitled account
    // being told it cannot use models a newer client can (#2886).
    // The request signal fences the credential phase too: a client that has already
    // gone away must not keep a native-main token refresh alive, and its late result
    // must not commit on behalf of a request that no longer exists.
    resolveAdmittedCodexModelEntitlements(config, {
      clientVersion: options.clientVersion ?? null,
      signal: options.signal,
    }),
  ]);
  const { accountBoundNativeOpenAiSlugsBySelector, configuredNativeAliasSlugs, desktopAllowlistSuppressedNativeSlugs, disabledNativeSlugs, exactComboCatalogSlugs, NATIVE_OPENAI_MODELS, nativeOpenAiSlugs, shouldIncludeAccountBoundNativeOpenAi, shouldIncludeNativeOpenAi, visibleCodexAccountSelectors, desktopVisibleNativeSlugs } = await import("../../codex/catalog");
  const { ACCOUNT_GATED_NATIVE_OPENAI_MODELS } = await import("../../codex/catalog/native-models");
  const includeNativeOpenAi = shouldIncludeNativeOpenAi(config);
  const includeAccountBoundNativeOpenAi = shouldIncludeAccountBoundNativeOpenAi(config);
  const bareEligibleAccountIds = providerCodexAccountMode(
    OPENAI_CODEX_PROVIDER_ID,
    config.providers[OPENAI_CODEX_PROVIDER_ID],
  ) === "direct" ? new Set([MAIN_CODEX_ACCOUNT_ID]) : undefined;
  const availableBareGatedNativeSlugs = availableAccountGatedNativeModels(
    modelEntitlements,
    bareEligibleAccountIds,
  );
  const availableAccountGatedNativeSlugs = availableAccountGatedNativeModels(modelEntitlements);
  const availableBareNativeSlugs = NATIVE_OPENAI_MODELS.filter(slug => (
    !ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(slug) || availableBareGatedNativeSlugs.has(slug)
  ));
  const availableAccountNativeSlugs = NATIVE_OPENAI_MODELS.filter(slug => (
    !ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(slug) || availableAccountGatedNativeSlugs.has(slug)
  ));
  const nativeSlugs = includeNativeOpenAi
    ? nativeOpenAiSlugs().filter(slug => (
        !ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(slug) || availableBareGatedNativeSlugs.has(slug)
      ))
    : [];
  const disabledNatives = disabledNativeSlugs(config);
  const disabledModels = new Set(config.disabledModels ?? []);
  const exactComboSlugs = exactComboCatalogSlugs(config);
  const shadowedNativeSlugs = configuredNativeAliasSlugs(config);
  const suppressedBareNativeSlugs = new Set([
    ...desktopAllowlistSuppressedNativeSlugs(config),
    ...[...ACCOUNT_GATED_NATIVE_OPENAI_MODELS].filter(slug => !availableBareGatedNativeSlugs.has(slug)),
  ]);
  const accountSelectors = includeAccountBoundNativeOpenAi
    ? visibleCodexAccountSelectors(config)
    : [];
  const accountTargets = new Map(codexAccountNamespaceEntries(config));
  const accountNativeSlugsBySelector = includeAccountBoundNativeOpenAi
    ? new Map([...accountBoundNativeOpenAiSlugsBySelector(config)].map(([selector, slugs]) => {
      const target = accountTargets.get(selector);
      const accountId = target && isMainCodexAccountTarget(target) ? MAIN_CODEX_ACCOUNT_ID : target;
      return [selector, slugs.filter(slug => (
        !ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(slug)
        || (accountId !== undefined
          && codexModelEntitlementStateForAccount(modelEntitlements, accountId, slug) === "granted")
      ))] as const;
    }))
    : new Map<string, readonly string[]>();
  const accountNativeSlugs = [...new Set(
    [...accountNativeSlugsBySelector.values()].flatMap(slugs => [...slugs]),
  )];
  const desktopInputs = buildDesktopDiscoveryInputs({
    config, models: goModels, modelEntitlements,
    desktopNativeCandidates: desktopVisibleNativeSlugs(config),
  });
  const desktopNativeSlugs = desktopInputs.nativeSlugs;
  const goOrdered = desktopInputs.routedModels;
  /**
   * Whether a NATIVE slug may carry a Fast sibling.
   *
   * Both halves are required. Upstream asserts the tier per model — the same
   * `additional_speed_tiers` the Codex picker's own toggle is built from — but an
   * operator capability override or the final wire resolution can still make the
   * route ineligible, and `decideTier` would then drop the tier the row advertised.
   */
  const nativeFastEligible = (metadataId: string): boolean =>
    catalogFastRowEligible(config, { provider: OPENAI_CODEX_PROVIDER_ID, id: metadataId, native: true });
  /**
   * Whether a routed catalog row may carry a Fast sibling.
   *
   * A combo is its own namespace with no `config.providers` entry — declaring a
   * provider named `combo` is rejected (combos/types.ts:191) — so provider lookup
   * cannot classify it. Its aggregated `supportsServiceTier` is already true only
   * when EVERY member supports the tier (aggregation.ts:201), which is the right
   * rule for a row that fans out to all of them.
   */
  const catalogRowFastEligible = (m: { provider: string; id: string; native?: boolean; supportsServiceTier?: boolean }): boolean =>
    catalogFastRowEligible(config, m);
  return {
    goModels,
    modelEntitlements,
    includeNativeOpenAi,
    includeAccountBoundNativeOpenAi,
    availableBareGatedNativeSlugs,
    availableAccountGatedNativeSlugs,
    availableBareNativeSlugs,
    availableAccountNativeSlugs,
    nativeSlugs,
    disabledNatives,
    disabledModels,
    exactComboSlugs,
    shadowedNativeSlugs,
    suppressedBareNativeSlugs,
    accountSelectors,
    accountNativeSlugsBySelector,
    accountNativeSlugs,
    desktopInputs,
    desktopNativeSlugs,
    goOrdered,
    nativeFastEligible,
    catalogRowFastEligible,
  };
}

/**
 * The OpenAI-list rows for one admission, in endpoint order. Every entry's
 * `destination` names where a request for the row's `id` would bill; it is
 * internal metadata and must be stripped before JSON serialization.
 */
export async function buildPublicModelRows(
  config: OcxConfig,
  admission: DataPlaneAdmission | undefined,
  universe: PublicModelUniverse,
  deps: PublicModelListDeps = {},
): Promise<PublicModelRow[]> {
  const {
    goOrdered,
    includeNativeOpenAi,
    availableBareNativeSlugs,
    disabledNatives,
    disabledModels,
    exactComboSlugs,
    shadowedNativeSlugs,
    accountSelectors,
    accountNativeSlugsBySelector,
    nativeFastEligible,
    catalogRowFastEligible,
  } = universe;
  const { uniqueCatalogModelsForRawPublicList, nativeContextLimits, nativeInputModalities, nativeOpenAiContextTier, nativeOpenAiContextWindow, nativeOpenAiMaxOutputTokens, nativeReasoningEfforts, nativeDefaultReasoningEffort, visibleNativeSlugs } = await import("../../codex/catalog");
  const grokEffortOption = (value: string, isDefault: boolean) => ({
    value,
    label: `${value[0].toUpperCase()}${value.slice(1)} Effort`,
    ...(isDefault ? { default: true } : {}),
  });
  const grokEffortFields = (efforts: string[], configuredDefault?: string) => {
    const defaultEffort = grokDefaultReasoningEffort(efforts, configuredDefault);
    if (defaultEffort === undefined) return {};
    return {
      supports_reasoning_effort: true,
      reasoning_effort: defaultEffort,
      reasoning_efforts: efforts.map(effort => grokEffortOption(effort, effort === defaultEffort)),
    };
  };
  // Cursor's local-agent runtime (Private Inference build) reads api_types + capabilities
  // to enable its effort control; every other consumer ignores them. See
  // src/server/models-capabilities.ts.
  const nativeLimits = nativeContextLimits(config);
  const nativeContextInput = (metadataId: string) => {
    const tier = nativeOpenAiContextTier(metadataId, nativeLimits);
    return tier
      ? { contextWindow: tier.defaultWindow, longContextWindow: tier.longWindow }
      : { contextWindow: nativeOpenAiContextWindow(metadataId, nativeLimits) };
  };
  const nativeModelRow = (id: string, metadataId = id) => ({
      id,
      object: "model",
      created: 0,
      owned_by: "openai",
      ...grokEffortFields(
        nativeReasoningEfforts(metadataId),
        nativeDefaultReasoningEffort(metadataId),
      ),
      ...modelCapabilityFields({
        reasoningEfforts: nativeReasoningEfforts(metadataId),
        // Cursor "Max Mode": advertise the family's default/long pair (272k/922k for
        // GPT-5.6) so the client can pick per request; without a tier, the effective
        // window is the only value.
        ...nativeContextInput(metadataId),
        maxOutputTokens: nativeOpenAiMaxOutputTokens(metadataId),
        inputModalities: nativeInputModalities(metadataId),
      }),
    });
  // Resolved once per request, not per model: the global fast switch offers the fast
  // identity to clients that have no Fast toggle of their own. Null when the switch is
  // off, so the row mapper does no work and loads no adapter module.
  const cursorFastIdForListing = config.fastMode === true
    ? await (async () => {
      const { cursorFastIdFor } = await import("../../adapters/cursor/catalog");
      return (modelId: string, provider = "cursor") => provider === "cursor" ? cursorFastIdFor(modelId) : undefined;
    })()
    : null;
  // Selector-active discovery follows the same complete supported set as the Codex catalog
  // for both bare and qualified rows. Without selectors, the live catalog continues to own
  // bare availability.
  const selectorNativeSlugs = accountSelectors.length > 0
    ? availableBareNativeSlugs.filter(slug => !disabledNatives.has(slug))
    : [];
  const bareSelectorNativeSlugs = accountSelectors.length > 0
    ? selectorNativeSlugs
    : [];
  const visibleNatives = includeNativeOpenAi
    ? accountSelectors.length > 0
      ? bareSelectorNativeSlugs.filter(slug => !shadowedNativeSlugs.has(slug))
      : visibleNativeSlugs(config)
    : [];
  const visibleAccountNatives = accountSelectors.flatMap(selector =>
    (accountNativeSlugsBySelector.get(selector) ?? []).filter(metadataId => !disabledNatives.has(metadataId)).flatMap(metadataId => {
      const id = `${selector}/${metadataId}`;
      return disabledModels.has(id) ? [] : [{ id, metadataId }];
    })
  );
  // What a scoped key may see, filtered by the same predicate that refuses
  // it on the data plane, so the catalog and the send path cannot disagree.
  // This is a convenience, never the boundary: hiding a row only stops a
  // client that reads the catalog first, which is why the refusal lives on
  // the request path and this filter reuses it rather than replacing it.
  // Filtering happens where the resolved provider and model are still in
  // hand -- a published id is a selector, and re-resolving one here would
  // re-run combo selection just to render a list.
  const listScope = resolveAdmissionModelScope(config, admission);
  const listAllows = (providerName: string, modelId: string): boolean =>
    routeAllowedByScope(listScope, { providerName, modelId });
  // The projection is opt-in. Keep the default path free of Cursor install detection,
  // and resolve the bundle table once for the whole list rather than once per row.
  const effortRowsEnabled = config.cursorEffortRows === true;
  // Explicit opt-out skips policy resolution and additional rows.
  const fastRowsEnabled = config.fastRows !== false;
  // One inventory serves both grammars; building it twice would double the work on a
  // hot path for no benefit.
  const effortRowKnownIds = effortRowsEnabled || fastRowsEnabled
    ? knownEffortRowIds(config)
    : undefined;
  const privateInference = effortRowsEnabled
    ? detectCursorInstalls().find(install => install.build === "private-inference")
    : undefined;
  const cursorEffortTable = effortRowsEnabled
    ? (deps.loadCursorEffortTable ?? loadCursorEffortTable)(privateInference)
    : null;
  const expandedNativeModelRow = (id: string, metadataId = id) => {
    const reasoningEfforts = nativeReasoningEfforts(metadataId);
    return expandCursorEffortRow(nativeModelRow(id, metadataId), reasoningEfforts, config, {
      knownIds: effortRowKnownIds,
      table: cursorEffortTable,
      supportsReasoning: reasoningEfforts.length > 0,
    }).flatMap(row => expandFastRow(
      row,
      // Only the BASE row earns a fast sibling. An effort row already spent the
      // grammar, and the parser requires the stripped base to be routable, so
      // `<base>--<effort>--fast` would publish a row no ingress can resolve.
      row.id === id && nativeFastEligible(metadataId),
      config,
      effortRowKnownIds,
    ));
  };
  const routedRows = await Promise.all(uniqueCatalogModelsForRawPublicList(goOrdered)
    .filter(m => listAllows(m.provider, m.id))
    .map(async m => {
    // Same rule as the anthropic branch: with the global fast switch on, a client
    // that has no Fast toggle is offered the fast identity directly. An operator
    // alias is an explicit decision and still wins.
    const fastModelId = cursorFastIdForListing?.(m.id, m.provider);
    const publicId = m.alias ?? `${m.provider}/${fastModelId ?? m.id}`;
    const isCombo = m.provider === "combo" && exactComboSlugs.has(publicId);
    const provider = config.providers[m.provider];
    const effective = provider
      ? (await import("../../providers/default-aliases")).effectiveModelAliases(
          config,
          provider,
          knownModelIdsForProvider(m.provider, provider, config),
        ).get(m.id)
      : undefined;
    const row = {
      id: publicId,
      object: "model",
      created: 0,
      // This endpoint is an OpenAI-compatible inbound contract. Some clients use
      // owned_by as an adapter selector, so a virtual combo must name that wire
      // adapter rather than the internal catalog authority marker.
      owned_by: isCombo ? "openai" : (m.owned_by ?? m.provider),
      ...(isCombo ? { is_combo: true } : {}),
      ...(effective ? { alias_of: `${provider?.alias || m.provider}/${effective.alias}` } : {}),
      ...grokEffortFields(m.reasoningEfforts ?? [], m.defaultReasoningEffort),
      ...modelCapabilityFields({
        reasoningEfforts: m.reasoningEfforts,
        // contextWindow is already the post-cap effective value; contextCap is the raw
        // operator knob and over-reports models whose real window sits below it.
        contextWindow: m.contextWindow,
        maxOutputTokens: m.maxOutputTokens,
        inputModalities: m.inputModalities,
      }),
    };
    return expandCursorEffortRow(row, m.reasoningEfforts, config, {
      knownIds: effortRowKnownIds,
      table: cursorEffortTable,
      supportsReasoning: (m.reasoningEfforts ?? []).length > 0,
    }).flatMap(expanded => expandFastRow(
      expanded,
      expanded.id === row.id && catalogRowFastEligible(m),
      config,
      effortRowKnownIds,
    )).map((expanded): PublicModelRow => ({
      row: expanded,
      destination: { providerName: m.provider, modelId: m.id },
    }));
  }));
  return [
    ...visibleNatives
      .filter(id => listAllows(OPENAI_CODEX_PROVIDER_ID, id))
      .flatMap(id => expandedNativeModelRow(id).map((row): PublicModelRow => ({
        row,
        destination: { providerName: OPENAI_CODEX_PROVIDER_ID, modelId: id },
      }))),
    ...visibleAccountNatives
      .filter(({ metadataId }) => listAllows(OPENAI_CODEX_PROVIDER_ID, metadataId))
      .flatMap(({ id, metadataId }) => expandedNativeModelRow(id, metadataId).map((row): PublicModelRow => ({
        row,
        destination: { providerName: OPENAI_CODEX_PROVIDER_ID, modelId: metadataId },
      }))),
    ...routedRows.flat(),
  ];
}

/**
 * One-shot projection for callers that do not already hold a universe —
 * `/v1/catalog` scope filtering and the management scope-options picker.
 */
export async function listPublicModelRows(
  config: OcxConfig,
  admission: DataPlaneAdmission | undefined,
  deps: PublicModelListDeps = {},
): Promise<PublicModelRow[]> {
  const universe = await loadPublicModelUniverse(config, {
    fetchAllModels: deps.fetchAllModels,
  });
  return buildPublicModelRows(config, admission, universe, deps);
}
