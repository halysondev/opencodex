import { describe, expect, test } from "bun:test";
import { formatUsd, isApiKeyQuota, isApiKeySpend } from "../src/pages/api-keys-utils";

/*
 * Quota and spend ride in the same `/api/keys` payload as the key list. A
 * malformed entry must not drop a working credential, so these validators are
 * what `fetchKeys` and the session-cache reader trust before rendering a key.
 */

describe("isApiKeyQuota", () => {
  test("accepts a full quota object, including zeros (unlimited)", () => {
    expect(isApiKeyQuota({ dailyUsd: 0, weeklyUsd: 0, monthlyUsd: 0 })).toBe(true);
    expect(isApiKeyQuota({ dailyUsd: 1.5, weeklyUsd: 10, monthlyUsd: 250.25 })).toBe(true);
  });

  test("rejects non-objects, missing fields, and non-finite or negative values", () => {
    for (const bad of [
      null, undefined, 5, "x", {},
      { dailyUsd: 0, weeklyUsd: 0 },
      { dailyUsd: -1, weeklyUsd: 0, monthlyUsd: 0 },
      { dailyUsd: 0, weeklyUsd: Number.NaN, monthlyUsd: 0 },
      { dailyUsd: 0, weeklyUsd: 0, monthlyUsd: Number.POSITIVE_INFINITY },
      { dailyUsd: "1", weeklyUsd: 0, monthlyUsd: 0 },
    ]) {
      expect(isApiKeyQuota(bad)).toBe(false);
    }
  });
});

describe("isApiKeySpend", () => {
  test("accepts a full spend object", () => {
    expect(isApiKeySpend({ dailyUsd: 0, weeklyUsd: 0, monthlyUsd: 0, unpricedRequests: 0 })).toBe(true);
    expect(isApiKeySpend({ dailyUsd: 0.0042, weeklyUsd: 1, monthlyUsd: 12.5, unpricedRequests: 3 })).toBe(true);
  });

  test("rejects non-objects, missing fields, and non-finite or negative values", () => {
    for (const bad of [
      null, undefined, "x", {},
      { dailyUsd: 0, weeklyUsd: 0, monthlyUsd: 0 },
      { dailyUsd: 0, weeklyUsd: 0, monthlyUsd: 0, unpricedRequests: -1 },
      { dailyUsd: Number.NaN, weeklyUsd: 0, monthlyUsd: 0, unpricedRequests: 0 },
      { dailyUsd: 0, weeklyUsd: 0, monthlyUsd: 0, unpricedRequests: "2" },
    ]) {
      expect(isApiKeySpend(bad)).toBe(false);
    }
  });
});

describe("formatUsd", () => {
  test("formats ordinary amounts with two decimals", () => {
    expect(formatUsd(0, "en-US")).toBe("$0.00");
    expect(formatUsd(1.5, "en-US")).toBe("$1.50");
    expect(formatUsd(1234.5, "en-US")).toBe("$1,234.50");
    expect(formatUsd(0.01, "en-US")).toBe("$0.01");
  });

  test("formats sub-cent amounts with four decimals so they are not rounded to $0.00", () => {
    const formatted = formatUsd(0.0042, "en-US");
    expect(formatted).toBe("$0.0042");
    expect(formatted).not.toBe("$0.00");
  });
});
