import { stampAnthropicServingIdentity } from "../../../src/server/responses/request-transport";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AnthropicAccountCooldownError, captureAnthropicCooldownRecovery,
  clearAnthropicAccountPoolState, getAnthropicAccountHealthSnapshot,
  getAnthropicPoolRetryAfterSeconds, recordAnthropicAccount429,
  resolveAnthropicAccountForSession, resolveAnthropicDispatchAccountId,
  rotateAnthropicAccountOn429, settleAnthropicCooldownRecovery,
} from "../../../src/oauth/anthropic-routing";
import { resolveAnthropicModelRoute } from "../../../src/oauth/anthropic-model-routes";
import { getAccountSet, saveCredential, setAccountPaused, setActiveAccount } from "../../../src/oauth/store";
import { clearAccountQuotaCache, setCachedProviderAccountQuotaForTests } from "../../../src/providers/quota";
import type { OcxConfig } from "../../../src/types";
import { removeTreeWithRetry } from "../../helpers/remove-tree";

const originalHome = process.env.OPENCODEX_HOME;
const originalFetch = globalThis.fetch;
let home: string;
let ids: string[];
let now: number;
let config: OcxConfig;
const fable = "claude-fable-5-1";
const opus = "claude-opus-5-5";

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "ocx-family-route-"));
  process.env.OPENCODEX_HOME = home;
  globalThis.fetch = (async () => { throw new Error("unexpected network send"); }) as typeof fetch;
  clearAnthropicAccountPoolState();
  clearAccountQuotaCache();
  now = Math.floor(Date.now() / 1000) * 1000;
  for (let i = 0; i < 3; i++) await saveCredential("anthropic", {
    access: `synthetic-family-access-${i}`, refresh: `synthetic-family-refresh-${i}`,
    expires: now + 3_600_000, accountId: `synthetic-family-${i}`,
  });
  ids = getAccountSet("anthropic")!.accounts.map(account => account.id);
  await setActiveAccount("anthropic", ids[0]!);
  config = {
    port: 0, defaultProvider: "anthropic",
    providers: { anthropic: { adapter: "anthropic", authMode: "oauth", baseUrl: "https://anthropic.test" } },
    anthropicAccountPool: { enabled: true },
  };
});

afterEach(() => {
  clearAnthropicAccountPoolState();
  clearAccountQuotaCache();
  globalThis.fetch = originalFetch;
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  removeTreeWithRetry(home);
});

function familyRefusal(): Headers {
  return new Headers({
    "anthropic-ratelimit-unified-5h-utilization": "0.2",
    "anthropic-ratelimit-unified-7d-utilization": "0.3",
    "anthropic-ratelimit-unified-7d_fable-utilization": "1",
    "anthropic-ratelimit-unified-7d_fable-status": "rejected",
    "anthropic-ratelimit-unified-7d_fable-reset": String((now + 3_600_000) / 1000),
  });
}

test("family failover keeps strict route membership and late admission skips paused successors", async () => {
  config.anthropicAccountPool!.routes = [{ name: "fable", match: "claude-fable-*", accounts: [ids[0]!, ids[1]!] }];
  const decision = resolveAnthropicModelRoute(config, fable).decision!;
  expect(rotateAnthropicAccountOn429(config, ids[0]!, null, null, now, familyRefusal(), decision, fable)).toBe(ids[1]!);
  expect(getAnthropicAccountHealthSnapshot(ids[0]!, now, opus)).toBeNull();
  expect(getAnthropicPoolRetryAfterSeconds(now, decision, fable)).toBe(3600);
  await setAccountPaused("anthropic", ids[1]!, true);
  expect(resolveAnthropicAccountForSession(null, config, now, decision, fable).reason).toBe("all-cooled");
  await expect(resolveAnthropicDispatchAccountId(config, null, decision, fable)).rejects.toBeInstanceOf(AnthropicAccountCooldownError);
});

test("legacy Haly model argument keeps pool-off reactive refusal limited to the refused family", () => {
  config.anthropicAccountPool!.enabled = false;
  expect(rotateAnthropicAccountOn429(config, ids[0]!, null, null, now, familyRefusal(), fable)).not.toBe(ids[0]!);
  expect(resolveAnthropicAccountForSession(null, config, now, fable).accountId).not.toBe(ids[0]!);
  expect(resolveAnthropicAccountForSession(null, config, now, opus).accountId).toBe(ids[0]!);
  expect(getAnthropicAccountHealthSnapshot(ids[0]!, now + 3_600_001, fable)).toBeNull();
});

test("a globally rejected window takes precedence even when utilization and family headers disagree", () => {
  const headers = familyRefusal();
  headers.set("anthropic-ratelimit-unified-5h-status", "rejected");
  headers.set("anthropic-ratelimit-unified-5h-reset", String((now + 60_000) / 1000));
  expect(recordAnthropicAccount429(config, ids[0]!, null, now, headers, fable)).toBe(true);
  for (const model of [fable, opus]) expect(getAnthropicAccountHealthSnapshot(ids[0]!, now, model)?.cooldownUntil).toBe(now + 60_000);
  const claim = captureAnthropicCooldownRecovery(ids[0]!, now)!;
  expect(settleAnthropicCooldownRecovery(claim, { fiveHourPercent: 20, updatedAt: now + 1 })).toBe("cleared");
  expect(getAnthropicAccountHealthSnapshot(ids[0]!, now, fable)).toBeNull();
});

test("upstream quota recovery clears its account-wide refusal while retaining an independent family refusal", () => {
  recordAnthropicAccount429(config, ids[0]!, null, now, familyRefusal(), fable);
  const globalHeaders = new Headers({
    "anthropic-ratelimit-unified-5h-status": "rejected",
    "anthropic-ratelimit-unified-5h-reset": String((now + 60_000) / 1000),
  });
  recordAnthropicAccount429(config, ids[0]!, null, now, globalHeaders, opus);
  const claim = captureAnthropicCooldownRecovery(ids[0]!, now)!;
  expect(settleAnthropicCooldownRecovery(claim, { fiveHourPercent: 20, updatedAt: now + 1 })).toBe("cleared");
  expect(getAnthropicAccountHealthSnapshot(ids[0]!, now, opus)).toBeNull();
  expect(getAnthropicAccountHealthSnapshot(ids[0]!, now, fable)?.cooldownUntil).toBe(now + 3_600_000);
});

test("a cached exhausted family does not spend the manual preference for another family", () => {
  setCachedProviderAccountQuotaForTests("anthropic", ids[0]!, {
    fiveHourPercent: 10, weeklyPercent: 10, updatedAt: now,
    customWindows: [{ label: "Fable weekly", percent: 100 }],
  });
  setCachedProviderAccountQuotaForTests("anthropic", ids[1]!, { fiveHourPercent: 20, updatedAt: now });
  expect(resolveAnthropicAccountForSession(null, config, now, null, fable).accountId).toBe(ids[1]!);
  expect(resolveAnthropicAccountForSession(null, config, now, null, opus)).toMatchObject({ accountId: ids[0]!, reason: "manual" });
});


test("late account replacement refreshes both request owners without sharing mutable identity", () => {
  const original = { _anthropicIdentity: { accountId: "old", deviceId: "old-device", accountUuid: "old-uuid", sessionSeed: "old-session" } };
  const retry = { ...original };
  stampAnthropicServingIdentity(original, { accountId: "new", anthropic: { deviceId: "new-device", accountUuid: "new-uuid", sessionId: "new-session" } }, retry);
  const expected = { accountId: "new", deviceId: "new-device", accountUuid: "new-uuid", sessionSeed: "new-session" };
  expect(original._anthropicIdentity).toEqual(expected);
  expect(retry._anthropicIdentity).toEqual(expected);
  expect(retry._anthropicIdentity).not.toBe(original._anthropicIdentity);
  retry._anthropicIdentity.deviceId = "retry-local";
  expect(original._anthropicIdentity.deviceId).toBe("new-device");
});

test("a replacement without recorded identity clears the previous account's fields on a retry", () => {
  const original = { _anthropicIdentity: { accountId: "old", deviceId: "old-device" } };
  const retry = { ...original };
  stampAnthropicServingIdentity(original, { accountId: "new" }, retry);
  expect(original._anthropicIdentity).toEqual({ accountId: "new" });
  expect(retry._anthropicIdentity).toEqual({ accountId: "new" });
});
