import { expect, test } from "bun:test";
import { forceQuotaRefreshAfterProviderAddition } from "../src/provider-addition";

test("newly activated ZCode providers never force an entitlement refresh from stale config", () => {
  expect(forceQuotaRefreshAfterProviderAddition({ adapter: "zcode" })).toBe(false);
  expect(forceQuotaRefreshAfterProviderAddition()).toBe(true);
  expect(forceQuotaRefreshAfterProviderAddition({ adapter: "openai-chat" })).toBe(true);
});
