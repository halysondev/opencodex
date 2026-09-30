import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import type { AdapterRequest } from "../../src/adapters/base";
import type { OcxConfig } from "../../src/types";
import {
  applyHeadroomRoute,
  headroomRouteForUpstream,
  headroomSavingsReport,
  HEADROOM_DEFAULT_BASE_URL,
  resetHeadroomProbeForTests,
  setHeadroomSavingsRunnerForTests,
} from "../../src/headroom";

const HEADROOM = "http://127.0.0.1:8787";

function req(url: string): AdapterRequest {
  return { url, method: "POST", headers: { authorization: "Bearer x" }, body: "{}" };
}

const cfg = (headroom?: OcxConfig["headroom"]) => ({ headroom }) as Pick<OcxConfig, "headroom">;

describe("headroomRouteForUpstream", () => {
  test("maps codex backend paths natively, preserving the path", () => {
    const r = headroomRouteForUpstream("https://chatgpt.com/backend-api/codex/responses", HEADROOM);
    expect(r).toEqual({
      url: `${HEADROOM}/backend-api/codex/responses`,
      upstreamBaseUrl: "https://chatgpt.com",
    });
  });

  test("maps responses/chat-completions via base-url + original-path headers", () => {
    const r1 = headroomRouteForUpstream("https://api.openai.com/v1/responses?x=1", HEADROOM);
    expect(r1?.url).toBe(`${HEADROOM}/v1/responses?x=1`);
    expect(r1?.upstreamBaseUrl).toBe("https://api.openai.com");
    expect(r1?.originalPath).toBe("/v1/responses");

    const r2 = headroomRouteForUpstream("https://x.ai/v1/chat/completions", HEADROOM);
    expect(r2?.url).toBe(`${HEADROOM}/v1/chat/completions`);
    expect(r2?.upstreamBaseUrl).toBe("https://x.ai");
    expect(r2?.originalPath).toBe("/v1/chat/completions");
  });

  test("maps anthropic messages keeping any gateway prefix in the base url", () => {
    const r = headroomRouteForUpstream("https://api.anthropic.com/v1/messages", HEADROOM);
    expect(r?.url).toBe(`${HEADROOM}/v1/messages`);
    expect(r?.upstreamBaseUrl).toBe("https://api.anthropic.com");

    const gw = headroomRouteForUpstream("https://gw.example/anthropic/v1/messages", HEADROOM);
    expect(gw?.upstreamBaseUrl).toBe("https://gw.example/anthropic");
  });

  test("maps gemini generateContent at its native path", () => {
    const r = headroomRouteForUpstream(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent",
      HEADROOM,
    );
    expect(r?.url).toBe(`${HEADROOM}/v1beta/models/gemini-2.5-pro:generateContent`);
    expect(r?.upstreamBaseUrl).toBe("https://generativelanguage.googleapis.com");
  });

  test("returns null for endpoints headroom cannot compress", () => {
    expect(headroomRouteForUpstream("https://api.openai.com/v1/models", HEADROOM)).toBeNull();
    expect(headroomRouteForUpstream("https://api.openai.com/v1/images/generations", HEADROOM)).toBeNull();
  });

  test("returns null for private upstreams headroom's SSRF guard would reject", () => {
    expect(headroomRouteForUpstream("http://127.0.0.1:11434/v1/chat/completions", HEADROOM)).toBeNull();
    expect(headroomRouteForUpstream("http://localhost:8080/v1/responses", HEADROOM)).toBeNull();
    expect(headroomRouteForUpstream("http://192.168.1.5/v1/chat/completions", HEADROOM)).toBeNull();
  });

  test("returns null for non-http(s) and unparseable urls", () => {
    expect(headroomRouteForUpstream("wss://chatgpt.com/backend-api/codex/responses", HEADROOM)).toBeNull();
    expect(headroomRouteForUpstream("not a url", HEADROOM)).toBeNull();
  });

  test("codex-shaped path on a non-chatgpt origin still routes via the responses handler", () => {
    const r = headroomRouteForUpstream("https://codex-shim.example/backend-api/codex/responses", HEADROOM);
    expect(r?.url).toBe(`${HEADROOM}/v1/responses`);
    expect(r?.upstreamBaseUrl).toBe("https://codex-shim.example");
    expect(r?.originalPath).toBe("/backend-api/codex/responses");
  });
});

describe("applyHeadroomRoute", () => {
  let server: Server | undefined;

  beforeEach(() => resetHeadroomProbeForTests());
  afterEach(() => { server?.stop(true); server = undefined; resetHeadroomProbeForTests(); });

  const serve = (ok = true) => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: r => new Response(ok ? "ok" : "no", { status: ok ? 200 : 503 }),
    });
    return `http://127.0.0.1:${server.port}`;
  };

  test("leaves the request untouched when disabled", async () => {
    const base = serve();
    const r = req("https://api.openai.com/v1/responses");
    expect(await applyHeadroomRoute(r, cfg({ enabled: false, baseUrl: base }))).toBe(false);
    expect(r.url).toBe("https://api.openai.com/v1/responses");
    expect(r.headers["x-headroom-base-url"]).toBeUndefined();
  });

  test("leaves the request untouched when headroom is unreachable", async () => {
    // port 1 is never listening — fail-open must keep the provider URL.
    const r = req("https://api.openai.com/v1/responses");
    expect(await applyHeadroomRoute(r, cfg({ enabled: true, baseUrl: "http://127.0.0.1:1" }))).toBe(false);
    expect(r.url).toBe("https://api.openai.com/v1/responses");
  });

  test("rewrites url and injects upstream headers when reachable", async () => {
    const base = serve();
    const r = req("https://api.openai.com/v1/responses");
    expect(await applyHeadroomRoute(r, cfg({ enabled: true, baseUrl: base }))).toBe(true);
    expect(r.url).toBe(`${base}/v1/responses`);
    expect(r.headers["x-headroom-base-url"]).toBe("https://api.openai.com");
    expect(r.headers["x-headroom-original-path"]).toBe("/v1/responses");
    expect(r.headers.authorization).toBe("Bearer x");
  });

  test("skips uncompressible paths even when reachable", async () => {
    const base = serve();
    const r = req("https://api.openai.com/v1/models");
    expect(await applyHeadroomRoute(r, cfg({ enabled: true, baseUrl: base }))).toBe(false);
    expect(r.url).toBe("https://api.openai.com/v1/models");
  });

  test("defaults to the loopback base url", () => {
    const resolved = headroomRouteForUpstream("https://api.openai.com/v1/responses", HEADROOM_DEFAULT_BASE_URL);
    expect(resolved?.url).toBe(`${HEADROOM_DEFAULT_BASE_URL}/v1/responses`);
  });
});

describe("headroomSavingsReport", () => {
  afterEach(() => setHeadroomSavingsRunnerForTests(undefined));

  test("forwards the parsed CLI report and caches it inside the TTL", async () => {
    let calls = 0;
    setHeadroomSavingsRunnerForTests(async () => {
      calls += 1;
      return { lifetime: { tokens_saved: 42 } };
    });
    expect(await headroomSavingsReport()).toEqual({ lifetime: { tokens_saved: 42 } });
    expect(await headroomSavingsReport()).toEqual({ lifetime: { tokens_saved: 42 } });
    expect(calls).toBe(1);
  });

  test("a missing CLI or a failed run surfaces as undefined, never a throw", async () => {
    setHeadroomSavingsRunnerForTests(async () => undefined);
    expect(await headroomSavingsReport()).toBeUndefined();
  });

  test("aggregates the real ledger with the CLI's windows and groupings", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-headroom-savings-"));
    const path = join(dir, "savings_events.jsonl");
    const iso = (ms: number) => new Date(ms).toISOString();
    const now = Date.now();
    writeFileSync(path, [
      JSON.stringify({ v: 1, ts: iso(now - 600), before: 100, after: 60, saved: 40, cost_usd: 0.4, model: "m-a", client: "codex" }),
      JSON.stringify({ v: 1, ts: iso(now - 120), before: 60, after: 50, saved: 10, cost_usd: 0.1, model: "m-b", client: "proxy" }),
      // Outside the 30-day retention window — must be pruned on read like the CLI.
      JSON.stringify({ v: 1, ts: iso(now - 31 * 24 * 3600_000), before: 999, after: 1, saved: 998, cost_usd: 9.99, model: "old", client: "codex" }),
      "not json",
      "",
    ].join("\n"));
    const prev = process.env.HEADROOM_SAVINGS_EVENTS_PATH;
    process.env.HEADROOM_SAVINGS_EVENTS_PATH = path;
    try {
      setHeadroomSavingsRunnerForTests(undefined);
      const report = await headroomSavingsReport() as {
        lifetime: { tokens_saved: number; calls: number; savings_percent: number };
        windows: { today: { calls: number }; last_7_days: { calls: number }; last_30_days: { calls: number } };
        by_model: Array<{ model: string }>;
        top_model: string;
      };
      expect(report.lifetime.calls).toBe(2);
      expect(report.lifetime.tokens_saved).toBe(50);
      expect(report.lifetime.savings_percent).toBeCloseTo(31.3, 1);
      expect(report.windows.today.calls).toBe(2);
      expect(report.windows.last_7_days.calls).toBe(2);
      expect(report.windows.last_30_days.calls).toBe(2);
      expect(report.top_model).toBe("m-a");
      expect(report.by_model.map(m => m.model)).toEqual(["m-a", "m-b"]);
    } finally {
      if (prev === undefined) delete process.env.HEADROOM_SAVINGS_EVENTS_PATH;
      else process.env.HEADROOM_SAVINGS_EVENTS_PATH = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
