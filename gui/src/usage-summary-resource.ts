/** Positive diagnostics only: an older response without the flag proves no completeness. */
export interface UsageReadMetadata {
  usageIncomplete?: true;
  usageIncompleteReason?: "oversized_rows";
}

export function readUsageMetadata(value: unknown): UsageReadMetadata {
  if (!value || typeof value !== "object" || !("usageIncomplete" in value) || value.usageIncomplete !== true) return {};
  return {
    usageIncomplete: true,
    ...("usageIncompleteReason" in value && value.usageIncompleteReason === "oversized_rows"
      ? { usageIncompleteReason: "oversized_rows" as const } : {}),
  };
}

/** Older daemons returned this failure as HTTP 200; never admit that envelope as usage data. */
export function isUsageReadFailure(value: unknown): boolean {
  return !!value && typeof value === "object" && "error" in value && value.error === "read_failed";
}

export function usageSummary30dResourceKey(apiBase: string, surface: "all" | "codex" = "all"): string {
  return surface === "codex"
    ? ["usage-summary-30d", apiBase, "codex"].join(":")
    : ["usage-summary-30d", apiBase, "all"].join(":");
}
