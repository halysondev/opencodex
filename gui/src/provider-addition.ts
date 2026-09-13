export interface ProviderAdditionMetadata {
  /** Adapter returned by the completed activation, independent of the caller's stale config snapshot. */
  adapter?: string;
}

/** Native ZCode activation is protocol/catalog-only and must not force an entitlement probe. */
export function forceQuotaRefreshAfterProviderAddition(metadata?: ProviderAdditionMetadata): boolean {
  return metadata?.adapter !== "zcode";
}
