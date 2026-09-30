import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  apiKeyQuotaDenial,
  forgetApiKey,
  getApiKeySpend,
  resetAllApiKeyQuotas,
  resetApiKeyQuota,
  resetApiKeyQuotaStateForTests,
} from "../../src/server/api-key-quota";
import { saveConfig } from "../../src/config";
import { appendUsageEntry, usageLogPath, type PersistedUsageEntry } from "../../src/usage/log";
import { refreshUserCostOverlays } from "../../src/usage/user-cost-overlays";
import { startServer } from "../../src/server";
import type { DataPlaneAdmission } from "../../src/server/auth-cors";
import type { OcxApiKeyEntry, OcxApiKeyQuota, OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// Unit coverage for the rolling-window quota tracker. Rows are priced through a
// user cost overlay on the `mock` provider ($1 per 1M tokens on either side), so
// a row carrying 1M input tokens lands as exactly $1 of spend.

const KEY_ID = "key-1";
const KEY = `ocx_data_${"a".repeat(40)}`;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const previousHome = process.env.OPENCODEX_HOME;
let testHome = "";

function baseConfig(quota?: OcxApiKeyQuota, keyPatch: Partial<OcxApiKeyEntry> = {}): OcxConfig {
  return {
    port: 0,
    defaultProvider: "mock",
    providers: {
      mock: {
        adapter: "openai-chat",
        baseUrl: "https://example.test/v1",
        apiKey: "provider-credential-placeholder",
        models: ["m"],
        modelCosts: { m: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
      },
    },
    apiKeys: [{ id: KEY_ID, name: "tracked", key: KEY, createdAt: "2026-01-01T00:00:00.000Z", ...(quota ? { quota } : {}), ...keyPatch }],
  } as OcxConfig;
}

function configuredAdmission(keyId = KEY_ID): DataPlaneAdmission {
  return { kind: "configured", keyId, source: "bearer" };
}

/** One usage row worth $1 on the `mock` provider, attributed to the test key. */
function pricedRow(overrides: Partial<PersistedUsageEntry> = {}): PersistedUsageEntry {
  return {
    requestId: `r-${Math.random().toString(36).slice(2)}`,
    timestamp: Date.now(),
    provider: "mock",
    model: "m",
    apiKeyId: KEY_ID,
    admissionKind: "configured",
    status: 200,
    durationMs: 10,
    usageStatus: "reported",
    usage: { inputTokens: 1_000_000, outputTokens: 0 },
    ...overrides,
  };
}

/** A ledger row the warm-up scan sees: same shape appendUsageEntry writes. */
function seedLedger(...rows: PersistedUsageEntry[]): void {
  appendFileSync(usageLogPath(), rows.map(row => `${JSON.stringify(row)}\n`).join(""), "utf-8");
}

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "ocx-api-key-quota-"));
  process.env.OPENCODEX_HOME = testHome;
  resetApiKeyQuotaStateForTests();
  refreshUserCostOverlays(baseConfig());
});

afterEach(() => {
  resetApiKeyQuotaStateForTests();
  refreshUserCostOverlays({ providers: {} } as OcxConfig);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testHome) removeTreeWithRetry(testHome);
  testHome = "";
});

describe("rolling spend windows", () => {
  test("daily, weekly and monthly sums roll independently and a row older than 30d is pruned", async () => {
    const now = Date.now();
    seedLedger(
      pricedRow({ timestamp: now - HOUR }),          // all three windows
      pricedRow({ timestamp: now - 2 * DAY }),       // weekly + monthly
      pricedRow({ timestamp: now - 10 * DAY }),      // monthly only
      pricedRow({ timestamp: now - 31 * DAY }),      // outside every window
    );

    const spend = await getApiKeySpend(baseConfig(), KEY_ID);
    expect(spend).toEqual({ dailyUsd: 1, weeklyUsd: 2, monthlyUsd: 3, unpricedRequests: 0 });
  });

  test("quotaResetAt cuts spend off at the reset instant even inside the rolling window", async () => {
    const now = Date.now();
    const config = baseConfig({ dailyUsd: 5 }, { quotaResetAt: new Date(now - 12 * HOUR).toISOString() });
    seedLedger(
      pricedRow({ timestamp: now - 20 * HOUR }), // before the reset: still in 24h, must not count
      pricedRow({ timestamp: now - HOUR }),      // after the reset
    );

    const spend = await getApiKeySpend(config, KEY_ID);
    expect(spend.dailyUsd).toBe(1);
    expect(spend.monthlyUsd).toBe(1);
  });

  test("a row arriving while the ledger scan is in flight is counted exactly once", async () => {
    // >1000 rows forces at least one cooperative yield inside the warm-up scan,
    // which is the only window where an append can interleave with it. The
    // filler rows name an id no configured key owns, so only the two $1 rows
    // can land in the key's buckets.
    const fillers = Array.from({ length: 1200 }, (_, index) => pricedRow({
      requestId: `filler-${index}`,
      apiKeyId: "not-a-configured-key",
    }));
    seedLedger(pricedRow({ requestId: "pre-scan" }), ...fillers);

    const spendPromise = getApiKeySpend(baseConfig(), KEY_ID);
    // The observer is registered and the scan launched synchronously inside
    // getApiKeySpend, so this append lands mid-flight: the observer applies it
    // live while the scan boundary was already captured before it existed.
    appendUsageEntry(pricedRow({ requestId: "during-scan" }));
    const spend = await spendPromise;

    expect(spend.dailyUsd).toBe(2);
    // If the scan had counted the appended row a second time the total would be 3.
    expect(spend.monthlyUsd).toBe(2);
  });

  test("unpriced rows count as requests at $0", async () => {
    seedLedger(
      pricedRow(),
      pricedRow({ provider: "unpriced", model: "no-such-model" }),
    );

    const spend = await getApiKeySpend(baseConfig(), KEY_ID);
    expect(spend.dailyUsd).toBe(1);
    expect(spend.unpricedRequests).toBe(1);
  });

  test("a key created after warm-up accrues spend through the live observer", async () => {
    const config = baseConfig({ dailyUsd: 5 });
    // Warm the tracker before the second key exists anywhere.
    await getApiKeySpend(config, KEY_ID);
    const newKey: OcxApiKeyEntry = {
      id: "key-late", name: "late", key: `ocx_data_${"c".repeat(40)}`, createdAt: "2026-01-01T00:00:00.000Z",
    };
    config.apiKeys = [...(config.apiKeys ?? []), newKey];
    // configuredKeyIds inside the tracker still predates key-late: the observer
    // must attribute the row anyway or the new key's spend would silently drop.
    appendUsageEntry(pricedRow({ apiKeyId: "key-late" }));

    const spend = await getApiKeySpend(config, "key-late");
    expect(spend.dailyUsd).toBe(1);
  });

  test("rows attributed to another kind of admission never consume a configured key's quota", async () => {
    seedLedger(
      pricedRow({ admissionKind: "environment" }),
      pricedRow({ admissionKind: "loopback" }),
      pricedRow({ apiKeyId: "some-other-key" }),
    );

    const spend = await getApiKeySpend(baseConfig(), KEY_ID);
    expect(spend).toEqual({ dailyUsd: 0, weeklyUsd: 0, monthlyUsd: 0, unpricedRequests: 0 });
  });
});

describe("quota denial", () => {
  test("a configured key over its daily limit gets the specified 429 shape and Retry-After", async () => {
    const now = Date.now();
    seedLedger(pricedRow({ timestamp: now - HOUR }));
    const config = baseConfig({ dailyUsd: 0.5 });

    const denial = await apiKeyQuotaDenial(config, configuredAdmission(), now);
    expect(denial).not.toBeUndefined();
    expect(denial!.status).toBe(429);
    expect(denial!.headers.get("content-type")).toContain("application/json");
    const retryAfter = Number(denial!.headers.get("retry-after"));
    expect(Number.isFinite(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(24 * 3600);
    expect(await denial!.json()).toEqual({
      error: {
        type: "api_key_quota_exceeded",
        window: "daily",
        limitUsd: 0.5,
        spentUsd: 1,
        message: "API key daily quota exceeded",
      },
    });
  });

  test("weekly is reported before monthly when both are over", async () => {
    seedLedger(pricedRow(), pricedRow());
    const config = baseConfig({ weeklyUsd: 1, monthlyUsd: 1 });

    const denial = await apiKeyQuotaDenial(config, configuredAdmission());
    expect(await denial!.json()).toMatchObject({ error: { window: "weekly" } });
  });

  test("zero and absent quotas never refuse, however much was spent", async () => {
    seedLedger(pricedRow(), pricedRow(), pricedRow());
    expect(await apiKeyQuotaDenial(baseConfig(), configuredAdmission())).toBeUndefined();
    expect(await apiKeyQuotaDenial(baseConfig({ dailyUsd: 0 }), configuredAdmission())).toBeUndefined();
    expect(await apiKeyQuotaDenial(baseConfig({ dailyUsd: 0, weeklyUsd: 0, monthlyUsd: 0 }), configuredAdmission())).toBeUndefined();
  });

  test("environment and loopback admissions are never gated", async () => {
    seedLedger(pricedRow());
    const config = baseConfig({ dailyUsd: 0.5 });
    expect(await apiKeyQuotaDenial(config, { kind: "environment", source: "bearer" })).toBeUndefined();
    expect(await apiKeyQuotaDenial(config, { kind: "loopback", source: "loopback" })).toBeUndefined();
    // An id that does not name a configured key cannot trip the gate either.
    expect(await apiKeyQuotaDenial(config, configuredAdmission("no-such-key"))).toBeUndefined();
  });
});

describe("reset and forget", () => {
  test("resetApiKeyQuota drops one key's buckets without touching another's", async () => {
    const other: OcxApiKeyEntry = { id: "key-2", name: "other", key: `ocx_data_${"b".repeat(40)}`, createdAt: "2026-01-01T00:00:00.000Z" };
    const config = baseConfig();
    config.apiKeys = [...(config.apiKeys ?? []), other];
    seedLedger(pricedRow(), pricedRow({ apiKeyId: "key-2" }));

    expect((await getApiKeySpend(config, KEY_ID)).dailyUsd).toBe(1);
    expect((await getApiKeySpend(config, "key-2")).dailyUsd).toBe(1);

    resetApiKeyQuota(KEY_ID);
    expect((await getApiKeySpend(config, KEY_ID)).dailyUsd).toBe(0);
    expect((await getApiKeySpend(config, "key-2")).dailyUsd).toBe(1);
  });

  test("resetAllApiKeyQuotas clears every key", async () => {
    const config = baseConfig();
    seedLedger(pricedRow(), pricedRow());
    expect((await getApiKeySpend(config, KEY_ID)).monthlyUsd).toBe(2);

    resetAllApiKeyQuotas();
    const spend = await getApiKeySpend(config, KEY_ID);
    expect(spend).toEqual({ dailyUsd: 0, weeklyUsd: 0, monthlyUsd: 0, unpricedRequests: 0 });
  });

  test("forgetApiKey drops spend and stops attributing later rows to the id", async () => {
    const config = baseConfig();
    seedLedger(pricedRow());
    expect((await getApiKeySpend(config, KEY_ID)).dailyUsd).toBe(1);

    forgetApiKey(KEY_ID);
    expect((await getApiKeySpend(config, KEY_ID)).dailyUsd).toBe(0);
    // DELETE /api/keys also removes the entry from config, so a late row for the
    // forgotten id must not resurrect spend.
    config.apiKeys = [];
    appendUsageEntry(pricedRow());
    expect((await getApiKeySpend(config, KEY_ID)).dailyUsd).toBe(0);
  });
});

describe("data-plane admission", () => {
  test("a key over its daily quota gets 429 at the chat completions gate while an unlimited key proceeds", async () => {
    const freeKey = `ocx_data_${"b".repeat(40)}`;
    const config = baseConfig({ dailyUsd: 0.5 });
    // A non-loopback bind makes the data plane require credentials; the provider
    // itself is unreachable but that is past the gate under test.
    config.hostname = "0.0.0.0";
    config.providers.mock!.baseUrl = "http://127.0.0.1:1/v1";
    config.providers.mock!.liveModels = false;
    config.providers.mock!.allowPrivateNetwork = true;
    config.apiKeys = [
      ...(config.apiKeys ?? []),
      { id: "key-2", name: "free", key: freeKey, createdAt: "2026-01-01T00:00:00.000Z" },
    ];
    saveConfig(config);
    seedLedger(pricedRow());

    const server = startServer(0);
    try {
      const body = JSON.stringify({ model: "m", messages: [] });
      const denied = await fetch(new URL("/v1/chat/completions", server.url), {
        method: "POST",
        headers: { "content-type": "application/json", "x-opencodex-api-key": KEY },
        body,
      });
      expect(denied.status).toBe(429);
      const retryAfter = Number(denied.headers.get("retry-after"));
      expect(Number.isFinite(retryAfter)).toBe(true);
      expect(retryAfter).toBeGreaterThanOrEqual(1);
      expect(await denied.json()).toMatchObject({
        error: { type: "api_key_quota_exceeded", window: "daily", limitUsd: 0.5 },
      });

      const allowed = await fetch(new URL("/v1/chat/completions", server.url), {
        method: "POST",
        headers: { "content-type": "application/json", "x-opencodex-api-key": freeKey },
        body,
      });
      expect(allowed.status).not.toBe(429);
    } finally {
      await server.stop(true);
    }
  });
});
