import { randomUUID } from "node:crypto";
import type { detectLocalClaudeIdentity } from "./local-token-detect";
import type { OAuthCredentials } from "./types";

/** Carry identity only while the local CLI still belongs to the same subscription. */
export function adoptClaudeDiskCredential(
  stored: OAuthCredentials,
  disk: OAuthCredentials,
  localIdentity: ReturnType<typeof detectLocalClaudeIdentity>,
): OAuthCredentials {
  const sameInstallAccount = !localIdentity?.accountUuid
    || !stored.anthropic?.accountUuid
    || localIdentity.accountUuid === stored.anthropic.accountUuid;
  return {
    ...disk,
    ...(sameInstallAccount && stored.accountId ? { accountId: stored.accountId } : {}),
    ...(sameInstallAccount && stored.email ? { email: stored.email } : {}),
    ...(sameInstallAccount && stored.anthropic
      ? { anthropic: stored.anthropic }
      : localIdentity && (localIdentity.deviceId || localIdentity.accountUuid)
        ? { anthropic: { ...localIdentity, sessionId: randomUUID() } }
        : {}),
  };
}
