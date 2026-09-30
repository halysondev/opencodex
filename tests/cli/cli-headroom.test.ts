import { afterEach, beforeEach, expect, spyOn, test, type Mock } from "bun:test";
import { handleHeadroomCommand } from "../../src/cli/headroom";
import { capabilitiesForRoute } from "../../src/cli/capabilities";

let log: Mock<typeof console.log>;
let error: Mock<typeof console.error>;
beforeEach(() => {
  log = spyOn(console, "log").mockImplementation(() => {});
  error = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { log.mockRestore(); error.mockRestore(); });

function runtime() {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const payload = { enabled: false, reachable: true, baseUrl: "http://127.0.0.1:9000" };
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ path: new URL(String(input)).pathname, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    return Response.json(payload);
  }) as typeof fetch;
  return { calls, payload, deps: { baseUrl: "http://127.0.0.1:9", fetchImpl: fetcher } };
}

test.each([{ argv: [] }, { argv: ["status"] }, { argv: ["config"] }])("read-only forms issue a GET without mutating settings: %j", async ({ argv }) => {
  const { calls, deps } = runtime();
  expect(await handleHeadroomCommand(argv, deps)).toBe(0);
  expect(calls).toEqual([{ path: "/api/headroom", method: "GET", body: null }]);
});
test("stats selects its endpoint and JSON remains the server payload", async () => {
  const { calls, payload, deps } = runtime();
  expect(await handleHeadroomCommand(["stats", "--json"], deps)).toBe(0);
  expect(calls[0]!.path).toBe("/api/headroom/stats");
  expect(JSON.parse(log.mock.calls.flat().join("\n"))).toEqual(payload);
});
test("configuration forwards only explicitly supplied fields, including false", async () => {
  const { calls, deps } = runtime();
  expect(await handleHeadroomCommand(["config", "--enabled", "false", "--base-url", "http://127.0.0.1:9010"], deps)).toBe(0);
  expect(calls).toEqual([{ path: "/api/headroom", method: "PUT", body: { enabled: false, baseUrl: "http://127.0.0.1:9010" } }]);
});
test.each([{ argv: ["config", "--enabled", "maybe"] }, { argv: ["status", "--enabled", "true"] }, { argv: ["unknown"] }])("invalid argv sends no request: %j", async ({ argv }) => {
  const { calls, deps } = runtime();
  expect(await handleHeadroomCommand(argv, deps)).toBe(2);
  expect(calls).toEqual([]);
});
test("all Headroom management routes have a declared CLI capability", () => {
  for (const [method, path] of [["GET", "/api/headroom"], ["GET", "/api/headroom/stats"], ["PUT", "/api/headroom"]] as const) {
    expect(capabilitiesForRoute(path).some(capability => capability.command[0] === "headroom"
      && capability.routes.some(route => route.method === method && route.path === path))).toBe(true);
  }
});
