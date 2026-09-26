import { afterEach, expect, test } from "bun:test";
import {
  hasUpstreamRewriters,
  registerUpstreamRewriter,
  resetUpstreamRewritersForTests,
  rewriteUpstream,
  rewriteUpstreamRecord,
} from "../../src/plugins/upstream-hooks";

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

test("unregistering removes the rewriter", () => {
  const off = registerUpstreamRewriter("temp", target => { target.url = "http://changed/"; });
  off();
  expect(hasUpstreamRewriters()).toBe(false);
  expect(rewriteUpstream("https://a.example/x", undefined, "http").url).toBe("https://a.example/x");
});
