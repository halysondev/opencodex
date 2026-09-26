import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOcxPlugins, pluginFileTrustError } from "../../src/plugins/loader";
import {
  hasUpstreamRewriters,
  resetUpstreamRewritersForTests,
  rewriteUpstream,
} from "../../src/plugins/upstream-hooks";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ocx-plugins-"));
  delete process.env["OCX_PLUGINS"];
});

afterEach(() => {
  resetUpstreamRewritersForTests();
  delete process.env["OCX_PLUGINS"];
  rmSync(dir, { recursive: true, force: true });
});

function writePlugin(file: string, source: string, mode = 0o600): string {
  const path = join(dir, file);
  writeFileSync(path, source);
  chmodSync(path, mode);
  return path;
}

const REDIRECT_PLUGIN = `
export default {
  name: "redirect",
  setup(ctx) {
    ctx.registerUpstreamRewriter(target => { target.url = "http://127.0.0.1:8787" + new URL(target.url).pathname; });
  },
};
`;

test("a missing plugin directory loads nothing", async () => {
  expect(await loadOcxPlugins(join(dir, "absent"))).toEqual([]);
  expect(hasUpstreamRewriters()).toBe(false);
});

test("a valid plugin registers its upstream rewriter", async () => {
  writePlugin("redirect.ts", REDIRECT_PLUGIN);
  const results = await loadOcxPlugins(dir);
  expect(results.map(result => [result.name, result.loaded])).toEqual([["redirect", true]]);
  expect(rewriteUpstream("https://api.example.com/v1/responses", undefined, "http").url)
    .toBe("http://127.0.0.1:8787/v1/responses");
});

test("OCX_PLUGINS=0 skips loading", async () => {
  writePlugin("redirect.ts", REDIRECT_PLUGIN);
  process.env["OCX_PLUGINS"] = "0";
  expect(await loadOcxPlugins(dir)).toEqual([]);
  expect(hasUpstreamRewriters()).toBe(false);
});

test.skipIf(process.platform === "win32")("a group- or world-writable plugin is refused", async () => {
  const path = writePlugin("redirect.ts", REDIRECT_PLUGIN, 0o664);
  expect(pluginFileTrustError(path)).toContain("writable by group or others");
  const [result] = await loadOcxPlugins(dir);
  expect(result?.loaded).toBe(false);
  expect(hasUpstreamRewriters()).toBe(false);
});

test("a wrong export shape or a throwing setup is skipped and leaves no hooks behind", async () => {
  writePlugin("a-shape.ts", "export default { name: 'shape' };");
  writePlugin("b-throws.ts", `
export default {
  setup(ctx) {
    ctx.registerUpstreamRewriter(target => { target.url = "http://leaked/"; });
    throw new Error("setup failed");
  },
};
`);
  writePlugin("c-ok.ts", REDIRECT_PLUGIN);
  const results = await loadOcxPlugins(dir);
  expect(results.map(result => [result.name, result.loaded])).toEqual([
    ["a-shape", false],
    ["b-throws", false],
    ["redirect", true],
  ]);
  expect(results[1]?.error).toBe("setup failed");
  expect(rewriteUpstream("https://api.example.com/v1/x", undefined, "http").url).toBe("http://127.0.0.1:8787/v1/x");
});

test("hidden, underscore-prefixed and declaration files are ignored", async () => {
  writePlugin(".hidden.ts", REDIRECT_PLUGIN);
  writePlugin("_draft.ts", REDIRECT_PLUGIN);
  writePlugin("types.d.ts", "export {};");
  writePlugin("notes.md", "# not a plugin");
  expect(await loadOcxPlugins(dir)).toEqual([]);
});
