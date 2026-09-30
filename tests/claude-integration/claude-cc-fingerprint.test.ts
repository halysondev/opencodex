import { describe, expect, test } from "bun:test";
import {
  applyClaudeCapabilityClamps,
  buildClaudeBillingTag,
  buildSynthesizedClaudeBody,
  claudeBetaForModel,
  claudeMetadataUserId,
  claudeStaticHeaders,
  claudeSystemPromptForModel,
  CC_TEMPLATE_VERSION,
  CLAUDE_AGENT_IDENTITY,
  effectiveClaudeCacheControl,
  forwardClaudeClientIdentityHeaders,
  hasClaudeCchSeed,
  isGenuineClaudeCodeBody,
  mergeClaudeClientBeta,
  noteClaudeBetaRejection,
  noteClaudeContext1mUnavailable,
  noteClaudeEffortSupport,
  noteClaudeMaxTokensCap,
  orderClaudeBodyFields,
  orderClaudeHeaders,
  describeClaudeClientVersionGate,
  parseClaudeBetaRejection,
  parseClaudeClientVersionGate,
  parseClaudeEffortRejection,
  parseClaudeMaxTokensRejection,
  isClaudeContext1mUnavailable,
  isClaudeEffortParamUnsupported,
  isClaudeLongContextRejection,
  resolveClaudeEffort,
  resolveClaudeSessionId,
  rewriteGenuineClaudeBody,
  sanitizeClaudeCodeMessages,
  stripClaudeContext1mTag,
  stripRejectedClaudeBetas,
  supportsClaudeAdaptiveThinking,
  withClaudeCacheTtlBeta,
} from "../../src/claude/cc-fingerprint";

type Rec = Record<string, unknown>;

const IDENTITY = { deviceId: "dev-1", accountUuid: "acc-1", sessionId: "sess-1" };
const BILLING = buildClaudeBillingTag("2.1.278");

function genuineBody(): Rec {
  return {
    model: "claude-opus-4-8",
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
      { role: "user", content: [{ type: "text", text: "again" }] },
    ],
    system: [
      { type: "text", text: "x-anthropic-billing-header: cc_version=9.9.9.abc; cc_entrypoint=cli;", cache_control: { type: "ephemeral" } },
      { type: "text", text: "You are Claude Code, Anthropic's official CLI.", cache_control: { type: "ephemeral" } },
      { type: "text", text: "system prompt body", cache_control: { type: "ephemeral" } },
    ],
    tools: [{ name: "Bash", description: "runs commands", input_schema: { type: "object" } }],
    metadata: { user_id: "client-own-id" },
    max_tokens: 32000,
    stream: true,
  };
}

describe("billing tag", () => {
  test("emits cc_version + cc_entrypoint in the subscription-billing shape", () => {
    const tag = buildClaudeBillingTag("2.1.278");
    expect(tag.startsWith("x-anthropic-billing-header: cc_version=2.1.278.")).toBe(true);
    expect(tag).toContain("cc_entrypoint=sdk-cli;");
    expect(tag).not.toContain("cch=");
  });

  test("cch rides only when the caller gates on a calibrated seed", () => {
    // buildClaudeBillingTag appends whatever cch it is given — the caller-side
    // hasClaudeCchSeed gate is what keeps uncalibrated versions token-free,
    // matching current Claude Code (which sends no cch).
    expect(hasClaudeCchSeed("2.1.177")).toBe(true);
    expect(hasClaudeCchSeed("2.1.278")).toBe(false);
    const cch = hasClaudeCchSeed("2.1.177") ? "abc12" : null;
    expect(buildClaudeBillingTag("2.1.177", cch)).toContain("cch=abc12;");
    expect(buildClaudeBillingTag("2.1.278", null)).not.toContain("cch=");
  });
});

describe("beta matrix", () => {
  test("opus-4-8 gets the captured base plus oauth", () => {
    const beta = claudeBetaForModel("claude-opus-4-8");
    expect(beta).toContain("claude-code-20250219");
    expect(beta).toContain("oauth-2025-04-20");
    expect(beta).not.toContain("fallback-credit-2026-06-01");
  });

  test("opus-5 inserts fallback-credit before afk-mode", () => {
    const flags = claudeBetaForModel("claude-opus-5").split(",");
    const fb = flags.indexOf("fallback-credit-2026-06-01");
    const afk = flags.indexOf("afk-mode-2026-01-31");
    expect(fb).toBeGreaterThan(-1);
    expect(afk === -1 || fb < afk).toBe(true);
  });

  test("sonnet-5 drops mid-conversation-tool-changes", () => {
    const beta = claudeBetaForModel("claude-sonnet-5");
    expect(beta).not.toContain("mid-conversation-tool-changes-2026-07-01");
    expect(beta).toContain("mid-conversation-system-2026-04-07");
  });

  test("sonnet-4 additionally drops mid-conversation-system", () => {
    const beta = claudeBetaForModel("claude-sonnet-4-6");
    expect(beta).not.toContain("mid-conversation-tool-changes-2026-07-01");
    expect(beta).not.toContain("mid-conversation-system-2026-04-07");
  });

  test("haiku drops the gated set and moves claude-code before advisor", () => {
    const flags = claudeBetaForModel("claude-haiku-4-5").split(",");
    for (const dropped of ["mid-conversation-system-2026-04-07", "mid-conversation-tool-changes-2026-07-01", "effort-2025-11-24", "afk-mode-2026-01-31"]) {
      expect(flags).not.toContain(dropped);
    }
    const cc = flags.indexOf("claude-code-20250219");
    const advisor = flags.indexOf("advisor-tool-2026-03-01");
    expect(cc).toBeGreaterThan(-1);
    if (advisor >= 0) expect(cc).toBeLessThan(advisor);
  });

  test("[1m] label inserts context-1m after claude-code and strips from wire model", () => {
    const flags = claudeBetaForModel("claude-fable-5[1m]").split(",");
    const ctx = flags.indexOf("context-1m-2025-08-07");
    const cc = flags.indexOf("claude-code-20250219");
    expect(ctx).toBe(cc + 1);
    expect(stripClaudeContext1mTag("claude-fable-5[1m]")).toBe("claude-fable-5");
  });

  test("client betas merge deduped after the computed set", () => {
    const merged = mergeClaudeClientBeta("a,b", "b,c");
    expect(merged).toBe("a,b,c");
  });

  test("rejected flags are cached per account and stripped on rebuild", () => {
    noteClaudeBetaRejection("acct-test-1", ["effort-2025-11-24"]);
    const stripped = stripRejectedClaudeBetas("a,effort-2025-11-24,b", "acct-test-1");
    expect(stripped).toBe("a,b");
    // A different account keeps the flag.
    expect(stripRejectedClaudeBetas("a,effort-2025-11-24,b", "acct-test-2")).toContain("effort-2025-11-24");
  });
});

describe("genuine-CC detection and rewrite", () => {
  test("billing tag at system[0] + CC origin at system[1] detects genuine", () => {
    expect(isGenuineClaudeCodeBody(genuineBody())).toBe(true);
    expect(isGenuineClaudeCodeBody({ system: [{ text: "hi" }] })).toBe(false);
    expect(isGenuineClaudeCodeBody({ system: "string-not-array" })).toBe(false);
    expect(isGenuineClaudeCodeBody({})).toBe(false);
  });

  test("rewrite replaces billing + metadata + cache, keeps tools/messages verbatim", () => {
    const src = genuineBody();
    const out = rewriteGenuineClaudeBody(src, BILLING, { type: "ephemeral" }, IDENTITY);
    const system = out.system as Array<Rec>;
    expect(system[0]!.text).toBe(BILLING);
    // The last two non-billing system blocks carry the stamps.
    expect(system[1]!.cache_control).toEqual({ type: "ephemeral" });
    expect(system[2]!.cache_control).toEqual({ type: "ephemeral" });
    expect(system[0]!.cache_control).toBeUndefined();
    // metadata.user_id becomes the JSON identity triple.
    const meta = JSON.parse((out.metadata as Rec).user_id as string);
    expect(meta).toEqual({ device_id: "dev-1", account_uuid: "acc-1", session_id: "sess-1" });
    // Client tools survive verbatim — never substituted.
    expect(out.tools).toEqual(src.tools);
    // Both user turns are "the last two" here — dario stamps the last two user
    // messages, so both carry the breakpoint.
    const msgs = out.messages as Array<Rec>;
    const firstUserBlocks = msgs[0]!.content as Array<Rec>;
    const lastUserBlocks = msgs[2]!.content as Array<Rec>;
    expect(lastUserBlocks[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(firstUserBlocks[0]!.cache_control).toEqual({ type: "ephemeral" });
    // Signed thinking / other top-level fields untouched.
    expect(out.max_tokens).toBe(32000);
    expect(out.stream).toBe(true);
  });
});

describe("synthesized body", () => {
  function synth(over: Partial<Parameters<typeof buildSynthesizedClaudeBody>[0]> = {}) {
    return buildSynthesizedClaudeBody({
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      clientSystemText: "You are a coding helper.",
      tools: [{ name: "custom_tool", description: "d", input_schema: { type: "object" } }],
      maxTokens: 64000,
      stream: true,
      billingTag: BILLING,
      cacheControl: { type: "ephemeral" },
      identity: IDENTITY,
      ...over,
    });
  }

  test("system = [billing, agent identity, CC prompt + client text under preface]", () => {
    const body = synth();
    const system = body.system as Array<Rec>;
    expect(system).toHaveLength(3);
    expect(system[0]!.text).toBe(BILLING);
    expect(system[0]!.cache_control).toBeUndefined();
    expect(system[1]!.text).toBe(CLAUDE_AGENT_IDENTITY);
    expect((system[2]!.text as string)).toContain(claudeSystemPromptForModel("claude-opus-4-8"));
    expect((system[2]!.text as string)).toContain("You are a coding helper.");
  });

  test("adaptive thinking + context_management + effort on non-haiku", () => {
    const body = synth();
    expect(body.thinking).toEqual({ type: "adaptive", display: "omitted" });
    expect((body.context_management as Rec).edits).toEqual([{ type: "clear_thinking_20251015", keep: "all" }]);
    expect(body.output_config).toEqual({ effort: "high" });
    expect(body.max_tokens).toBe(64000);
  });

  test("haiku omits thinking/context_management/output_config", () => {
    const body = synth({ model: "claude-haiku-4-5" });
    expect(body.thinking).toBeUndefined();
    expect(body.context_management).toBeUndefined();
    expect(body.output_config).toBeUndefined();
  });

  test("client-supplied thinking is honored and suppresses the adaptive pairing", () => {
    const body = synth({ clientThinking: { type: "enabled", budget_tokens: 8000 } });
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 8000 });
    expect(body.context_management).toBeUndefined();
  });

  test("fable without tools gets the tool_choice none pin; others get none", () => {
    const fable = synth({ model: "claude-fable-5", tools: undefined });
    expect(fable.tool_choice).toEqual({ type: "none" });
    const opus = synth({ tools: undefined });
    expect(opus.tool_choice).toBeUndefined();
    expect(opus.tools).toBeUndefined();
  });

  test("top-level key order follows the captured wire order", () => {
    const body = synth();
    const keys = Object.keys(body);
    const order = ["model", "messages", "system", "tools", "metadata", "max_tokens", "thinking", "context_management", "output_config", "stream"];
    const present = order.filter((k) => keys.includes(k));
    expect(keys.slice(0, present.length)).toEqual(present);
  });

  test("ultracode normalizes to xhigh; client effort wins over the default", () => {
    expect(resolveClaudeEffort("ultracode")).toBe("xhigh");
    expect(resolveClaudeEffort("low")).toBe("low");
    expect(resolveClaudeEffort(undefined)).toBe("high");
    expect(synth({ clientEffort: "max" }).output_config).toEqual({ effort: "max" });
  });
});

describe("headers", () => {
  test("static headers carry the captured CC identity", () => {
    const h = claudeStaticHeaders("2.1.278");
    expect(CC_TEMPLATE_VERSION).toBe("2.1.280");
    expect(h["user-agent"]).toBe(`claude-cli/${CC_TEMPLATE_VERSION} (external, sdk-cli)`);
    expect(h["x-stainless-lang"]).toBe("js");
    expect(h["x-app"]).toBe("cli");
    expect(h["x-api-key"]).toBeUndefined();
    expect(h["x-stainless-os"]).toBeDefined();
    expect(h["x-stainless-arch"]).toBeDefined();
  });

  test("client identity forwarding whitelists and blocks correctly", () => {
    const forwarded = forwardClaudeClientIdentityHeaders({
      "user-agent": "claude-cli/2.1.300 (external, cli)",
      "x-app": "cli",
      "x-stainless-os": "MacOS",
      "x-stainless-runtime-version": "v26.0.0",
      "x-claude-code-session-id": "must-not-forward",
      "x-claude-code-group": "g",
      "x-client-request-id": "rid-1",
      "x-api-key": "sk-ant-secret",
      "authorization": "Bearer leak",
      "anthropic-beta": "custom",
      "cookie": "no",
    });
    expect(forwarded["user-agent"]).toContain("claude-cli/2.1.300");
    expect(forwarded["x-stainless-os"]).toBe("MacOS");
    expect(forwarded["x-claude-code-group"]).toBe("g");
    expect(forwarded["x-client-request-id"]).toBe("rid-1");
    expect(forwarded["x-claude-code-session-id"]).toBeUndefined();
    expect(forwarded["x-api-key"]).toBeUndefined();
    expect(forwarded["authorization"]).toBeUndefined();
    expect(forwarded["anthropic-beta"]).toBeUndefined();
    expect(forwarded["cookie"]).toBeUndefined();
  });

  test("orderClaudeHeaders emits captured order then extras at tail", () => {
    const ordered = orderClaudeHeaders({
      "x-custom-extra": "1",
      "anthropic-version": "2023-06-01",
      "accept": "application/json",
      "user-agent": "ua",
    });
    const keys = Object.keys(ordered);
    expect(keys[0]).toBe("accept");
    expect(keys.indexOf("user-agent")).toBeLessThan(keys.indexOf("anthropic-version"));
    expect(keys[keys.length - 1]).toBe("x-custom-extra");
  });
});

describe("cache control", () => {
  test("defaults to ephemeral; 1h ttl detected only with the beta flag", () => {
    expect(effectiveClaudeCacheControl({}, undefined)).toEqual({ type: "ephemeral" });
    const withTtl = { system: [{ type: "text", text: "s", cache_control: { type: "ephemeral", ttl: "1h" } }] };
    expect(effectiveClaudeCacheControl(withTtl, "x,extended-cache-ttl-2025-04-11")).toEqual({ type: "ephemeral", ttl: "1h" });
    // No beta flag → the ttl request is not honored.
    expect(effectiveClaudeCacheControl(withTtl, "x")).toEqual({ type: "ephemeral" });
  });

  test("withClaudeCacheTtlBeta pairs the flag only on 1h", () => {
    expect(withClaudeCacheTtlBeta("a,b", { type: "ephemeral", ttl: "1h" })).toBe("a,b,extended-cache-ttl-2025-04-11");
    expect(withClaudeCacheTtlBeta("a,b", { type: "ephemeral" })).toBe("a,b");
    expect(withClaudeCacheTtlBeta("a,extended-cache-ttl-2025-04-11", { type: "ephemeral", ttl: "1h" })).toBe("a,extended-cache-ttl-2025-04-11");
  });
});

describe("message sanitization", () => {
  test("drops empty text blocks, emptied mid turns, trailing empty assistants", () => {
    const messages: Array<Rec> = [
      { role: "user", content: [{ type: "text", text: "a" }] },
      { role: "assistant", content: [{ type: "text", text: "  " }] },
      { role: "user", content: [{ type: "text", text: "b" }] },
      { role: "assistant", content: [{ type: "text", text: "" }] },
    ];
    sanitizeClaudeCodeMessages(messages, false);
    expect(messages.map((m) => m.role)).toEqual(["user", "user"]);
  });

  test("genuine path pops the trailing empty-user retry artifact plus its assistant", () => {
    const messages: Array<Rec> = [
      { role: "user", content: [{ type: "text", text: "a" }] },
      { role: "assistant", content: [{ type: "text", text: "partial" }] },
      { role: "user", content: [] },
    ];
    sanitizeClaudeCodeMessages(messages, true);
    expect(messages.map((m) => m.role)).toEqual(["user"]);
  });

  test("non-genuine path leaves a malformed trailing empty user for upstream to name", () => {
    const messages: Array<Rec> = [
      { role: "user", content: [{ type: "text", text: "a" }] },
      { role: "user", content: [] },
    ];
    sanitizeClaudeCodeMessages(messages, false);
    expect(messages).toHaveLength(2);
  });
});

describe("capability rejections", () => {
  test("parseClaudeBetaRejection reads the anthropic-beta 400 shape", () => {
    const body = JSON.stringify({ error: { type: "invalid_request_error", message: "Unexpected value(s) `effort-2025-11-24`, `advisor-tool-2026-03-01` for the `anthropic-beta` header" } });
    expect(parseClaudeBetaRejection(body)).toEqual(["effort-2025-11-24", "advisor-tool-2026-03-01"]);
    expect(parseClaudeBetaRejection("unrelated error")).toEqual([]);
  });

  test("effort and max_tokens rejections parse and clamp", () => {
    const effortBody = JSON.stringify({ error: { message: "This model does not support effort level 'max'. Supported levels: high, low, medium." } });
    expect(parseClaudeEffortRejection(effortBody)).toEqual({ rejected: "max", supported: ["high", "low", "medium"] });
    const capBody = JSON.stringify({ error: { message: "max_tokens: 64000 > 32000, which is the maximum allowed number of output tokens for claude-opus-4-1-20250805" } });
    expect(parseClaudeMaxTokensRejection(capBody)).toBe(32000);
    expect(isClaudeEffortParamUnsupported(JSON.stringify({ error: { message: "This model does not support the effort parameter." } }))).toBe(true);
    expect(isClaudeLongContextRejection(JSON.stringify({ error: { message: "long context beta is not yet available for this subscription" } }))).toBe(true);
    expect(isClaudeLongContextRejection("Extra usage is required for long context requests")).toBe(true);
  });

  test("clamps apply learned support/caps in place", () => {
    noteClaudeEffortSupport("claude-test-mdl", ["low", "medium"]);
    noteClaudeMaxTokensCap("claude-test-mdl", 32000);
    const body: Rec = { max_tokens: 64000, output_config: { effort: "xhigh" } };
    applyClaudeCapabilityClamps(body, "claude-test-mdl");
    expect(body.max_tokens).toBe(32000);
    expect((body.output_config as Rec).effort).toBe("medium");
    // Empty support list removes the knob entirely.
    noteClaudeEffortSupport("claude-test-mdl2", []);
    const b2: Rec = { output_config: { effort: "high" } };
    applyClaudeCapabilityClamps(b2, "claude-test-mdl2");
    expect(b2.output_config).toBeUndefined();
  });

  test("context-1m unavailability is per account", () => {
    noteClaudeContext1mUnavailable("acct-ctx");
    expect(isClaudeContext1mUnavailable("acct-ctx")).toBe(true);
    expect(isClaudeContext1mUnavailable("acct-other")).toBe(false);
  });

  test("client-version gate parses and describes the real cause", () => {
    const body = JSON.stringify({ error: { type: "invalid_request_error", message: "Claude Code 2.1.278 does not support this model; version 2.1.280 or newer is required. Run 'claude update', or update the Claude Code SDK." } });
    const gate = parseClaudeClientVersionGate(body);
    expect(gate).toEqual({ claimed: "2.1.278", required: "2.1.280" });
    expect(parseClaudeClientVersionGate("unrelated 400")).toBeNull();
    const described = describeClaudeClientVersionGate(gate!, "claude-opus-5-5");
    expect(described).toContain("claude-opus-5-5");
    expect(described).toContain("2.1.280");
    expect(described).toContain("2.1.278");
  });
});

describe("session rotation + identity", () => {
  test("session id is stable inside the idle window and seeded when offered", () => {
    const a = resolveClaudeSessionId("acct-sess-1", "seed-uuid");
    expect(a).toBe("seed-uuid");
    expect(resolveClaudeSessionId("acct-sess-1")).toBe("seed-uuid");
    const b = resolveClaudeSessionId("acct-sess-2");
    expect(b).not.toBe(a);
  });

  test("metadata.user_id is the JSON identity triple", () => {
    expect(JSON.parse(claudeMetadataUserId(IDENTITY))).toEqual({
      device_id: "dev-1", account_uuid: "acc-1", session_id: "sess-1",
    });
  });

  test("orderClaudeBodyFields keeps captured order first", () => {
    const out = orderClaudeBodyFields({ stream: true, model: "m", extra: 1, messages: [] });
    const keys = Object.keys(out);
    expect(keys[0]).toBe("model");
    expect(keys[1]).toBe("messages");
    expect(keys[keys.length - 1]).toBe("extra");
  });

  test("supportsClaudeAdaptiveThinking gates on the 4.6 generation", () => {
    expect(supportsClaudeAdaptiveThinking("claude-opus-4-6")).toBe(true);
    expect(supportsClaudeAdaptiveThinking("claude-opus-4-5")).toBe(false);
    expect(supportsClaudeAdaptiveThinking("claude-sonnet-5")).toBe(true);
    expect(supportsClaudeAdaptiveThinking("claude-fable-5[1m]")).toBe(true);
    expect(supportsClaudeAdaptiveThinking("claude-haiku-4-5")).toBe(false);
  });
});
