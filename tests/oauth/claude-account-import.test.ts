import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  anthropicCredentialFromLocal,
  chooseClaudeClientIdentity,
  ensureAnthropicAccountImported,
  resetAnthropicImportStateForTests,
  setClaudeTokenDetectorForTests,
} from "../../src/oauth/anthropic-import";
import { getAccountSet, markAccountNeedsReauth, saveCredential } from "../../src/oauth/store";
import type { OAuthCredentials } from "../../src/oauth/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/** Expired on purpose: skips the profile fetch, keeping the suite offline. */
const LOCAL_TOKEN: OAuthCredentials = {
  access: "at-local", refresh: "rt-local", expires: 1, source: "local-cli",
};

const TEST_DIR = join(import.meta.dir, ".tmp-anthropic-import-test");
const CLAUDE_DIR = join(TEST_DIR, "claude-config");
let previousOpencodexHome: string | undefined;
let previousClaudeConfigDir: string | undefined;

/** An EXPIRED local credential: skips the profile fetch, so the import stays offline. */
function writeLocalCredential(dir: string, expiresAt = 1): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".credentials.json"), JSON.stringify({
    claudeAiOauth: { accessToken: "at-local", refreshToken: "rt-local", expiresAt },
  }));
  writeFileSync(join(dir, ".claude.json"), JSON.stringify({
    userID: "dev-local",
    oauthAccount: { accountUuid: "acc-local" },
  }));
}

describe("anthropic Claude Code auto-import", () => {
  beforeEach(() => {
    previousOpencodexHome = process.env.OPENCODEX_HOME;
    previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    process.env.CLAUDE_CONFIG_DIR = CLAUDE_DIR;
    resetAnthropicImportStateForTests();
    // The host keychain may hold a REAL Claude credential that would win the
    // freshest-pick — pin the detector so the suite is hermetic.
    setClaudeTokenDetectorForTests(() => null);
  });

  afterEach(() => {
    if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousOpencodexHome;
    if (previousClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
    setClaudeTokenDetectorForTests(null);
    resetAnthropicImportStateForTests();
    if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
  });

  test("imports the local Claude Code credential when the store is empty", async () => {
    writeLocalCredential(CLAUDE_DIR);
    setClaudeTokenDetectorForTests(() => LOCAL_TOKEN);
    const imported = await ensureAnthropicAccountImported();
    expect(imported).toBe(true);
    const set = getAccountSet("anthropic");
    expect(set?.accounts.length).toBe(1);
    const cred = set!.accounts[0]!.credential;
    expect(cred.access).toBe("at-local");
    expect(cred.source).toBe("local-cli");
    // Identity lands under anthropic metadata — the deviceId/accountUuid pair
    // read from the local install's .claude.json.
    expect(cred.anthropic?.deviceId).toBe("dev-local");
    expect(cred.anthropic?.accountUuid).toBe("acc-local");
    expect(cred.accountId).toBe("acc-local");
    expect(typeof cred.anthropic?.sessionId).toBe("string");
  });

  test("second call is a no-op once a usable account exists", async () => {
    writeLocalCredential(CLAUDE_DIR);
    setClaudeTokenDetectorForTests(() => LOCAL_TOKEN);
    expect(await ensureAnthropicAccountImported()).toBe(true);
    expect(await ensureAnthropicAccountImported()).toBe(false);
    expect(getAccountSet("anthropic")?.accounts.length).toBe(1);
  });

  test("returns false when no local credential exists at all", async () => {
    mkdirSync(CLAUDE_DIR, { recursive: true });
    const imported = await ensureAnthropicAccountImported();
    expect(imported).toBe(false);
    expect(getAccountSet("anthropic")).toBeNull();
  });

  test("dedupes on the stored account uuid — no duplicate row for the same account", async () => {
    writeLocalCredential(CLAUDE_DIR);
    setClaudeTokenDetectorForTests(() => LOCAL_TOKEN);
    // Pre-seed the SAME account the local credential belongs to.
    await saveCredential("anthropic", {
      access: "at-existing",
      refresh: "rt-existing",
      expires: Date.now() - 1000,
      accountId: "acc-local",
      source: "local-cli",
      anthropic: { deviceId: "dev-local", accountUuid: "acc-local", sessionId: "sess-existing" },
    } as OAuthCredentials);
    // needsReauth makes the set "unusable" so the import actually probes.
    const set = getAccountSet("anthropic")!;
    await markAccountNeedsReauth("anthropic", set.accounts[0]!.id);

    const imported = await ensureAnthropicAccountImported();
    expect(imported).toBe(false);
    expect(getAccountSet("anthropic")?.accounts.length).toBe(1);
  });
});

describe("chooseClaudeClientIdentity", () => {
  const token: OAuthCredentials = { access: "a", refresh: "r", expires: 1 };

  test("reuses the local pair when no stored account owns it", () => {
    const id = chooseClaudeClientIdentity([], null, { deviceId: "d", accountUuid: "u" });
    expect(id).toEqual({ deviceId: "d", accountUuid: "u" });
  });

  test("reuses the local pair when the owning account is the same subscription", () => {
    const existing = [{
      id: "x",
      addedAt: 0,
      credential: {
        ...token,
        accountId: "acc-local",
        anthropic: { deviceId: "d", accountUuid: "u", sessionId: "s" },
      },
    }];
    const profile = { accountId: "acc-local" };
    const id = chooseClaudeClientIdentity(existing, profile, { deviceId: "d", accountUuid: "u" });
    expect(id).toEqual({ deviceId: "d", accountUuid: "u" });
  });

  test("mints a fresh pair when a DIFFERENT account owns the local identity", () => {
    const existing = [{
      id: "x",
      addedAt: 0,
      credential: {
        ...token,
        accountId: "acc-OTHER",
        anthropic: { deviceId: "d", accountUuid: "u", sessionId: "s" },
      },
    }];
    // Profile says the importing credential is a different subscription.
    const id = chooseClaudeClientIdentity(existing, { accountId: "acc-new" }, { deviceId: "d", accountUuid: "u" });
    expect(id.deviceId).not.toBe("d");
    expect(id.accountUuid).not.toBe("u");
  });

  test("mints a fresh pair when there is no local identity", () => {
    const id = chooseClaudeClientIdentity([], null, null);
    expect(id.deviceId.length).toBeGreaterThan(0);
    expect(id.accountUuid.length).toBeGreaterThan(0);
  });
});

describe("anthropicCredentialFromLocal", () => {
  test("profile accountId wins; local accountUuid is the fallback", () => {
    const token: OAuthCredentials = { access: "a", refresh: "r", expires: 1, source: "local-cli" };
    const withProfile = anthropicCredentialFromLocal(token, [], { accountId: "acc-profile" }, { deviceId: "d", accountUuid: "u" });
    expect(withProfile.accountId).toBe("acc-profile");
    const noProfile = anthropicCredentialFromLocal(token, [], null, { deviceId: "d", accountUuid: "u" });
    expect(noProfile.accountId).toBe("u");
    expect(noProfile.anthropic?.deviceId).toBe("d");
    expect(noProfile.source).toBe("local-cli");
  });
});
