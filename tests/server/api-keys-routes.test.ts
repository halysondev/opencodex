import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, readConfigDiagnostics, saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { isDataPlaneAdmissionSecret } from "../../src/server/auth-cors";
import { resetApiKeyQuotaStateForTests } from "../../src/server/api-key-quota";
import { ownAdmissionTokens } from "../../src/claude/auth-detect";
import { commitClientKeyRotation, startClientKeyRotation } from "../../src/client/hub-client";
import { usageLogPath } from "../../src/usage/log";
import { refreshUserCostOverlays } from "../../src/usage/user-cost-overlays";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";

// The /api/keys handlers had no direct test before this file: GET masking, POST
// persistence and DELETE semantics were only ever exercised through a CLI fixture
// that stubbed the runtime.

const ADMIN_TOKEN = "admin-secret-for-key-routes";
const previousHome = process.env.OPENCODEX_HOME;
const previousDataToken = process.env.OPENCODEX_API_AUTH_TOKEN;
const previousAdminToken = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
let testHome = "";

function baseConfig(): OcxConfig {
  return {
    port: 0,
    defaultProvider: "test",
    providers: {
      test: {
        adapter: "openai-chat",
        baseUrl: "https://example.test/v1",
        apiKey: "provider-credential-placeholder",
        disabled: true,
        models: ["gpt-test"],
      },
    },
  };
}

function configPath(): string {
  return join(testHome, "config.json");
}

function readRawConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(configPath(), "utf-8")) as Record<string, unknown>;
}

function writeRawConfig(value: Record<string, unknown>): void {
  writeFileSync(configPath(), JSON.stringify(value, null, 2));
}

/**
 * `/api/*` always requires the management token — a loopback bind relaxes the
 * DATA plane, not this one (src/server/management-auth.ts requireManagementAuth).
 */
async function keysRequest(
  server: { url: URL },
  method: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return managementRequest(server, "/api/keys", method, body);
}

async function managementRequest(
  server: { url: URL },
  path: string,
  method: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(new URL(path, server.url), {
    method,
    headers: { "Content-Type": "application/json", "x-opencodex-api-key": ADMIN_TOKEN },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  let json: Record<string, unknown> = {};
  try { json = await res.json() as Record<string, unknown>; } catch { /* empty body */ }
  return { status: res.status, json };
}

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "ocx-api-keys-routes-"));
  process.env.OPENCODEX_HOME = testHome;
  delete process.env.OPENCODEX_API_AUTH_TOKEN;
  process.env.OPENCODEX_ADMIN_AUTH_TOKEN = ADMIN_TOKEN;
});

afterEach(() => {
  resetApiKeyQuotaStateForTests();
  refreshUserCostOverlays({ providers: {} } as OcxConfig);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousDataToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = previousDataToken;
  if (previousAdminToken === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = previousAdminToken;
  if (testHome) removeTreeWithRetry(testHome);
  testHome = "";
});

describe("API key rotation", () => {
  test("BUG-R3303 completes the server-to-client rotation round trip with the persisted creation time", async () => {
    saveConfig(baseConfig());
    const server = startServer(0);
    try {
      const created = await keysRequest(server, "POST", { name: "client" });
      const oldKey = created.json.key as string;
      const id = created.json.id as string;
      const fetchImpl: typeof fetch = async (input, init) => {
        const requested = new URL(String(input));
        return fetch(new URL(`${requested.pathname}${requested.search}`, server.url), init);
      };
      const credential = { kind: "admin" as const, value: new TextEncoder().encode(ADMIN_TOKEN) };

      const started = await startClientKeyRotation(
        "https://hub.example.test",
        credential,
        id,
        { fetchImpl },
      );
      const pending = (loadConfig().apiKeys ?? [])[0]?.pendingRotation;
      expect(started.createdAt).toBe(pending?.createdAt);
      expect(started.expiresAt).toBe(pending?.expiresAt);
      expect(isDataPlaneAdmissionSecret(oldKey, loadConfig())).toBe(true);
      expect(isDataPlaneAdmissionSecret(started.key, loadConfig())).toBe(true);

      await commitClientKeyRotation(
        "https://hub.example.test",
        credential,
        id,
        started.rotationId,
        { fetchImpl },
      );
      expect(isDataPlaneAdmissionSecret(oldKey, loadConfig())).toBe(false);
      expect(isDataPlaneAdmissionSecret(started.key, loadConfig())).toBe(true);
    } finally {
      await server.stop(true);
    }
  });

  test("overlaps under one id, masks the pending secret, and commits atomically", async () => {
    saveConfig(baseConfig());
    const server = startServer(0);
    try {
      const created = await keysRequest(server, "POST", { name: "client" });
      const oldKey = created.json.key as string;
      const id = created.json.id as string;
      const started = await managementRequest(server, "/api/keys/rotate", "POST", { id });
      expect(started.status).toBe(201);
      const newKey = started.json.key as string;
      const rotationId = started.json.rotationId as string;
      expect(newKey).toMatch(/^ocx_data_[0-9a-f]{40}$/);
      expect(newKey).not.toBe(oldKey);
      expect(isDataPlaneAdmissionSecret(oldKey, loadConfig())).toBe(true);
      expect(isDataPlaneAdmissionSecret(newKey, loadConfig())).toBe(true);

      const listed = await keysRequest(server, "GET");
      expect(JSON.stringify(listed.json)).not.toContain(newKey);
      expect((listed.json.keys as Array<Record<string, unknown>>)[0]?.pendingRotation).toMatchObject({ id: rotationId });
      expect((await managementRequest(server, "/api/keys/rotate", "POST", { id })).status).toBe(409);

      const committed = await managementRequest(server, "/api/keys/rotate/commit", "POST", { id, rotationId });
      expect(committed.status).toBe(200);
      expect(isDataPlaneAdmissionSecret(oldKey, loadConfig())).toBe(false);
      expect(isDataPlaneAdmissionSecret(newKey, loadConfig())).toBe(true);
      expect((loadConfig().apiKeys ?? [])[0]?.id).toBe(id);
    } finally {
      await server.stop(true);
    }
  });

  test("abort preserves the old key and malformed bodies cannot alter pending state", async () => {
    saveConfig(baseConfig());
    const server = startServer(0);
    try {
      const created = await keysRequest(server, "POST", { name: "client" });
      const id = created.json.id as string;
      const oldKey = created.json.key as string;
      expect((await managementRequest(server, "/api/keys/rotate", "POST", { id, extra: true })).status).toBe(400);
      const started = await managementRequest(server, "/api/keys/rotate", "POST", { id });
      const newKey = started.json.key as string;
      const rotationId = started.json.rotationId as string;
      expect((await managementRequest(server, "/api/keys/rotate/commit", "POST", { id, rotationId, extra: true })).status).toBe(400);
      expect((await managementRequest(server, "/api/keys/rotate", "DELETE", { id, rotationId })).status).toBe(200);
      expect(isDataPlaneAdmissionSecret(oldKey, loadConfig())).toBe(true);
      expect(isDataPlaneAdmissionSecret(newKey, loadConfig())).toBe(false);
    } finally {
      await server.stop(true);
    }
  });
});

describe("POST /api/keys", () => {
  test("a raw pairing grant cannot authorize the key route", async () => {
    saveConfig({
      ...baseConfig(),
      runtimeRole: "hub",
      hub: { managementPublicOrigin: "https://hub.example.test" },
    });
    const server = startServer(0);
    try {
      const response = await fetch(new URL("/api/keys", server.url), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-opencodex-api-key": `ocx_pair_${"a".repeat(43)}`,
        },
        body: JSON.stringify({ name: "forbidden" }),
      });
      expect(response.status).toBe(401);
      expect(loadConfig().apiKeys ?? []).toHaveLength(0);
    } finally {
      await server.stop(true);
    }
  });

  test("persists a key and returns the full secret exactly once", async () => {
    saveConfig(baseConfig());
    const server = startServer(0);
    try {
      const created = await keysRequest(server, "POST", { name: "deploy" });
      expect(created.status).toBe(201);
      expect(created.json.name).toBe("deploy");
      expect(created.json.key).toMatch(/^ocx_data_[0-9a-f]{40}$/);

      const stored = loadConfig().apiKeys ?? [];
      expect(stored).toHaveLength(1);
      expect(stored[0]!.key).toBe(created.json.key as string);
    } finally {
      await server.stop(true);
    }
  });

  test("two keys differ in the eight random hex the list actually shows", async () => {
    saveConfig(baseConfig());
    const server = startServer(0);
    try {
      const first = await keysRequest(server, "POST", { name: "one" });
      const second = await keysRequest(server, "POST", { name: "two" });
      const a = first.json.key as string;
      const b = second.json.key as string;
      expect(a).not.toBe(b);
      // The displayed prefix must discriminate; masking 8 characters showed the
      // fixed `ocx_data` literal for every key ever generated.
      expect(a.slice(0, 17)).not.toBe(b.slice(0, 17));
    } finally {
      await server.stop(true);
    }
  });

  test("generation does not depend on provider credentials", async () => {
    const config = baseConfig();
    delete config.providers.test!.apiKey;
    saveConfig(config);
    const server = startServer(0);
    try {
      const created = await keysRequest(server, "POST", { name: "no-providers" });
      expect(created.status).toBe(201);
      expect(created.json.key).toMatch(/^ocx_data_[0-9a-f]{40}$/);
    } finally {
      await server.stop(true);
    }
  });

  test("the POST handler no longer reads provider API keys", async () => {
    const source = readFileSync(repoPath("src/server/management/oauth-account-routes.ts"), "utf-8");
    const start = source.indexOf('url.pathname === "/api/keys" && req.method === "POST"');
    const end = source.indexOf('url.pathname === "/api/keys" && req.method === "PATCH"');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const handler = source.slice(start, end);
    expect(handler).not.toContain("p.apiKey");
    expect(handler).not.toContain("CryptoHasher");
    expect(handler).toContain("issueApiKeyInProcess(config, name, fields)");
    const issuerStart = source.indexOf("export function issueApiKeyInProcess(");
    const issuerEnd = source.indexOf("export function revokeApiKeyInProcess(");
    expect(issuerStart).toBeGreaterThan(-1);
    expect(issuerEnd).toBeGreaterThan(issuerStart);
    const issuer = source.slice(issuerStart, issuerEnd);
    expect(issuer).not.toContain("p.apiKey");
    expect(issuer).not.toContain("CryptoHasher");
    expect(issuer).toContain("randomBytes(20)");
  });

  test.each([
    ["a 65-character name", { name: "x".repeat(65) }],
    ["an embedded control character", { name: "a\u0000b" }],
    ["a trailing newline", { name: "deploy\n" }],
    ["a tab-only name", { name: "\t" }],
    ["a numeric name", { name: 42 }],
    ["an array name", { name: [] }],
    ["an object name", { name: {} }],
  ])("rejects %s with 400 and persists nothing", async (_label, body) => {
    saveConfig(baseConfig());
    const server = startServer(0);
    try {
      const created = await keysRequest(server, "POST", body);
      expect(created.status).toBe(400);
      expect(loadConfig().apiKeys ?? []).toHaveLength(0);
    } finally {
      await server.stop(true);
    }
  });

  test("a malformed JSON body is a 400, not a 500", async () => {
    saveConfig(baseConfig());
    const server = startServer(0);
    try {
      const created = await keysRequest(server, "POST", "{not json");
      expect(created.status).toBe(400);
    } finally {
      await server.stop(true);
    }
  });
});

describe("GET /api/keys", () => {
  test("serves a discriminating prefix and never the secret", async () => {
    saveConfig(baseConfig());
    const server = startServer(0);
    try {
      const first = await keysRequest(server, "POST", { name: "one" });
      await keysRequest(server, "POST", { name: "two" });

      const listed = await keysRequest(server, "GET");
      expect(listed.status).toBe(200);
      const rows = listed.json.keys as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.key).toBeUndefined();
        expect(String(row.prefix)).toHaveLength(20); // 17 + "..."
      }
      expect(rows[0]!.prefix).not.toBe(rows[1]!.prefix);
      expect(JSON.stringify(listed.json)).not.toContain(first.json.key as string);
    } finally {
      await server.stop(true);
    }
  });
});

describe("PATCH /api/keys", () => {
  test("renames a key without echoing key material", async () => {
    saveConfig(baseConfig());
    const server = startServer(0);
    try {
      const created = await keysRequest(server, "POST", { name: "before" });
      const renamed = await keysRequest(server, "PATCH", { id: created.json.id, name: "after" });
      expect(renamed.status).toBe(200);
      expect(renamed.json.name).toBe("after");
      expect(renamed.json.key).toBeUndefined();

      const listed = await keysRequest(server, "GET");
      const rows = listed.json.keys as Array<Record<string, unknown>>;
      expect(rows[0]!.name).toBe("after");
    } finally {
      await server.stop(true);
    }
  });

  test.each([
    { name: "must-not-stick", allowedProviders: "invalid" },
    { name: "must-not-stick", allowedProviders: ["replacement"], allowedModels: [42] },
    { allowedProviders: null, allowedModels: "invalid" },
  ])("rejects the whole patch without live or later persisted mutation: %j", async patch => {
    const config = baseConfig();
    config.apiKeys = [{ id: "kept", name: "original", key: "fixture-key", createdAt: "2026-01-01T00:00:00Z", allowedProviders: ["test"], allowedModels: ["gpt-test"] }];
    saveConfig(config);
    const before = readRawConfig().apiKeys;
    const server = startServer(0);
    try {
      expect((await keysRequest(server, "PATCH", { id: "kept", ...patch })).status).toBe(400);
      const listed = await keysRequest(server, "GET");
      expect((listed.json.keys as Array<Record<string, unknown>>)[0]).toMatchObject({ name: "original", allowedProviders: ["test"], allowedModels: ["gpt-test"] });
      expect(readRawConfig().apiKeys).toEqual(before);
      // A subsequent unrelated write must not persist a rejected partial edit.
      expect((await keysRequest(server, "POST", { name: "another" })).status).toBe(201);
      expect((readRawConfig().apiKeys as Array<unknown>)[0]).toEqual((before as Array<unknown>)[0]);
    } finally {
      await server.stop(true);
    }
  });

  test("an unknown id is 404 and changes nothing", async () => {
    saveConfig(baseConfig());
    const server = startServer(0);
    try {
      await keysRequest(server, "POST", { name: "keep" });
      const renamed = await keysRequest(server, "PATCH", { id: "nope", name: "other" });
      expect(renamed.status).toBe(404);
      expect((loadConfig().apiKeys ?? [])[0]!.name).toBe("keep");
    } finally {
      await server.stop(true);
    }
  });

  test.each([
    ["an empty name", (id: string) => ({ id, name: "  " })],
    ["a non-string id", () => ({ id: 42, name: "x" })],
  ])("rejects %s with 400", async (_label, build) => {
    saveConfig(baseConfig());
    const server = startServer(0);
    try {
      const created = await keysRequest(server, "POST", { name: "keep" });
      const renamed = await keysRequest(server, "PATCH", build(created.json.id as string));
      expect(renamed.status).toBe(400);
    } finally {
      await server.stop(true);
    }
  });
});

describe("DELETE /api/keys", () => {
  test("removes a known key", async () => {
    saveConfig(baseConfig());
    const server = startServer(0);
    try {
      const created = await keysRequest(server, "POST", { name: "temp" });
      const removed = await keysRequest(server, "DELETE", { id: created.json.id });
      expect(removed.status).toBe(200);
      expect(loadConfig().apiKeys ?? []).toHaveLength(0);
    } finally {
      await server.stop(true);
    }
  });

  test("an unknown id is 404, not a fake successful revocation", async () => {
    saveConfig(baseConfig());
    const server = startServer(0);
    try {
      await keysRequest(server, "POST", { name: "keep" });
      const removed = await keysRequest(server, "DELETE", { id: "never-existed" });
      expect(removed.status).toBe(404);
      expect(loadConfig().apiKeys ?? []).toHaveLength(1);
    } finally {
      await server.stop(true);
    }
  });
});

describe("apiKeys config compatibility", () => {
  test("a malformed pending rotation degrades independently and keeps the current key", () => {
    saveConfig(baseConfig());
    const raw = readRawConfig();
    raw.apiKeys = [{
      id: "stable-id",
      name: "client",
      key: "ocx_data_current",
      createdAt: "2026-08-28T00:00:00.000Z",
      pendingRotation: { id: 7, key: "leaked-junk", expiresAt: "never" },
    }];
    writeRawConfig(raw);
    const loaded = loadConfig();
    expect(loaded.apiKeys?.[0]).toMatchObject({ id: "stable-id", key: "ocx_data_current" });
    expect(loaded.apiKeys?.[0]?.pendingRotation).toBeUndefined();
    expect(isDataPlaneAdmissionSecret("ocx_data_current", loaded)).toBe(true);
  });

  test("a non-array apiKeys value does not reset the config", () => {
    saveConfig(baseConfig());
    const raw = readRawConfig();
    raw.apiKeys = "oops";
    writeRawConfig(raw);

    const loaded = loadConfig();
    // The whole point: providers survive a hand-edited apiKeys value. A strict
    // array schema would have reached the backup-and-defaults repair path.
    expect(Object.keys(loaded.providers)).toContain("test");
    expect(loaded.apiKeys ?? []).toHaveLength(0);
  });

  test("one malformed entry costs only itself", () => {
    saveConfig(baseConfig());
    const raw = readRawConfig();
    raw.apiKeys = [
      { id: "good", name: "usable", key: "ocx_data_usable", createdAt: "2026-07-31T00:00:00.000Z" },
      { id: "", name: 7 },
    ];
    writeRawConfig(raw);

    const loaded = loadConfig();
    expect(Object.keys(loaded.providers)).toContain("test");
    const kept = loaded.apiKeys ?? [];
    expect(kept).toHaveLength(1);
    expect(kept[0]!.id).toBe("good");
  });

  test("malformed metadata never revokes a usable credential", () => {
    saveConfig(baseConfig());
    const raw = readRawConfig();
    // Only `key` is load-bearing — admission compares that string and nothing
    // else. A hand-edited numeric `name` used to take the whole entry down with
    // it, which is a silent revocation of a key the user still has deployed.
    raw.apiKeys = [
      { id: "still-live", name: 7, key: "ocx_data_stilllive", createdAt: 1234 },
    ];
    writeRawConfig(raw);

    const loaded = loadConfig();
    const kept = loaded.apiKeys ?? [];
    expect(kept).toHaveLength(1);
    expect(kept[0]!.key).toBe("ocx_data_stilllive");
    expect(isDataPlaneAdmissionSecret("ocx_data_stilllive", loaded)).toBe(true);
  });

  test("a salvaged credential stays manageable: it gets a real id", async () => {
    saveConfig(baseConfig());
    const raw = readRawConfig();
    // A non-string id degrades to "" — and the management routes reject an empty
    // id before matching, so without a repair the user would hold a live key
    // they cannot rename or revoke.
    raw.apiKeys = [
      { id: 7, name: "unmanageable", key: "ocx_data_needsid", createdAt: "2026-07-31T00:00:00.000Z" },
    ];
    writeRawConfig(raw);

    const server = startServer(0);
    try {
      const listed = await keysRequest(server, "GET");
      const rows = listed.json.keys as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
      const id = rows[0]!.id as string;
      expect(id).toBeTruthy();

      const renamed = await keysRequest(server, "PATCH", { id, name: "now-manageable" });
      expect(renamed.status).toBe(200);

      const removed = await keysRequest(server, "DELETE", { id });
      expect(removed.status).toBe(200);
      expect(isDataPlaneAdmissionSecret("ocx_data_needsid", loadConfig())).toBe(false);
    } finally {
      await server.stop(true);
    }
  });

  test("a whitespace-only key is dropped, not floated to the front", () => {
    saveConfig(baseConfig());
    const raw = readRawConfig();
    // system-env.ts and cli/claude.ts hand apiKeys[0].key to launched clients.
    // A key that can never admit (admission trims the candidate) must not occupy
    // that slot and mask the valid one behind it.
    raw.apiKeys = [
      { id: "junk", name: "whitespace", key: "   ", createdAt: "2026-07-31T00:00:00.000Z" },
      { id: "real", name: "usable", key: "ocx_data_realkey", createdAt: "2026-07-31T00:00:00.000Z" },
    ];
    writeRawConfig(raw);

    const loaded = loadConfig();
    const kept = loaded.apiKeys ?? [];
    expect(kept).toHaveLength(1);
    expect(kept[0]!.key).toBe("ocx_data_realkey");
    expect(ownAdmissionTokens(loaded)).toEqual(["ocx_data_realkey"]);
  });

  test("a dropped key is never described as still working", () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
    try {
      saveConfig(baseConfig());
      const raw = readRawConfig();
      // Unusable key AND bad metadata. The row is dropped, so the
      // "repaired metadata — the key still works" line would be a lie.
      raw.apiKeys = [
        { id: 7, name: 7, key: " bad-secret ", createdAt: 7 },
      ];
      writeRawConfig(raw);
      loadConfig();
      expect(warnings.some(w => w.includes("skipped 1"))).toBe(true);
      expect(warnings.some(w => w.includes("repaired metadata"))).toBe(false);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("a duplicate id is reported too", () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
    try {
      saveConfig(baseConfig());
      const raw = readRawConfig();
      raw.apiKeys = [
        { id: "same", name: "one", key: "ocx_data_dupwarnone", createdAt: "2026-07-31T00:00:00.000Z" },
        { id: "same", name: "two", key: "ocx_data_dupwarntwo", createdAt: "2026-07-31T00:00:00.000Z" },
      ];
      writeRawConfig(raw);
      loadConfig();
      // Neither the skipped counter nor the metadata counter can see this.
      expect(warnings.some(w => w.includes("shared an id"))).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("metadata repair is reported, not silent", () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
    try {
      saveConfig(baseConfig());
      const raw = readRawConfig();
      raw.apiKeys = [
        { id: "keeps-working", name: 7, key: "ocx_data_repaired", createdAt: "2026-07-31T00:00:00.000Z" },
      ];
      writeRawConfig(raw);
      loadConfig();
      // Same length in and out, so the skipped-entry counter says nothing here.
      expect(warnings.some(w => w.includes("apiKeys") && w.includes("repaired metadata on 1"))).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("a credential salvaged from bad metadata survives a later save", async () => {
    saveConfig(baseConfig());
    const raw = readRawConfig();
    raw.apiKeys = [
      { id: "still-live", name: 7, key: "ocx_data_stilllive", createdAt: "2026-07-31T00:00:00.000Z" },
    ];
    writeRawConfig(raw);

    const server = startServer(0);
    try {
      await keysRequest(server, "POST", { name: "added-later" });
      const persisted = loadConfig().apiKeys ?? [];
      expect(persisted.map(k => k.key)).toContain("ocx_data_stilllive");
    } finally {
      await server.stop(true);
    }
  });

  test("degraded apiKeys are reported, not dropped silently", () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
    try {
      saveConfig(baseConfig());
      const raw = readRawConfig();
      raw.apiKeys = [
        { id: "good", name: "usable", key: "ocx_data_usable", createdAt: "2026-07-31T00:00:00.000Z" },
        { id: "", name: 7 },
      ];
      writeRawConfig(raw);
      loadConfig();
      expect(warnings.some(w => w.includes("apiKeys") && w.includes("skipped 1"))).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("a non-array apiKeys value is reported too", () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
    try {
      saveConfig(baseConfig());
      const raw = readRawConfig();
      raw.apiKeys = "oops";
      writeRawConfig(raw);
      loadConfig();
      expect(warnings.some(w => w.includes("apiKeys is not an array"))).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("the repaired-retry load path also reports degraded apiKeys", () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    const originalError = console.error;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
    console.error = () => { /* warnConfigRepaired is noise here */ };
    try {
      saveConfig(baseConfig());
      const raw = readRawConfig();
      // The retry path repairs MISSING fields — the merge is
      // `{...defaults, ...parsed}`, so a present-but-invalid value would just win
      // again and fall through to backup-and-defaults. Deleting a required field
      // is what actually routes this load through the retry branch.
      delete raw.defaultProvider;
      raw.apiKeys = [
        { id: "good", name: "usable", key: "ocx_data_usable", createdAt: "2026-07-31T00:00:00.000Z" },
        { id: "", name: 7 },
      ];
      writeRawConfig(raw);
      const loaded = loadConfig();
      expect(loaded.apiKeys ?? []).toHaveLength(1);
      expect(warnings.some(w => w.includes("apiKeys") && w.includes("skipped 1"))).toBe(true);
    } finally {
      console.warn = originalWarn;
      console.error = originalError;
    }
  });

  test("the survivor persists through a later mutation", async () => {
    saveConfig(baseConfig());
    const raw = readRawConfig();
    raw.apiKeys = [
      { id: "good", name: "usable", key: "ocx_data_usable", createdAt: "2026-07-31T00:00:00.000Z" },
      { id: "", name: 7 },
    ];
    writeRawConfig(raw);

    const server = startServer(0);
    try {
      await keysRequest(server, "POST", { name: "added-later" });
      const stored = loadConfig().apiKeys ?? [];
      expect(stored.map(k => k.id)).toContain("good");
      expect(stored).toHaveLength(2);
    } finally {
      await server.stop(true);
    }
  });

  test("a legacy over-long name still loads", () => {
    saveConfig(baseConfig());
    const raw = readRawConfig();
    raw.apiKeys = [
      { id: "legacy", name: "n".repeat(200), key: "ocx_data_legacy", createdAt: "2026-07-31T00:00:00.000Z" },
    ];
    writeRawConfig(raw);

    const kept = loadConfig().apiKeys ?? [];
    expect(kept).toHaveLength(1);
    expect(kept[0]!.name).toHaveLength(200);
  });

  test("unknown per-key properties survive a load, mutate and save round trip", async () => {
    saveConfig(baseConfig());
    const raw = readRawConfig();
    raw.apiKeys = [
      {
        id: "extra",
        name: "carries-extra",
        key: "ocx_data_extra",
        createdAt: "2026-07-31T00:00:00.000Z",
        futureField: "keep me",
      },
    ];
    writeRawConfig(raw);

    const server = startServer(0);
    try {
      await keysRequest(server, "POST", { name: "trigger-a-save" });
      const persisted = readRawConfig().apiKeys as Array<Record<string, unknown>>;
      const extra = persisted.find(k => k.id === "extra");
      expect(extra?.futureField).toBe("keep me");
    } finally {
      await server.stop(true);
    }
  });
  test("a repaired id is stable across loads, not reminted every parse", () => {
    saveConfig(baseConfig());
    const raw = readRawConfig();
    raw.apiKeys = [
      { id: 7, name: "needs-an-id", key: "ocx_data_stableid", createdAt: "2026-07-31T00:00:00.000Z" },
    ];
    writeRawConfig(raw);

    const first = (loadConfig().apiKeys ?? [])[0]!.id;
    const second = (loadConfig().apiKeys ?? [])[0]!.id;
    expect(first).toBeTruthy();
    // Minting inside the schema transform handed out a new id on every parse, so
    // the GUI and the management routes disagreed after any restart. The repair is
    // derived from row position instead: same file in, same ids out, no I/O.
    expect(second).toBe(first);
    // And it must NOT write during a load — that put a stale snapshot on a
    // collision course with any concurrent legitimate save.
    expect((readRawConfig().apiKeys as Array<Record<string, unknown>>)[0]!.id).toBe(7);
  });

  test("diagnostics see the same repaired ids as loadConfig", () => {
    saveConfig(baseConfig());
    const raw = readRawConfig();
    raw.apiKeys = [
      { id: 7, name: "needs-an-id", key: "ocx_data_diagnostics", createdAt: "2026-07-31T00:00:00.000Z" },
    ];
    writeRawConfig(raw);

    // CLI show/get/export read diagnostics, not loadConfig. A repaired id that
    // only exists on one of those paths is not a stable id.
    const viaLoad = (loadConfig().apiKeys ?? [])[0]!.id;
    const viaDiagnostics = (readConfigDiagnostics().config.apiKeys ?? [])[0]!.id;
    expect(viaDiagnostics).toBeTruthy();
    expect(viaDiagnostics).toBe(viaLoad);
  });

  test("a synthesized id never steals an id another key already owns", () => {
    saveConfig(baseConfig());
    const raw = readRawConfig();
    // Row 1 needs an id and would naively take "salvaged-1" — which row 2
    // legitimately owns from an earlier normalization. Taking an id the user
    // already has is exactly what this repair must not do.
    raw.apiKeys = [
      { id: 7, name: "needs-an-id", key: "ocx_data_needsid", createdAt: "2026-07-31T00:00:00.000Z" },
      { id: "salvaged-1", name: "already-owns-it", key: "ocx_data_ownsit", createdAt: "2026-07-31T00:00:00.000Z" },
    ];
    writeRawConfig(raw);

    const kept = loadConfig().apiKeys ?? [];
    const ownsIt = kept.find(k => k.key === "ocx_data_ownsit")!;
    const needsId = kept.find(k => k.key === "ocx_data_needsid")!;
    expect(ownsIt.id).toBe("salvaged-1");
    expect(needsId.id).not.toBe("salvaged-1");
    expect(needsId.id).toBeTruthy();
  });

  test("the first holder of a duplicate id keeps it", () => {
    saveConfig(baseConfig());
    const raw = readRawConfig();
    raw.apiKeys = [
      { id: "shared", name: "first", key: "ocx_data_firstdup", createdAt: "2026-07-31T00:00:00.000Z" },
      { id: "shared", name: "second", key: "ocx_data_seconddup", createdAt: "2026-07-31T00:00:00.000Z" },
    ];
    writeRawConfig(raw);

    const kept = loadConfig().apiKeys ?? [];
    expect(kept.find(k => k.key === "ocx_data_firstdup")!.id).toBe("shared");
    expect(kept.find(k => k.key === "ocx_data_seconddup")!.id).not.toBe("shared");
  });

  test("duplicate ids are separated so each key stays individually revocable", () => {
    saveConfig(baseConfig());
    const raw = readRawConfig();
    raw.apiKeys = [
      { id: "same", name: "one", key: "ocx_data_dupone", createdAt: "2026-07-31T00:00:00.000Z" },
      { id: "same", name: "two", key: "ocx_data_duptwo", createdAt: "2026-07-31T00:00:00.000Z" },
    ];
    writeRawConfig(raw);

    const kept = loadConfig().apiKeys ?? [];
    expect(kept).toHaveLength(2);
    expect(kept[0]!.id).not.toBe(kept[1]!.id);
  });

  test("a key with surrounding whitespace is dropped: it can never admit", () => {
    saveConfig(baseConfig());
    const raw = readRawConfig();
    // Admission trims the PRESENTED token but compares against the stored value
    // verbatim, so " ocx_data_spaced " matches neither form of itself.
    raw.apiKeys = [
      { id: "spaced", name: "unusable", key: " ocx_data_spaced ", createdAt: "2026-07-31T00:00:00.000Z" },
      { id: "real", name: "usable", key: "ocx_data_realkey", createdAt: "2026-07-31T00:00:00.000Z" },
    ];
    writeRawConfig(raw);

    const loaded = loadConfig();
    expect((loaded.apiKeys ?? []).map(k => k.key)).toEqual(["ocx_data_realkey"]);
    expect(ownAdmissionTokens(loaded)).toEqual(["ocx_data_realkey"]);
  });
});

describe("key quota write boundary", () => {
  test("POST persists and echoes quota and scope without echoing them in later reads", async () => {
    saveConfig(baseConfig());
    const server = startServer(0);
    try {
      const created = await keysRequest(server, "POST", {
        name: "limited",
        quota: { dailyUsd: 5, monthlyUsd: 50 },
        allowedProviders: ["test"],
        allowedModels: ["gpt-test"],
      });
      expect(created.status).toBe(201);
      expect(created.json.quota).toEqual({ dailyUsd: 5, monthlyUsd: 50 });
      expect(created.json.allowedProviders).toEqual(["test"]);
      expect(created.json.allowedModels).toEqual(["gpt-test"]);

      const stored = loadConfig().apiKeys ?? [];
      expect(stored[0]!.quota).toEqual({ dailyUsd: 5, monthlyUsd: 50 });
    } finally {
      await server.stop(true);
    }
  });

  test.each([
    ["a negative window", { quota: { dailyUsd: -1 } }],
    ["a window over the cap", { quota: { weeklyUsd: 1_000_001 } }],
    ["a string window", { quota: { monthlyUsd: "5" } }],
    ["an unknown quota field", { quota: { yearlyUsd: 5 } }],
    ["a non-object quota", { quota: "unlimited" }],
  ])("POST rejects %s with 400 and persists nothing", async (_label, patch) => {
    saveConfig(baseConfig());
    const server = startServer(0);
    try {
      const created = await keysRequest(server, "POST", { name: "bad", ...patch });
      expect(created.status).toBe(400);
      expect(loadConfig().apiKeys ?? []).toHaveLength(0);
    } finally {
      await server.stop(true);
    }
  });

  test("POST rejects a raw NaN quota literal with 400", async () => {
    saveConfig(baseConfig());
    const server = startServer(0);
    try {
      const created = await keysRequest(server, "POST", '{"name":"bad","quota":{"dailyUsd":NaN}}');
      expect(created.status).toBe(400);
      expect(loadConfig().apiKeys ?? []).toHaveLength(0);
    } finally {
      await server.stop(true);
    }
  });

  test("PATCH quota updates merge per-window, null clears, and a quota-only patch is enough", async () => {
    saveConfig(baseConfig());
    const server = startServer(0);
    try {
      const created = await keysRequest(server, "POST", { name: "limited" });
      const id = created.json.id as string;

      expect((await keysRequest(server, "PATCH", { id, quota: { dailyUsd: 5 } })).status).toBe(200);
      expect((await keysRequest(server, "PATCH", { id, quota: { weeklyUsd: 7 } })).status).toBe(200);
      expect(loadConfig().apiKeys?.[0]?.quota).toEqual({ dailyUsd: 5, weeklyUsd: 7 });

      // Renaming must not disturb the quota the caller never mentioned.
      expect((await keysRequest(server, "PATCH", { id, name: "renamed" })).status).toBe(200);
      expect(loadConfig().apiKeys?.[0]?.quota).toEqual({ dailyUsd: 5, weeklyUsd: 7 });

      expect((await keysRequest(server, "PATCH", { id, quota: null })).status).toBe(200);
      expect(loadConfig().apiKeys?.[0]?.quota).toBeUndefined();
    } finally {
      await server.stop(true);
    }
  });

  test.each([
    ["a negative window", { quota: { dailyUsd: -0.01 } }],
    ["a window over the cap", { quota: { monthlyUsd: 1_000_000.01 } }],
    ["a string window", { quota: { weeklyUsd: "10" } }],
    ["an unknown quota field", { quota: { hourlyUsd: 1 } }],
    ["a non-object quota", { quota: 0 }],
  ])("PATCH rejects %s with 400 and leaves the stored quota alone", async (_label, patch) => {
    const config = baseConfig();
    config.apiKeys = [{ id: "kept", name: "original", key: "fixture-key", createdAt: "2026-01-01T00:00:00Z", quota: { dailyUsd: 3 } }];
    saveConfig(config);
    const server = startServer(0);
    try {
      expect((await keysRequest(server, "PATCH", { id: "kept", ...patch })).status).toBe(400);
      expect(loadConfig().apiKeys?.[0]?.quota).toEqual({ dailyUsd: 3 });
    } finally {
      await server.stop(true);
    }
  });

  test("PATCH with no recognized field names quota in the error", async () => {
    saveConfig(baseConfig());
    const server = startServer(0);
    try {
      const created = await keysRequest(server, "POST", { name: "keep" });
      const res = await keysRequest(server, "PATCH", { id: created.json.id });
      expect(res.status).toBe(400);
      expect(String(res.json.error)).toContain("quota");
    } finally {
      await server.stop(true);
    }
  });
});

describe("POST /api/keys/quota/reset", () => {
  /** A $1 spend row for `keyId` under the base config's $1/1M-token overlay. */
  function seedSpendRow(keyId: string): void {
    const config = baseConfig();
    config.providers.test!.modelCosts = { "gpt-test": { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };
    refreshUserCostOverlays(config);
    appendFileSync(usageLogPath(), `${JSON.stringify({
      requestId: `seed-${Math.random().toString(36).slice(2)}`,
      timestamp: Date.now(),
      provider: "test",
      model: "gpt-test",
      apiKeyId: keyId,
      admissionKind: "configured",
      status: 200,
      durationMs: 10,
      usageStatus: "reported",
      usage: { inputTokens: 1_000_000, outputTokens: 0 },
    })}\n`, "utf-8");
  }

  test("reset-one stamps quotaResetAt, zeroes reported spend, and persists", async () => {
    saveConfig(baseConfig());
    const server = startServer(0);
    try {
      const created = await keysRequest(server, "POST", { name: "limited", quota: { dailyUsd: 10 } });
      const id = created.json.id as string;
      seedSpendRow(id);

      const before = await keysRequest(server, "GET");
      const beforeRow = (before.json.keys as Array<Record<string, unknown>>)[0]!;
      expect((beforeRow.spend as Record<string, unknown>).dailyUsd).toBe(1);

      const reset = await managementRequest(server, "/api/keys/quota/reset", "POST", { id });
      expect(reset.status).toBe(200);
      expect(reset.json.ok).toBe(true);
      const resetAt = reset.json.resetAt as string;
      expect(Number.isFinite(Date.parse(resetAt))).toBe(true);
      expect(loadConfig().apiKeys?.[0]?.quotaResetAt).toBe(resetAt);

      const after = await keysRequest(server, "GET");
      const afterRow = (after.json.keys as Array<Record<string, unknown>>)[0]!;
      expect(afterRow.quotaResetAt).toBe(resetAt);
      expect(afterRow.spend).toEqual({ dailyUsd: 0, weeklyUsd: 0, monthlyUsd: 0, unpricedRequests: 0 });
    } finally {
      await server.stop(true);
    }
  });

  test("reset-all stamps every key", async () => {
    saveConfig(baseConfig());
    const server = startServer(0);
    try {
      await keysRequest(server, "POST", { name: "one" });
      await keysRequest(server, "POST", { name: "two" });

      const reset = await managementRequest(server, "/api/keys/quota/reset", "POST", { all: true });
      expect(reset.status).toBe(200);
      const resetAt = reset.json.resetAt as string;
      const persisted = loadConfig().apiKeys ?? [];
      expect(persisted).toHaveLength(2);
      for (const key of persisted) expect(key.quotaResetAt).toBe(resetAt);
    } finally {
      await server.stop(true);
    }
  });

  test("an unknown id is 404 and writes nothing", async () => {
    saveConfig(baseConfig());
    const server = startServer(0);
    try {
      await keysRequest(server, "POST", { name: "keep" });
      const reset = await managementRequest(server, "/api/keys/quota/reset", "POST", { id: "ghost" });
      expect(reset.status).toBe(404);
      expect(loadConfig().apiKeys?.[0]?.quotaResetAt).toBeUndefined();
    } finally {
      await server.stop(true);
    }
  });

  test.each([
    ["an empty body", {}],
    ["id and all together", { id: "x", all: true }],
    ["all as a non-true value", { all: false }],
    ["an extra field", { id: "x", note: "hi" }],
  ])("rejects %s with 400", async (_label, body) => {
    saveConfig(baseConfig());
    const server = startServer(0);
    try {
      await keysRequest(server, "POST", { name: "keep" });
      expect((await managementRequest(server, "/api/keys/quota/reset", "POST", body)).status).toBe(400);
      expect(loadConfig().apiKeys?.[0]?.quotaResetAt).toBeUndefined();
    } finally {
      await server.stop(true);
    }
  });
});

describe("GET /api/keys quota and spend fields", () => {
  test("unset windows report 0 and every key carries a spend object", async () => {
    saveConfig(baseConfig());
    const server = startServer(0);
    try {
      await keysRequest(server, "POST", { name: "plain" });
      const listed = await keysRequest(server, "GET");
      const row = (listed.json.keys as Array<Record<string, unknown>>)[0]!;
      expect(row.quota).toEqual({ dailyUsd: 0, weeklyUsd: 0, monthlyUsd: 0 });
      expect(row.quotaResetAt).toBeUndefined();
      expect(row.spend).toEqual({ dailyUsd: 0, weeklyUsd: 0, monthlyUsd: 0, unpricedRequests: 0 });
    } finally {
      await server.stop(true);
    }
  });
});

describe("GET /api/keys/scope-options", () => {
  test("lists provider destinations and excludes combo rows", async () => {
    const config = baseConfig();
    // Static catalogs: the public-list gather must not depend on a live /models fetch.
    config.providers.test = { adapter: "openai-chat", baseUrl: "https://example.test/v1", apiKey: "k", models: ["gpt-test"], liveModels: false };
    config.providers.second = { adapter: "openai-chat", baseUrl: "https://other.test/v1", apiKey: "k", models: ["other-model"], liveModels: false };
    config.combos = { pair: { strategy: "failover", targets: [{ provider: "test", model: "gpt-test" }, { provider: "second", model: "other-model" }] } };
    saveConfig(config);
    const server = startServer(0);
    try {
      const res = await managementRequest(server, "/api/keys/scope-options", "GET");
      expect(res.status).toBe(200);
      const providers = res.json.providers as string[];
      expect(providers).toEqual([...providers].sort());
      expect(providers).not.toContain("combo");
      const models = res.json.models as Array<Record<string, unknown>>;
      expect(models.every(m => m.provider !== "combo")).toBe(true);
      expect(models.some(m => m.value === "combo/pair")).toBe(false);
      expect(models).toContainEqual({ value: "test/gpt-test", publicId: "test/gpt-test", provider: "test" });
    } finally {
      await server.stop(true);
    }
  });
});

describe("data-plane credentials on /api/keys", () => {
  test.each([
    ["a bearer token", (key: string) => ({ authorization: `Bearer ${key}` })],
    ["the dedicated header", (key: string) => ({ "x-opencodex-api-key": key })],
  ])("a generated ocx_data_ key sent as %s gets 401, never key management", async (_label, header) => {
    const config = baseConfig();
    const dataKey = `ocx_data_${"c".repeat(40)}`;
    config.apiKeys = [{ id: "data", name: "data", key: dataKey, createdAt: "2026-01-01T00:00:00Z" }];
    saveConfig(config);
    const server = startServer(0);
    try {
      for (const method of ["GET", "POST"]) {
        const res = await fetch(new URL("/api/keys", server.url), {
          method,
          headers: { "content-type": "application/json", ...header(dataKey) },
          ...(method === "POST" ? { body: "{}" } : {}),
        });
        expect(res.status).toBe(401);
      }
      expect(loadConfig().apiKeys ?? []).toHaveLength(1);
    } finally {
      await server.stop(true);
    }
  });
});
