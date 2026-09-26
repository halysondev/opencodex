import { afterEach, expect, test } from "bun:test";
import {
  hasUpstreamRewriters,
  registerUpstreamRewriter,
  resetUpstreamRewritersForTests,
  rewriteUpstream,
  rewriteUpstreamRecord,
  rewriteWebSocketDial,
} from "../../src/plugins/upstream-hooks";
import { sendWithConnectionPolicy } from "../../src/server/responses/fetch-helpers";

afterEach(() => resetUpstreamRewritersForTests());

test("with no plugin registered the send is returned untouched and unallocated", () => {
  const headers = new Headers({ authorization: "Bearer x" });
  const result = rewriteUpstream("https://api.example.com/v1/responses", headers, "http");
  expect(hasUpstreamRewriters()).toBe(false);
  expect(result.url).toBe("https://api.example.com/v1/responses");
  expect(result.headers).toBe(headers);
});

test("a rewriter can redirect the URL and add headers while keeping credentials", () => {
  registerUpstreamRewriter("sidecar", target => {
    const original = new URL(target.url);
    target.url = `http://127.0.0.1:8787${original.pathname}`;
    target.headers.set("x-sidecar-upstream", original.origin);
  });
  const result = rewriteUpstream("https://api.example.com/v1/responses", { authorization: "Bearer x" }, "http");
  const headers = new Headers(result.headers);
  expect(result.url).toBe("http://127.0.0.1:8787/v1/responses");
  expect(headers.get("x-sidecar-upstream")).toBe("https://api.example.com");
  expect(headers.get("authorization")).toBe("Bearer x");
});

test("rewriters see the transport and run in registration order", () => {
  const seen: string[] = [];
  registerUpstreamRewriter("first", target => { seen.push(`first:${target.transport}`); target.url += "?a"; });
  registerUpstreamRewriter("second", target => { seen.push(`second:${target.transport}`); target.url += "&b"; });
  const result = rewriteUpstreamRecord("wss://chatgpt.com/backend-api/codex/responses", { "x-k": "v" }, "websocket");
  expect(seen).toEqual(["first:websocket", "second:websocket"]);
  expect(result.url).toBe("wss://chatgpt.com/backend-api/codex/responses?a&b");
  expect(result.headers["x-k"]).toBe("v");
});

test("a throwing rewriter is disabled and never breaks the send", () => {
  let calls = 0;
  registerUpstreamRewriter("broken", () => { calls += 1; throw new Error("boom"); });
  const originalError = console.error;
  console.error = () => {};
  try {
    for (let i = 0; i < 3; i += 1) {
      expect(rewriteUpstream("https://api.example.com/v1/messages", undefined, "http").url)
        .toBe("https://api.example.com/v1/messages");
    }
  } finally {
    console.error = originalError;
  }
  expect(calls).toBe(1);
});

test("a rewriter that edits the target and then throws leaves the send unmodified", () => {
  registerUpstreamRewriter("half", target => {
    target.url = "http://127.0.0.1:9/partial";
    target.headers.set("x-partial", "1");
    target.headers.delete("authorization");
    throw new Error("boom");
  });
  let seenByNext: { url: string; partial: string | null; auth: string | null } | undefined;
  registerUpstreamRewriter("next", target => {
    seenByNext = { url: target.url, partial: target.headers.get("x-partial"), auth: target.headers.get("authorization") };
  });
  const originalError = console.error;
  console.error = () => {};
  let result: ReturnType<typeof rewriteUpstream>;
  try {
    result = rewriteUpstream("https://api.example.com/v1/responses", { authorization: "Bearer x" }, "http");
  } finally {
    console.error = originalError;
  }
  const headers = new Headers(result.headers);
  expect(seenByNext).toEqual({ url: "https://api.example.com/v1/responses", partial: null, auth: "Bearer x" });
  expect(result.url).toBe("https://api.example.com/v1/responses");
  expect(headers.get("x-partial")).toBeNull();
  expect(headers.get("authorization")).toBe("Bearer x");
});

test("a WebSocket dial redirected to loopback drops the caller's proxy; other dials keep it", () => {
  const proxy = "http://corp-proxy.example:3128";
  expect(rewriteWebSocketDial("wss://chatgpt.com/backend-api/codex/responses", {}, proxy).proxy).toBe(proxy);

  const off = registerUpstreamRewriter("loopback", target => { target.url = "ws://127.0.0.1:8787/backend-api/codex/responses"; });
  const local = rewriteWebSocketDial("wss://chatgpt.com/backend-api/codex/responses", { a: "1" }, proxy);
  expect(local).toEqual({ url: "ws://127.0.0.1:8787/backend-api/codex/responses", headers: { a: "1" }, proxy: undefined });
  off();

  registerUpstreamRewriter("remote", target => { target.url = "wss://relay.example.com/backend-api/codex/responses"; });
  expect(rewriteWebSocketDial("wss://chatgpt.com/backend-api/codex/responses", {}, proxy).proxy).toBe(proxy);
});

test("the physical HTTP send rewrites once, even through a nested override pass", async () => {
  let calls = 0;
  registerUpstreamRewriter("count", target => {
    calls += 1;
    target.url = target.url.replace("https://api.example.com", "http://127.0.0.1:8787");
    target.headers.set("x-hop", String(calls));
  });
  const seen: Array<{ url: string; hop: string | null }> = [];
  const physical = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    seen.push({ url: String(input), hop: new Headers(init?.headers).get("x-hop") });
    return new Response("ok");
  }) as typeof fetch;
  // An override that hands the send back to the supplied executor passes through twice.
  const inner = ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    sendWithConnectionPolicy(physical, input, init)) as typeof fetch;
  await sendWithConnectionPolicy(inner, "https://api.example.com/v1/responses", { method: "POST" });
  expect(calls).toBe(1);
  expect(seen).toEqual([{ url: "http://127.0.0.1:8787/v1/responses", hop: "1" }]);
});

test("unregistering removes the rewriter", () => {
  const off = registerUpstreamRewriter("temp", target => { target.url = "http://changed/"; });
  off();
  expect(hasUpstreamRewriters()).toBe(false);
  expect(rewriteUpstream("https://a.example/x", undefined, "http").url).toBe("https://a.example/x");
});
