/**
 * Automatic Claude Code account import — adopts the credential the installed
 * `claude` CLI already holds (credentials file or OS credential store) into the
 * `anthropic` provider's account set, so a machine with a signed-in Claude Code
 * needs no browser re-auth. Ported from dario's loadCredentials /
 * chooseClientIdentity / fetchOAuthProfile behaviour (dario src/accounts.ts +
 * src/oauth.ts).
 *
 * What "dario-faithful" means here:
 *
 *   - read-only toward Claude Code's stores: file + OS keychain are consulted,
 *     never written; the freshest `expiresAt` wins across them
 *     (local-token-detect.ts owns that part)
 *   - identity is per-ACCOUNT, not per-machine: the local Claude Code
 *     deviceId/accountUuid pair is reused only when no stored account owns it,
 *     or the owning account is proven (via /api/oauth/profile) to be the same
 *     Anthropic subscription. An unrelated second account gets a fresh pair —
 *     reusing one machine's identity across unrelated subscriptions is the
 *     correlation Anthropic's anti-abuse flags.
 *   - the OAuth profile settles dedupe on a FACT: `account.uuid` beats matching
 *     on email or token strings.
 *   - a failed profile fetch never fails the import — identity is a nicety
 *     layered on a grant that already succeeded.
 */
import { randomUUID } from "node:crypto";
import { mutatePersistedConfig } from "../config";
import type { OcxConfig } from "../types";
import { detectClaudeCodeToken, detectLocalClaudeIdentity } from "./local-token-detect";
import { getAccountSet, saveCredential } from "./store";
import { upsertOAuthProvider } from "./index";
import type { AnthropicOAuthMetadata, OAuthCredentials, ProviderAccount } from "./types";

/** dario OAUTH_PROFILE_URL — the self-description endpoint a subscription token exposes. */
export const ANTHROPIC_OAUTH_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";

export interface AnthropicOAuthProfile {
  accountId: string;
  accountEmail?: string;
  organizationId?: string;
  organizationType?: string;
  rateLimitTier?: string;
  seatTier?: string;
}

/**
 * Fetch the OAuth profile behind `accessToken`. Null on ANY failure — a non-2xx,
 * a timeout, a body without an account uuid — because a profile outage must never
 * turn a working credential into a failed import (dario fetchOAuthProfile).
 */
export async function fetchAnthropicOAuthProfile(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AnthropicOAuthProfile | null> {
  try {
    const res = await fetchImpl(ANTHROPIC_OAUTH_PROFILE_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as {
      account?: { uuid?: unknown; email?: unknown };
      organization?: { uuid?: unknown; organization_type?: unknown; rate_limit_tier?: unknown; seat_tier?: unknown };
    };
    const uuid = data.account?.uuid;
    if (typeof uuid !== "string" || uuid.length === 0) return null;
    const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
    return {
      accountId: uuid,
      ...(str(data.account?.email) ? { accountEmail: str(data.account?.email) } : {}),
      ...(str(data.organization?.uuid) ? { organizationId: str(data.organization?.uuid) } : {}),
      ...(str(data.organization?.organization_type) ? { organizationType: str(data.organization?.organization_type) } : {}),
      ...(str(data.organization?.rate_limit_tier) ? { rateLimitTier: str(data.organization?.rate_limit_tier) } : {}),
      ...(str(data.organization?.seat_tier) ? { seatTier: str(data.organization?.seat_tier) } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Pick this account's Claude Code client identity (dario chooseClientIdentity):
 * reuse the local install's deviceId/accountUuid when no stored account owns the
 * pair — or when the owning account's Anthropic uuid matches the profile, proving
 * it IS the local subscription re-importing. Otherwise mint a fresh pair so this
 * account never shares a machine identity with an unrelated subscription.
 */
export function chooseClaudeClientIdentity(
  existing: readonly ProviderAccount[],
  profile: AnthropicOAuthProfile | null,
  local?: { deviceId: string; accountUuid: string } | null,
): { deviceId: string; accountUuid: string } {
  const cc = local === undefined ? detectLocalClaudeIdentity() : local;
  if (cc && (cc.deviceId || cc.accountUuid)) {
    const holder = existing.find(
      (a) => a.credential.anthropic?.deviceId === cc.deviceId
        && a.credential.anthropic?.accountUuid === cc.accountUuid,
    );
    const sameAccount = holder !== undefined && profile !== null
      && typeof holder.credential.accountId === "string"
      && holder.credential.accountId === profile.accountId;
    if (!holder || sameAccount) return { deviceId: cc.deviceId, accountUuid: cc.accountUuid };
  }
  return { deviceId: randomUUID(), accountUuid: randomUUID() };
}

/**
 * Build the stored credential for a freshly imported Claude Code credential:
 * real account identity on `accountId`/`email` (store dedupe keys), the client
 * identity triple + profile observation under `anthropic`.
 */
export function anthropicCredentialFromLocal(
  token: OAuthCredentials,
  existing: readonly ProviderAccount[],
  profile: AnthropicOAuthProfile | null,
  local?: { deviceId: string; accountUuid: string } | null,
): OAuthCredentials {
  const identity = chooseClaudeClientIdentity(existing, profile, local);
  const anthropic: AnthropicOAuthMetadata = {
    ...identity,
    sessionId: randomUUID(),
    ...(profile?.organizationId ? { organizationUuid: profile.organizationId } : {}),
    ...(profile?.organizationType ? { organizationType: profile.organizationType } : {}),
    ...(profile?.rateLimitTier ? { rateLimitTier: profile.rateLimitTier } : {}),
    ...(profile?.seatTier ? { seatTier: profile.seatTier } : {}),
  };
  return {
    ...token,
    source: "local-cli",
    // The profile's account uuid is the dedupe identity; the CC identity file's
    // accountUuid is the same value when present, so it is the fallback.
    accountId: profile?.accountId ?? token.accountId ?? (local?.accountUuid || undefined),
    email: profile?.accountEmail ?? token.email,
    anthropic,
  };
}

/**
 * True when `set` already carries a usable account for this Anthropic identity —
 * the import's dedupe check. Matching is on the real account uuid first, the
 * stored client-identity accountUuid second (a profile-less import still dedupes
 * against itself), email last.
 */
function accountAlreadyImported(
  set: ReturnType<typeof getAccountSet>,
  candidate: OAuthCredentials,
): boolean {
  if (!set) return false;
  const accountId = candidate.accountId;
  const clientUuid = candidate.anthropic?.accountUuid;
  const email = candidate.email?.toLowerCase();
  return set.accounts.some((a) => {
    if (a.needsReauth) return false;
    const cred = a.credential;
    if (accountId && (cred.accountId === accountId || cred.anthropic?.accountUuid === accountId)) return true;
    if (clientUuid && cred.anthropic?.accountUuid === clientUuid && cred.anthropic?.deviceId === candidate.anthropic?.deviceId) return true;
    if (email && cred.email?.toLowerCase() === email) return true;
    return false;
  });
}

// Re-probe the local stores at most this often when nothing was importable — a
// `claude` login after ocx started is picked up without a restart, while a
// machine without Claude Code does not pay a keychain subprocess per request.
const IMPORT_RETRY_MS = 60_000;
let lastEmptyImportAttemptAt = 0;
let importInFlight: Promise<boolean> | null = null;

/**
 * Ensure the anthropic provider has a usable account, importing the local Claude
 * Code credential when the store has none. `liveConfig` is the running server's
 * shared config object — the provider row must land on BOTH it and the persisted
 * file, because the file write alone is invisible until a reload. Returns true
 * when this call imported an account. Never throws — import failure degrades to
 * the ordinary OAuthLoginRequiredError path.
 */
export async function ensureAnthropicAccountImported(liveConfig?: OcxConfig): Promise<boolean> {
  const set = getAccountSet("anthropic");
  if (set && set.accounts.some(a => !a.needsReauth)) return false;
  const now = Date.now();
  if (now - lastEmptyImportAttemptAt < IMPORT_RETRY_MS) return false;
  if (importInFlight) return importInFlight;
  lastEmptyImportAttemptAt = now;
  importInFlight = doAnthropicAccountImport(liveConfig)
    .catch(() => false)
    .finally(() => { importInFlight = null; });
  return importInFlight;
}

// Test seam — a sandboxed suite cannot control the host keychain's contents,
// so the credential probe is swappable (same shape as setIcaclsRunnerForTests).
let claudeTokenDetector: () => OAuthCredentials | null = detectClaudeCodeToken;
export function setClaudeTokenDetectorForTests(detector: (() => OAuthCredentials | null) | null): void {
  claudeTokenDetector = detector ?? detectClaudeCodeToken;
}

async function doAnthropicAccountImport(liveConfig?: OcxConfig): Promise<boolean> {
  const token = claudeTokenDetector();
  if (!token) return false;
  const local = detectLocalClaudeIdentity();
  // The profile is best-effort but the import must not ship an EXPIRED access
  // token to it — a 401 profile response still leaves the credential usable via
  // the lazy refresh path on first dispatch, which is the designed recovery.
  const profile = token.expires > Date.now() ? await fetchAnthropicOAuthProfile(token.access) : null;
  const set = getAccountSet("anthropic");
  const cred = anthropicCredentialFromLocal(token, set?.accounts ?? [], profile, local);
  if (accountAlreadyImported(set, cred)) return false;
  await saveCredential("anthropic", cred);
  // The account is only reachable when a provider row routes to it — write the
  // login-owned row exactly as `ocx login anthropic` would, rebased on the
  // persisted config so a concurrent operator edit is not clobbered. An
  // operator-set authMode:"key" on the anthropic row means deliberate API-key
  // billing: the import still lands in auth.json but does NOT flip their routing.
  try {
    const outcome = mutatePersistedConfig(fresh => {
      const existing = fresh.providers["anthropic"];
      if (existing?.authMode === "key" || existing?.apiKey) return { changed: false, value: false };
      upsertOAuthProvider(fresh, "anthropic");
      return { changed: true, value: true };
    });
    if (outcome.status === "unavailable") {
      console.warn("[opencodex] Claude Code credential imported, but provider config could not be persisted:", outcome.reason);
    }
    // Mirror onto the live config object — the running server never re-reads
    // config.json on its own, so a persist-only write would not route until
    // restart. Same deliberate-key-billing guard as the persisted branch.
    if (liveConfig) {
      const existing = liveConfig.providers["anthropic"];
      if (!(existing?.authMode === "key" || existing?.apiKey)) {
        upsertOAuthProvider(liveConfig, "anthropic");
      }
    }
  } catch (err) {
    console.warn("[opencodex] Claude Code credential imported; provider upsert failed:", err instanceof Error ? err.message : String(err));
  }
  return true;
}

/** Test-only: reset the import latch so a suite can re-drive the probe. */
export function resetAnthropicImportStateForTests(): void {
  lastEmptyImportAttemptAt = 0;
  importInFlight = null;
}
