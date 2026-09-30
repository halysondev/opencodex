# Anthropic Provider

The `anthropic` provider has two auth modes. `authMode: "key"` sends the operator's
`apiKey` as `x-api-key` through the ordinary Messages bridge in
`src/adapters/anthropic.ts`. `authMode: "oauth"` serves Claude subscription traffic:
the account's OAuth bearer rides as `Authorization`, and the request is dressed in
the Claude Code wire fingerprint so upstream classifies it as first-party
subscription usage rather than third-party API-key billing. The fingerprint
contract lives in `src/claude/cc-fingerprint.ts` with captured wire constants in
`src/claude/cc-fingerprint-data.json`; it tracks the reference implementation in
the dario project (MIT-licensed behavioral port).

## Wire fingerprint

An OAuth-mode request is one of two shapes:

- **Genuine Claude Code** — detected by the `x-anthropic-billing-header:` system
  block at `system[0]` plus a recognized CC-origin block at `system[1]`. The body
  is forwarded byte-faithfully with three exceptions: the billing tag is replaced
  with the one this process computes, `metadata.user_id` is replaced with the
  serving account's identity triple, and cache breakpoints are stripped and
  re-stamped so the 4-breakpoint budget stays deterministic. Client
  `x-stainless-*`, `x-claude-code-*` (except the session id, which the account
  registry owns), `x-client-*`, `user-agent`, `x-app`, and
  `anthropic-dangerous-direct-browser-access` headers forward verbatim;
  `x-api-key`, `authorization`, and the client's `anthropic-beta` do not (the
  beta is merged into the computed set, never replayed).
- **Synthesized** — any other client gets the captured template: billing tag,
  agent-identity block, and CC system prompt with the client's own system text
  under the override preface, framework identifiers scrubbed, CC-shaped
  `metadata`, and the model-conditional `thinking` / `context_management` /
  `output_config.effort` triple (omitted on haiku, adaptive thinking only on the
  4.6+ generation). Client `tool_choice`, `temperature`, and `stop_sequences` are
  dropped — real CC does not send them on ordinary turns; a tool-less fable
  request gets the `tool_choice: none` refusal pin instead.

`anthropic-beta` is computed per model family (base set plus `oauth-2025-04-20`,
fallback-credit before afk-mode on opus-5/fable, mid-conversation flags dropped
on sonnet/haiku, `context-1m-2025-08-07` at position 2 for `[1m]`-labelled models)
with client betas merged after the computed set. A client `ttl:"1h"` cache request
pairs `extended-cache-ttl-2025-04-11` into the beta or the ttl is ignored.
`model` is stripped of the `[1m]` tag on the wire.

Upstream capability rejections are learned once and cached: a 400 naming
`anthropic-beta` flags strips them per account, an effort-level rejection records
the model's supported set, a hard effort-parameter rejection records an empty
set, a `max_tokens` cap clamps per model, and a long-context rejection disables
context-1m per account. The recovery arm in `src/server/responses/adapter-dispatch.ts`
rebuilds and refetches in dario's order (beta flags → effort level → effort
parameter → max_tokens → long context) inside a bounded per-request budget.

On the Responses path, a Claude Code minimum-version 400 returns `invalid_request_error` with `client_version_too_old` and is not retried: the bundled `claude-cli` fingerprint is the version Anthropic gated. The Messages path rewrites the same gate into an explanation for Anthropic-shaped callers.

Anthropic OAuth 429 handling in `src/oauth/anthropic-routing.ts` uses the model-family overlay in `src/oauth/anthropic-model-cooldown.ts` and scopes a rejected model-family weekly bucket to that family when the unified 5h/7d windows remain available. The scoped cooldown survives later responses without that bucket; unified-window and ordinary rate-limit cooldowns remain account-wide. The overlay also applies during late dispatch admission and combines with upstream route membership, paused-account checks, per-account switching thresholds, and generation-fenced recovery of account-wide cooldowns. A global rejected-window header takes precedence over a family-only refusal.

## Local Claude Code account import

`src/oauth/anthropic-import.ts` adopts the installed `claude` CLI's credential
when the anthropic account set has no usable account, so a signed-in machine
needs no browser re-auth. `src/oauth/local-token-detect.ts` reads the
credentials file and the OS credential store on every platform (macOS Keychain,
Linux `secret-tool`, Windows Credential Manager via CredEnumerate), chooses the
freshest `expiresAt`, and never writes back. Identity for `metadata.user_id`
comes from `~/.claude.json` (`userID`/`installId`/`deviceId` +
`oauthAccount.accountUuid`); the OAuth profile endpoint settles dedupe on
`account.uuid` ahead of email, and an imported account carries its
deviceId/accountUuid/sessionId under the credential's `anthropic` metadata.

A `source: "local-cli"` credential may adopt a newer valid disk generation during
refresh, but only the ACTIVE local-cli account does so in the background pool
path — a dormant pool account must not silently switch onto a different
machine-wide Claude credential (`src/oauth/anthropic-routing.ts`). Import
failure is non-fatal: the request falls back to the ordinary login-required
error. An operator-set `authMode: "key"` or `apiKey` on the anthropic provider
row is respected — the credential lands in `auth.json` without flipping routing.

Local CLI credential adoption is isolated in `src/oauth/anthropic-local-adoption.ts`: stored account labels follow the refreshed token only while the local subscription identity still matches. The translated subscription envelope preserves explicit tool prohibition and the upstream fast-speed/beta pair. Native Messages retains its byte-preserving transport and baseline header contract.

Late credential replacement stamps both the original parsed request and its retry clone with the serving account identity; fields absent from the replacement are cleared instead of retaining a previous account's identity.
