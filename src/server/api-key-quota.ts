/**
 * Rolling-window USD spend quotas for `ocx_data_` API keys.
 *
 * Per-key state is a sparse `Map<minuteEpoch, bucket>` covering at most the
 * last 30 days; each bucket holds a USD total and an unpriced-request count.
 * Rows are priced with the same pure estimator the management surfaces use
 * (`src/usage/entry-cost.ts`), never through a server module.
 *
 * Spend arrives two ways:
 *   - the usage-entry observer (registered before the warm-up scan starts),
 *     which applies every row appended while this process is alive;
 *   - a one-time cooperative ledger scan for rows that predate the process.
 * A row appended while the scan runs could be visible to BOTH, so its
 * requestId goes into a dedupe set the scan consults; the set is cleared when
 * warm-up finishes.
 *
 * Only rows with `admissionKind === "configured"` and a non-empty `apiKeyId`
 * ever enter the buckets — environment and loopback traffic is unattributable
 * to a key and must not consume one. The warm-up scan additionally requires
 * the id to name a configured key, since a hand-edited ledger can carry ids
 * the config no longer has; the live observer does not, so a key created
 * after warm-up still accrues spend before the next reconcile.
 */
import type { OcxApiKeyEntry, OcxApiKeyQuota, OcxConfig } from "../types";
import type { DataPlaneAdmission } from "./auth-cors";
import { setUsageEntryObserver, type PersistedUsageEntry } from "../usage/log";
import { scanUsageLedgerCooperatively } from "../usage/ledger-scanner";
import { estimateUsageEntryCostUsd } from "../usage/entry-cost";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 30 * DAY_MS;

interface MinuteBucket {
  usd: number;
  unpriced: number;
}

export interface ApiKeyQuotaSpend {
  dailyUsd: number;
  weeklyUsd: number;
  monthlyUsd: number;
  unpricedRequests: number;
}

export type ApiKeyQuotaWindow = "daily" | "weekly" | "monthly";

const QUOTA_WINDOWS: ReadonlyArray<{ window: ApiKeyQuotaWindow; ms: number; field: keyof OcxApiKeyQuota }> = [
  { window: "daily", ms: DAY_MS, field: "dailyUsd" },
  { window: "weekly", ms: WEEK_MS, field: "weeklyUsd" },
  { window: "monthly", ms: MONTH_MS, field: "monthlyUsd" },
];

/** keyId -> minuteEpoch -> bucket. Only configured-key rows ever land here. */
const buckets = new Map<string, Map<number, MinuteBucket>>();
/** keyId -> last minuteEpoch its buckets were pruned — pruning runs at most once per minute per key. */
const lastPrunedMinute = new Map<string, number>();
let configuredKeyIds = new Set<string>();
let observerRegistered = false;
let warmFlight: Promise<void> | null = null;
let warmComplete = false;
const warmDedupeIds = new Set<string>();

/**
 * Same guard `createApiKeyUsageAccumulator` uses: usage.jsonl is hand-editable
 * and JSON permits numbers outside the Date range, which would throw
 * `RangeError` out of the date arithmetic below.
 */
function usableTimestamp(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Number.isNaN(new Date(value).getTime()) ? null : value;
}

/** Positive finite limit, or 0 for "unlimited" (absent, zero, or malformed). */
function quotaLimit(entry: OcxApiKeyEntry, field: keyof OcxApiKeyQuota): number {
  const value = entry.quota?.[field];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function hasNonZeroQuota(quota: OcxApiKeyQuota | undefined): boolean {
  return QUOTA_WINDOWS.some(({ field }) => {
    const value = quota?.[field];
    return typeof value === "number" && Number.isFinite(value) && value > 0;
  });
}

function quotaResetAtMs(entry: OcxApiKeyEntry | undefined): number | null {
  if (!entry?.quotaResetAt) return null;
  const parsed = Date.parse(entry.quotaResetAt);
  return Number.isFinite(parsed) ? parsed : null;
}

function pruneKeyBuckets(keyBuckets: Map<number, MinuteBucket>, retainAfterMs: number): void {
  for (const minute of keyBuckets.keys()) {
    if (minute * MINUTE_MS < retainAfterMs) keyBuckets.delete(minute);
  }
}

function applyUsageEntry(entry: PersistedUsageEntry, now: number, options?: { requireConfiguredKey?: boolean }): void {
  if (entry.admissionKind !== "configured") return;
  const keyId = entry.apiKeyId;
  if (!keyId) return;
  if (options?.requireConfiguredKey === true && !configuredKeyIds.has(keyId)) return;
  const timestamp = usableTimestamp(entry.timestamp);
  if (timestamp === null) return;
  const retainAfter = now - MONTH_MS;
  if (timestamp < retainAfter) return;
  const minute = Math.floor(timestamp / MINUTE_MS);
  let keyBuckets = buckets.get(keyId);
  if (!keyBuckets) {
    keyBuckets = new Map();
    buckets.set(keyId, keyBuckets);
  }
  const bucket = keyBuckets.get(minute) ?? { usd: 0, unpriced: 0 };
  const usd = estimateUsageEntryCostUsd(entry);
  if (usd === null) bucket.unpriced += 1;
  else bucket.usd += usd;
  keyBuckets.set(minute, bucket);
  // Pruning is memory hygiene only — windowTotals already ignores buckets
  // older than 30 days — so it is amortized to once per minute per key rather
  // than scanning the whole map on every applied row.
  const nowMinute = Math.floor(now / MINUTE_MS);
  if (lastPrunedMinute.get(keyId) !== nowMinute) {
    lastPrunedMinute.set(keyId, nowMinute);
    pruneKeyBuckets(keyBuckets, retainAfter);
  }
}

function onUsageEntryAppended(entry: PersistedUsageEntry): void {
  if (!warmComplete) warmDedupeIds.add(entry.requestId);
  applyUsageEntry(entry, Date.now());
}

/**
 * Re-point the tracker at the config's current key set. Buckets keyed by an id
 * the config no longer has are dropped — a key removed by a hand edit is
 * forgotten the same way an API delete forgets it.
 */
export function reconcileApiKeyQuotaKeys(config: OcxConfig): void {
  configuredKeyIds = new Set((config.apiKeys ?? []).map(entry => entry.id));
  for (const keyId of buckets.keys()) {
    if (!configuredKeyIds.has(keyId)) buckets.delete(keyId);
  }
  for (const keyId of lastPrunedMinute.keys()) {
    if (!configuredKeyIds.has(keyId)) lastPrunedMinute.delete(keyId);
  }
}

/**
 * One-time lazy warm-up shared by every caller. The observer is registered
 * BEFORE the scan starts so a row appended during the scan is applied live and
 * skipped by requestId in the scan — never double-counted, never missed. A
 * scan failure resolves quietly: live rows keep the tracker correct from then
 * on, and requests are never crashed by ledger state.
 */
async function ensureQuotaWarmed(): Promise<void> {
  if (warmComplete) return;
  if (warmFlight) return warmFlight;
  if (!observerRegistered) {
    setUsageEntryObserver(onUsageEntryAppended);
    observerRegistered = true;
  }
  const flight = (async () => {
    try {
      await scanUsageLedgerCooperatively({
        onEntry: entry => {
          if (warmDedupeIds.has(entry.requestId)) return;
          applyUsageEntry(entry, Date.now(), { requireConfiguredKey: true });
        },
      });
    } catch {
      /* a partial or failed scan must not take requests down; live rows continue */
    }
    warmComplete = true;
    warmDedupeIds.clear();
  })();
  warmFlight = flight;
  try {
    await flight;
  } finally {
    if (warmFlight === flight) warmFlight = null;
  }
}

/**
 * Startup trigger: synchronously decide whether any configured key carries a
 * non-zero limit and, when one does, launch warm-up without awaiting it. Must
 * stay synchronous — the composition root calls it inside startServer's
 * synchronous window.
 */
export function warmApiKeyQuotaIfConfigured(config: OcxConfig): void {
  reconcileApiKeyQuotaKeys(config);
  if (!(config.apiKeys ?? []).some(entry => hasNonZeroQuota(entry.quota))) return;
  void ensureQuotaWarmed();
}

interface WindowTotals {
  usd: number;
  unpriced: number;
  oldestMinute: number | null;
}

/** Sum buckets whose minute START is at least max(now - windowMs, quotaResetAt). */
function windowTotals(
  keyId: string,
  windowMs: number,
  now: number,
  resetAtMs: number | null,
): WindowTotals {
  const cutoff = Math.max(now - windowMs, resetAtMs ?? Number.NEGATIVE_INFINITY);
  const totals: WindowTotals = { usd: 0, unpriced: 0, oldestMinute: null };
  const keyBuckets = buckets.get(keyId);
  if (!keyBuckets) return totals;
  for (const [minute, bucket] of keyBuckets) {
    if (minute * MINUTE_MS < cutoff) continue;
    totals.usd += bucket.usd;
    totals.unpriced += bucket.unpriced;
    if (totals.oldestMinute === null || minute < totals.oldestMinute) {
      totals.oldestMinute = minute;
    }
  }
  return totals;
}

/**
 * Current rolling spend for one key. Awaiting it performs the lazy warm-up, so
 * the first GET /api/keys is also a warm-up trigger.
 */
export async function getApiKeySpend(
  config: OcxConfig,
  keyId: string,
  nowMs: number = Date.now(),
): Promise<ApiKeyQuotaSpend> {
  reconcileApiKeyQuotaKeys(config);
  await ensureQuotaWarmed();
  const entry = (config.apiKeys ?? []).find(candidate => candidate.id === keyId);
  const resetAtMs = quotaResetAtMs(entry);
  const daily = windowTotals(keyId, DAY_MS, nowMs, resetAtMs);
  const weekly = windowTotals(keyId, WEEK_MS, nowMs, resetAtMs);
  const monthly = windowTotals(keyId, MONTH_MS, nowMs, resetAtMs);
  return {
    dailyUsd: daily.usd,
    weeklyUsd: weekly.usd,
    monthlyUsd: monthly.usd,
    unpricedRequests: monthly.unpriced,
  };
}

/**
 * Admission-time quota check for one data-plane request.
 *
 * Returns undefined fast — synchronously and without touching warm-up — when
 * the admission is not a configured key or the key has no non-zero limit.
 * Otherwise the first exceeded window (daily, then weekly, then monthly)
 * produces a bare 429 JSON response; the call site wraps it in the same CORS
 * decorator every other denial uses.
 */
export async function apiKeyQuotaDenial(
  config: OcxConfig,
  admission: DataPlaneAdmission | undefined,
  nowMs: number = Date.now(),
): Promise<Response | undefined> {
  if (!admission || admission.kind !== "configured") return undefined;
  const entry = (config.apiKeys ?? []).find(candidate => candidate.id === admission.keyId);
  if (!entry || !hasNonZeroQuota(entry.quota)) return undefined;
  reconcileApiKeyQuotaKeys(config);
  await ensureQuotaWarmed();
  const resetAtMs = quotaResetAtMs(entry);
  for (const { window, ms, field } of QUOTA_WINDOWS) {
    const limit = quotaLimit(entry, field);
    if (limit <= 0) continue;
    const totals = windowTotals(entry.id, ms, nowMs, resetAtMs);
    if (totals.usd < limit) continue;
    // The denial lifts when the OLDEST contributing bucket ages out of this
    // window: its last second expires (minute+1)*MINUTE_MS + ms after epoch.
    const retryAfter = totals.oldestMinute === null
      ? 1
      : Math.max(1, Math.min(
        Math.ceil(((totals.oldestMinute + 1) * MINUTE_MS + ms - nowMs) / 1000),
        Math.ceil(ms / 1000),
      ));
    return new Response(JSON.stringify({
      error: {
        type: "api_key_quota_exceeded",
        window,
        limitUsd: limit,
        spentUsd: totals.usd,
        message: `API key ${window} quota exceeded`,
      },
    }), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": String(retryAfter) },
    });
  }
  return undefined;
}

/** Clear one key's in-memory buckets (pairs with a persisted quotaResetAt). */
export function resetApiKeyQuota(keyId: string): void {
  buckets.delete(keyId);
  lastPrunedMinute.delete(keyId);
}

/** Clear every key's in-memory buckets (pairs with a global quotaResetAt). */
export function resetAllApiKeyQuotas(): void {
  buckets.clear();
  lastPrunedMinute.clear();
}

/** Forget one key entirely: spend state and its configured-id slot. */
export function forgetApiKey(keyId: string): void {
  buckets.delete(keyId);
  lastPrunedMinute.delete(keyId);
  configuredKeyIds.delete(keyId);
}

/** Test seam: module state is process-wide and would otherwise leak between cases. */
export function resetApiKeyQuotaStateForTests(): void {
  buckets.clear();
  lastPrunedMinute.clear();
  configuredKeyIds = new Set();
  observerRegistered = false;
  warmFlight = null;
  warmComplete = false;
  warmDedupeIds.clear();
  setUsageEntryObserver(null);
}
