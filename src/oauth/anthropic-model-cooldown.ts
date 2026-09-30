/** Model-family refusal and usage overlays carried from the Haly account pool. */
import { getCachedProviderAccountQuota } from "../providers/quota";

type AnthropicModelFamily = "fable" | "opus" | "sonnet" | "haiku";
interface AccountCooldown {
  cooldownUntil: number;
  cooldownSource: "retry-after" | "reset-derived" | "default";
}
export type ModelRateLimitHeaders = Pick<Headers, "get"> & Partial<Pick<Headers, "entries">>;
type AnthropicRateLimitHeaders = ModelRateLimitHeaders;
const PROVIDER = "anthropic";
const DEFAULT_COOLDOWN_MS = 60_000;
const health = new Map<string, Map<AnthropicModelFamily, AccountCooldown>>();

function delayUntil(timestamp: number, now: number): number | undefined {
  const delay = timestamp - now;
  return Number.isFinite(new Date(timestamp).getTime()) && Number.isFinite(delay) && delay > 0
    ? delay : undefined;
}

function parseRetryAfterMs(value: string | null | undefined, now: number): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
    return delayUntil(now + Math.max(Math.ceil(seconds * 1000), 1), now);
  }
  return delayUntil(Date.parse(text), now);
}

function anthropicModelFamily(modelId: string | null | undefined): AnthropicModelFamily | null {
  const normalized = modelId?.toLowerCase() ?? "";
  return (["fable", "opus", "sonnet", "haiku"] as const).find(family => normalized.includes(family)) ?? null;
}

function parseHeaderResetAt(value: string | null, now: number): number | undefined {
  const seconds = Number(value?.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  const resetAt = seconds * 1000;
  return delayUntil(resetAt, now) === undefined ? undefined : resetAt;
}

function familyScopedCooldown(
  headers: AnthropicRateLimitHeaders | null | undefined,
  retryAfterHeader: string | null | undefined,
  modelId: string | null | undefined,
  now: number,
): { family: AnthropicModelFamily; cooldown: AccountCooldown } | null {
  const family = anthropicModelFamily(modelId);
  if (!headers?.entries || !family) return null;
  const unifiedRejected = (["5h", "7d"] as const).some(window => {
    const utilization = Number(headers.get(`anthropic-ratelimit-unified-${window}-utilization`));
    return headers.get(`anthropic-ratelimit-unified-${window}-status`)?.trim() === "rejected"
      || Number.isFinite(utilization) && utilization >= 0.99;
  });
  if (unifiedRejected) return null;

  const buckets = new Map<string, { utilization?: number; status?: string; resetAt?: number }>();
  for (const [header, value] of headers.entries()) {
    const utilizationMatch = header.match(/^anthropic-ratelimit-unified-7d_([a-z0-9-]+)-utilization$/i);
    const statusMatch = header.match(/^anthropic-ratelimit-unified-7d_([a-z0-9-]+)-status$/i);
    const resetMatch = header.match(/^anthropic-ratelimit-unified-7d_([a-z0-9-]+)-reset$/i);
    const match = utilizationMatch ?? statusMatch ?? resetMatch;
    if (!match?.[1]) continue;
    const bucket = match[1].toLowerCase();
    const current = buckets.get(bucket) ?? {};
    if (utilizationMatch) {
      const utilization = Number(value);
      if (Number.isFinite(utilization) && utilization >= 0) current.utilization = utilization;
    } else if (statusMatch) {
      current.status = value.trim().toLowerCase();
    } else if (resetMatch) {
      current.resetAt = parseHeaderResetAt(value, now);
    }
    buckets.set(bucket, current);
  }

  const claim = headers.get("anthropic-ratelimit-unified-representative-claim")?.trim().toLowerCase() ?? "";
  const exhausted = [...buckets.entries()].filter(([bucket, value]) => {
    if (value.utilization === undefined || value.utilization < 0.99) return false;
    const bucketFamily = anthropicModelFamily(bucket);
    return bucketFamily === family
      || (bucket === "oi" && family === "fable")
      || value.status === "rejected"
      || (bucket === "oi" && claim.endsWith("_overage_included"));
  });
  if (exhausted.length === 0) return null;

  const globalWeeklyReset = parseHeaderResetAt(headers.get("anthropic-ratelimit-unified-7d-reset"), now);
  const resetAt = exhausted.reduce<number | undefined>((latest, [, value]) => {
    const candidate = value.resetAt ?? globalWeeklyReset;
    return candidate !== undefined && (latest === undefined || candidate > latest) ? candidate : latest;
  }, undefined);
  const retryAfter = parseRetryAfterMs(retryAfterHeader, now);
  return {
    family,
    cooldown: resetAt !== undefined
      ? { cooldownUntil: resetAt, cooldownSource: "reset-derived" }
      : retryAfter !== undefined
        ? { cooldownUntil: now + retryAfter, cooldownSource: "retry-after" }
        : { cooldownUntil: now + DEFAULT_COOLDOWN_MS, cooldownSource: "default" },
  };
}

export function modelFamilyUsageScore(accountId: string, modelId?: string | null): number | null {
  const family = anthropicModelFamily(modelId);
  if (!family) return null;
  const windows = getCachedProviderAccountQuota(PROVIDER, accountId)?.customWindows ?? [];
  const percents = windows
    .filter(window => anthropicModelFamily(window.label) === family
      || (family === "fable" && window.label.toLowerCase().includes("oi")))
    .map(window => window.percent)
    .filter((percent): percent is number => typeof percent === "number" && Number.isFinite(percent));
  return percents.length === 0 ? null : Math.max(...percents);
}

export function modelQuotaWindowExhausted(accountId: string, modelId?: string | null): boolean {
  const quota = getCachedProviderAccountQuota(PROVIDER, accountId);
  const family = anthropicModelFamily(modelId);
  const unified = [quota?.fiveHourPercent, quota?.weeklyPercent, quota?.monthlyPercent]
    .some(percent => typeof percent === "number" && percent >= 100);
  if (unified) return true;
  return (quota?.customWindows ?? []).some(window => {
    if (typeof window.percent !== "number" || window.percent < 100) return false;
    const label = window.label.toLowerCase();
    return !family || anthropicModelFamily(label) === family || (family === "fable" && label.includes("oi"));
  });
}

export function recordModelFamilyCooldown(
  accountId: string, headers: ModelRateLimitHeaders | null | undefined,
  retryAfter: string | null | undefined, modelId: string | null | undefined, now: number,
): boolean {
  const scoped = familyScopedCooldown(headers, retryAfter, modelId, now);
  if (!scoped) return false;
  const families = health.get(accountId) ?? new Map<AnthropicModelFamily, AccountCooldown>();
  families.set(scoped.family, scoped.cooldown);
  health.set(accountId, families);
  return true;
}

export function modelFamilyCooldown(accountId: string, now: number, modelId?: string | null): AccountCooldown | null {
  const families = health.get(accountId);
  if (!families) return null;
  for (const [family, cooldown] of families) if (cooldown.cooldownUntil <= now) families.delete(family);
  if (!families.size) health.delete(accountId);
  const family = anthropicModelFamily(modelId);
  const cooldown = family ? families.get(family) : undefined;
  return cooldown ? { ...cooldown } : null;
}

export function clearModelFamilyCooldown(accountId: string): boolean { return health.delete(accountId); }
export function clearModelFamilyCooldowns(): void { health.clear(); }
export function sweepModelFamilyCooldowns(now: number): number {
  const before = health.size;
  for (const accountId of health.keys()) modelFamilyCooldown(accountId, now);
  return before - health.size;
}
