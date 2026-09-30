import { claudeStaticHeaders, detectClaudeCliVersion } from "../../src/claude/cc-fingerprint";
import { describe, expect, test } from "bun:test";
import {
  ANTIGRAVITY_IDE_VERSION,
  CLAUDE_CODE_HEADERS,
  antigravityUserAgent,
  claudeCodeSessionId,
} from "../../src/adapters/client-fingerprint";
import { createAnthropicAdapter } from "../../src/adapters/anthropic";
import type { OcxParsedRequest, OcxProviderConfig } from "../../src/types";

function parsed(): OcxParsedRequest {
  return {
    modelId: "claude-opus-4-6",
    stream: false,
    options: {},
    context: { systemPrompt: ["You are Codex, a coding agent based on GPT-5."], messages: [{ role: "user", content: "hi" }] },
  } as unknown as OcxParsedRequest;
}

describe("client fingerprint — helpers", () => {
  test("antigravity UA has the real IDE shape, never the literal giveaway", async () => {
    const ua = antigravityUserAgent();
    expect(ua).toBe(`antigravity/ide/${ANTIGRAVITY_IDE_VERSION} (os_type=windows; arch=amd64; aidev_client; auth_method=oauth)`);
    expect(ua).not.toBe("antigravity");
  });

  test("antigravity UA honors explicit version and authMethod overrides", async () => {
    expect(antigravityUserAgent("9.9.9")).toBe("antigravity/ide/9.9.9 (os_type=windows; arch=amd64; aidev_client; auth_method=oauth)");
    expect(antigravityUserAgent(ANTIGRAVITY_IDE_VERSION, "api_key")).toBe(
      `antigravity/ide/${ANTIGRAVITY_IDE_VERSION} (os_type=windows; arch=amd64; aidev_client; auth_method=api_key)`,
    );
  });

  test("GOOGLE_ANTIGRAVITY_USER_AGENT env override trims surrounding whitespace", async () => {
    const prevGoogle = process.env.GOOGLE_ANTIGRAVITY_USER_AGENT;
    try {
      process.env.GOOGLE_ANTIGRAVITY_USER_AGENT = "  custom-ua/1.2.3  ";
      expect(antigravityUserAgent()).toBe("custom-ua/1.2.3");
    } finally {
      if (prevGoogle === undefined) delete process.env.GOOGLE_ANTIGRAVITY_USER_AGENT;
      else process.env.GOOGLE_ANTIGRAVITY_USER_AGENT = prevGoogle;
    }
  });

  test("whitespace-only GOOGLE_ANTIGRAVITY_USER_AGENT falls back to default UA", async () => {
    const prevGoogle = process.env.GOOGLE_ANTIGRAVITY_USER_AGENT;
    try {
      process.env.GOOGLE_ANTIGRAVITY_USER_AGENT = "   ";
      expect(antigravityUserAgent()).toBe(
        `antigravity/ide/${ANTIGRAVITY_IDE_VERSION} (os_type=windows; arch=amd64; aidev_client; auth_method=oauth)`,
      );
    } finally {
      if (prevGoogle === undefined) delete process.env.GOOGLE_ANTIGRAVITY_USER_AGENT;
      else process.env.GOOGLE_ANTIGRAVITY_USER_AGENT = prevGoogle;
    }
  });

  test("claude session id is a stable v4-shaped uuid per token", async () => {
    const a = claudeCodeSessionId("tok-abc");
    const b = claudeCodeSessionId("tok-abc");
    const c = claudeCodeSessionId("tok-xyz");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("claude session id never echoes the raw token", async () => {
    expect(claudeCodeSessionId("super-secret-token")).not.toContain("super-secret-token");
  });

  test("CLAUDE_CODE_HEADERS carries the first-party Stainless/App signature", async () => {
    expect(CLAUDE_CODE_HEADERS["X-App"]).toBe("cli");
    expect(CLAUDE_CODE_HEADERS["X-Stainless-Runtime"]).toBe("node");
    expect(CLAUDE_CODE_HEADERS["X-Stainless-Lang"]).toBe("js");
  });
});

describe("client fingerprint — anthropic OAuth headers", () => {
  const oauthProvider = { adapter: "anthropic", authMode: "oauth", baseUrl: "https://api.anthropic.com", apiKey: "oauth-tok-123" } as unknown as OcxProviderConfig;
  const apiKeyProvider = { adapter: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "sk-ant-123" } as unknown as OcxProviderConfig;

  test("OAuth request carries the captured Claude CLI header set regardless of header casing", async () => {
    const { headers } = await createAnthropicAdapter(oauthProvider).buildRequest(parsed());
    const actual = new Headers(headers);
    expect(actual.get("x-app")).toBe("cli");
    expect(actual.get("x-stainless-runtime")).toBe("node");
    expect(actual.get("x-stainless-lang")).toBe("js");
    for (const [name, value] of Object.entries(claudeStaticHeaders(detectClaudeCliVersion()))) expect(actual.get(name)).toBe(value);
    expect(actual.get("anthropic-beta")).not.toBeNull();
    expect(actual.get("x-claude-code-session-id")).toMatch(/^[0-9a-f]{8}-/);
    expect(actual.get("x-client-request-id")).toMatch(/^[0-9a-f]{8}-/);
  });

  test("session id is present and stable across requests with the same OAuth account", async () => {
    const a = new Headers((await createAnthropicAdapter(oauthProvider).buildRequest(parsed())).headers).get("x-claude-code-session-id");
    const b = new Headers((await createAnthropicAdapter(oauthProvider).buildRequest(parsed())).headers).get("x-claude-code-session-id");
    expect(a).toMatch(/^[0-9a-f]{8}-/);
    expect(a).toBe(b);
  });

  test("outgoing session-id header never echoes the raw OAuth token", async () => {
    const secretProvider = { adapter: "anthropic", authMode: "oauth", baseUrl: "https://api.anthropic.com", apiKey: "oauth-super-secret-xyz" } as unknown as OcxProviderConfig;
    const { headers } = await createAnthropicAdapter(secretProvider).buildRequest(parsed());
    const session = new Headers(headers).get("x-claude-code-session-id");
    expect(session).toMatch(/^[0-9a-f]{8}-/);
    expect(session).not.toContain("oauth-super-secret-xyz");
    expect(session).not.toContain("super-secret");
  });

  test("per-request id differs between requests", async () => {
    const a = new Headers((await createAnthropicAdapter(oauthProvider).buildRequest(parsed())).headers).get("x-client-request-id");
    const b = new Headers((await createAnthropicAdapter(oauthProvider).buildRequest(parsed())).headers).get("x-client-request-id");
    expect(a).toMatch(/^[0-9a-f]{8}-/);
    expect(a).not.toBe(b);
  });

  test("API-key mode does NOT get the Claude Code CLI headers", async () => {
    const headers = new Headers((await createAnthropicAdapter(apiKeyProvider).buildRequest(parsed())).headers);
    expect(headers.get("x-api-key")).toBe("sk-ant-123");
    expect(headers.get("x-app")).toBeNull();
    expect(headers.get("x-claude-code-session-id")).toBeNull();
  });

  test("OAuth keeps its captured Accept and User-Agent while API-key requests use the SDK template", async () => {
    const oauth = new Headers((await createAnthropicAdapter(oauthProvider).buildRequest(parsed())).headers);
    const apiKey = new Headers((await createAnthropicAdapter(apiKeyProvider).buildRequest(parsed())).headers);
    const captured = new Headers(claudeStaticHeaders(detectClaudeCliVersion()));
    expect(oauth.get("accept")).toBe(captured.get("accept"));
    expect(oauth.get("user-agent")).toBe(captured.get("user-agent"));
    expect(apiKey.get("accept")).toBe("application/json");
    expect(apiKey.get("user-agent")).toBe("@anthropic-ai/sdk/0.74.0");
  });

  test("streaming retains the OAuth template and negotiates SSE on the API-key path", async () => {
    const streaming = { ...parsed(), stream: true } as OcxParsedRequest;
    const oauth = new Headers((await createAnthropicAdapter(oauthProvider).buildRequest(streaming)).headers);
    const apiKey = new Headers((await createAnthropicAdapter(apiKeyProvider).buildRequest(streaming)).headers);
    expect(oauth.get("accept")).toBe(new Headers(claudeStaticHeaders(detectClaudeCliVersion())).get("accept"));
    expect(apiKey.get("accept")).toBe("text/event-stream");
  });
});
