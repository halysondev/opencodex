/**
 * Pure per-entry USD estimate for one persisted usage row.
 *
 * Lives in the usage domain rather than beside the management renderer it was
 * extracted from (`src/server/management/shared.ts` `costResult`) so the API-key
 * quota tracker can price rows without importing a server module. Both call
 * sites must produce identical numbers: the estimator inputs — attempt-level
 * combo pricing, `usageModelPriceOptions` fallback policy, and the service-tier
 * context — are exactly the ones the renderer used.
 */
import {
  estimateComboCost,
  estimateRequestCost,
  serviceTierContext,
  type CostEstimate,
} from "./cost";
import { usageModelPriceOptions } from "./model-identity";
import type { PersistedUsageAttempt, PersistedUsageEntry } from "./log";

/** The fields the estimator reads; `PersistedUsageEntry` satisfies it structurally. */
export type UsageEntryCostSource = Pick<
  PersistedUsageEntry,
  | "provider"
  | "model"
  | "usage"
  | "usageStatus"
  | "requestedServiceTier"
  | "configuredServiceTier"
  | "responseServiceTier"
  | "tierOutcome"
  | "routeDecision"
> & {
  attempts?: readonly PersistedUsageAttempt[];
};

/**
 * Full cost estimate for one row, or null when the row is unpriced (no usable
 * usage tokens, or no rate resolves for the provider/model pair).
 */
export function estimateUsageEntryCost(entry: UsageEntryCostSource): CostEstimate | null {
  const tier = serviceTierContext(entry);
  return entry.attempts?.length
    ? estimateComboCost(
      entry.attempts.map(attempt => ({ ...attempt, ...usageModelPriceOptions(entry, attempt) })),
      undefined,
      tier,
    )
    : estimateRequestCost({
      provider: entry.provider,
      model: entry.model,
      usage: entry.usage,
      usageStatus: entry.usageStatus,
      serviceTier: tier,
      ...usageModelPriceOptions(entry, entry),
    });
}

/** USD total for one row; null marks an unpriced row, which still counts as a request. */
export function estimateUsageEntryCostUsd(entry: UsageEntryCostSource): number | null {
  const estimate = estimateUsageEntryCost(entry);
  return estimate ? estimate.cost.total : null;
}
