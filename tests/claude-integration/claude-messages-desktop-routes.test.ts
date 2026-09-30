import { afterEach, beforeEach, expect, test } from "bun:test";
import { managementFetch as fetch } from "../helpers/management-auth";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { buildDesktop3pRegistry } from "../../src/claude/desktop-3p";
import type { DesktopProfile } from "../../src/claude/desktop-profile";
import { startServer } from "../../src/server";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { SERVER_BUDGET_MS } from "../helpers/test-budget";

let testDir = "";
let previousHome: string | undefined;
let previousDesktopConfigDir: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-claude-endpoint-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-claude-endpoint-"));
  process.env.OPENCODEX_HOME = testDir;
  previousDesktopConfigDir = process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
  process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = join(testDir, "claude-desktop");
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousDesktopConfigDir === undefined) delete process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
  else process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = previousDesktopConfigDir;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  globalThis.fetch = originalFetch;
  if (testDir) removeTreeWithRetry(testDir);
});

function mockChatUpstreamCapturing() {
  const captured: Array<Record<string, unknown>> = [];
  const urls: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      urls.push(req.url);
      const url = new URL(req.url);
      if (!url.pathname.endsWith("/chat/completions")) {
        return Response.json({ error: { message: `unexpected path ${url.pathname}` } }, { status: 404 });
      }
      try { captured.push(await req.json() as Record<string, unknown>); } catch { /* keep streaming */ }
      const frames = [
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "Hello" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: " from mock" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 3 } })}\n\n`,
        "data: [DONE]\n\n",
      ];
      return new Response(frames.join(""), { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  return { server, captured, urls };
}

const managedDesktopProfile: DesktopProfile = {
  version: 1,
  assignments: { "selected/model-selected": { family: "opus", alias: "claude-opus-4-8-20260201" } },
  defaults: { opus: "selected/model-selected", fable: null, sonnet: null, haiku: null },
};
const desktopRequestHeaders = {
  "content-type": "application/json",
  "anthropic-version": "2023-06-01",
  "anthropic-beta": "oauth-2025-04-20",
  authorization: "Bearer sk-ant-oat01-tst",
};

for (const { fallbacks, fastRows } of [
  { fallbacks: false, fastRows: false }, { fallbacks: true, fastRows: false },
  { fallbacks: false, fastRows: true }, { fallbacks: true, fastRows: true },
]) {
  test(`missing Desktop dates stay unavailable across registry states (fallbacks=${fallbacks}, fastRows=${fastRows})`, async () => {
    const selected = mockChatUpstreamCapturing();
    const fallback = mockChatUpstreamCapturing();
    const native = mockChatUpstreamCapturing();
    const provider = (upstream: ReturnType<typeof mockChatUpstreamCapturing>, models: string[]) => ({
      adapter: "openai-chat" as const, baseUrl: new URL("/v1", upstream.server.url).href,
      apiKey: "test-key", allowPrivateNetwork: true, liveModels: false, models,
    });
    saveConfig({
      port: 0, defaultProvider: "fallback", fastRows,
      providers: {
        selected: provider(selected, ["model-selected"]),
        fallback: provider(fallback, ["model-default", "model-dateless", "model-classifier"]),
      },
      claudeCode: {
        anthropicBaseUrl: native.server.url.origin,
        ...(fallbacks ? {
          modelMap: { "claude-opus-4-8": "fallback/model-dateless" },
          classifierModel: "fallback/model-classifier",
        } : {}),
      },
    } as OcxConfig);
    const server = startServer(0);
    try {
      for (const registryState of ["cold", "prior-success", "degraded-empty"] as const) {
        if (registryState === "prior-success") {
          buildDesktop3pRegistry([], [{ provider: "selected", id: "model-selected" }], managedDesktopProfile);
          const success = await fetch(new URL("/v1/messages", server.url), {
            method: "POST", headers: desktopRequestHeaders, signal: AbortSignal.timeout(5_000),
            body: JSON.stringify({ model: "claude-opus-4-8-20260201", stream: true, max_tokens: 8,
              messages: [{ role: "user", content: "hello" }] }),
          });
          expect(success.status).toBe(200);
          expect(await success.text()).toContain("message_stop");
          expect(selected.captured.map(body => body.model)).toEqual(["model-selected"]);
        } else {
          buildDesktop3pRegistry([], []);
        }
        const selectedBefore = selected.urls.length;
        const cases: Array<[string, number]> = [
          ["claude-opus-4-8-20260202", 503],
          // Retrying without new mapping evidence must not become a 400 or fallback.
          ["claude-opus-4-8-20260202", 503],
          ["claude-opus-4-8-20260202[1m]", 503],
          ["claude-opus-4-8-20260202--fast", 503],
          ["claude-opus-4-8-20260202--fast[1m]", 503],
          ["claude-opus-4-8-zzz", 400], ["claude-opus-4-zzz", 400],
          ["claude-opus-4-8-zzz--fast", 400], ["claude-opus-4-zzz--fast", 400],
        ];
        if (registryState === "degraded-empty") cases.push(["claude-opus-4-8-20260201", 503]);
        for (const [model, status] of cases) {
          for (const path of ["/v1/messages", "/v1/messages/count_tokens"]) {
            const response = await fetch(new URL(path, server.url), {
              method: "POST", headers: desktopRequestHeaders, signal: AbortSignal.timeout(5_000),
              body: JSON.stringify({ model, max_tokens: 8, messages: [{ role: "user", content: "hello" }] }),
            });
            expect(response.status).toBe(status);
            const body = await response.json() as { type: string; error: { type: string; message: string; code?: string } };
            expect(body.type).toBe("error");
            expect(body.error.type).toBe(status === 503 ? "api_error" : "invalid_request_error");
            if (status === 503) {
              expect(body.error.code).toBe("desktop_model_mapping_unavailable");
              expect(response.headers.get("retry-after")).toBe("1");
              expect(body.error.message).not.toContain("Unknown Claude Desktop alias");
            } else {
              expect(body.error.message).toContain("Unknown Claude Desktop alias");
              expect(body.error.code).not.toBe("desktop_model_mapping_unavailable");
              expect(response.headers.get("retry-after")).toBeNull();
            }
          }
        }
        expect(selected.urls).toHaveLength(selectedBefore);
        expect(fallback.urls).toEqual([]);
        expect(native.urls).toEqual([]);
      }
    } finally {
      await server.stop(true);
      selected.server.stop(true); fallback.server.stop(true); native.server.stop(true);
      buildDesktop3pRegistry([], []);
    }
  }, { timeout: SERVER_BUDGET_MS });
}

for (const fastRows of [false, true]) {
test(`registered Desktop IDs and exact overrides reach intended routes (fastRows=${fastRows})`, async () => {
  const selected = mockChatUpstreamCapturing();
  const explicit = mockChatUpstreamCapturing();
  const fallback = mockChatUpstreamCapturing();
  const provider = (upstream: ReturnType<typeof mockChatUpstreamCapturing>, model: string) => ({
    adapter: "openai-chat" as const, baseUrl: new URL("/v1", upstream.server.url).href,
    apiKey: "test-key", allowPrivateNetwork: true, liveModels: false, models: [model],
  });
  saveConfig({
    port: 0, defaultProvider: "fallback", fastRows,
    providers: {
      selected: provider(selected, "model-selected"), explicit: provider(explicit, "model-explicit"),
      fallback: provider(fallback, "model-fallback"),
    },
    claudeCode: {
      anthropicBaseUrl: fallback.server.url.origin,
      modelMap: {
        "claude-opus-4-8-20260202": "explicit/model-explicit",
        "claude-opus-4-8-20260203--fast": "explicit/model-explicit",
        "claude-opus-4-8": "fallback/model-fallback",
      },
      classifierModel: "fallback/model-fallback",
    },
  } as OcxConfig);
  buildDesktop3pRegistry([], [{ provider: "selected", id: "model-selected" }], managedDesktopProfile);
  const server = startServer(0);
  try {
    for (const model of [
      "claude-opus-4-8-20260201", "claude-opus-4-8-20260201[1m]",
      ...(fastRows ? ["claude-opus-4-8-20260201--fast"] : []),
      "claude-opus-4-8-20260202", "claude-opus-4-8-20260203--fast",
    ]) {
      const response = await fetch(new URL("/v1/messages", server.url), {
        method: "POST", headers: desktopRequestHeaders, signal: AbortSignal.timeout(5_000),
        body: JSON.stringify({ model, stream: true, max_tokens: 8, messages: [{ role: "user", content: "hello" }] }),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("message_stop");
      const count = await fetch(new URL("/v1/messages/count_tokens", server.url), {
        method: "POST", headers: desktopRequestHeaders, signal: AbortSignal.timeout(5_000),
        body: JSON.stringify({ model, messages: [{ role: "user", content: "hello" }] }),
      });
      expect(count.status).toBe(200);
      expect((await count.json() as { input_tokens: number }).input_tokens).toBeGreaterThan(0);
    }
    expect(selected.captured.map(body => body.model)).toEqual(Array(fastRows ? 3 : 2).fill("model-selected"));
    expect(explicit.captured.map(body => body.model)).toEqual(["model-explicit", "model-explicit"]);
    expect(selected.urls).toEqual(Array(fastRows ? 3 : 2).fill(new URL("/v1/chat/completions", selected.server.url).href));
    expect(explicit.urls).toEqual(Array(2).fill(new URL("/v1/chat/completions", explicit.server.url).href));
    expect(fallback.urls).toEqual([]);
    const count = await fetch(new URL("/v1/messages/count_tokens", server.url), {
      method: "POST", headers: desktopRequestHeaders,
      body: JSON.stringify({ model: "claude-opus-4-8-20260203--fast", messages: [{ role: "user", content: "hello" }] }),
    });
    expect(count.status).toBe(200);
    expect((await count.json() as { input_tokens: number }).input_tokens).toBeGreaterThan(0);
    expect(explicit.urls).toHaveLength(2);
    expect(fallback.urls).toEqual([]);
  } finally {
    await server.stop(true);
    selected.server.stop(true); explicit.server.stop(true); fallback.server.stop(true);
    buildDesktop3pRegistry([], []);
  }
}, { timeout: SERVER_BUDGET_MS });
}
