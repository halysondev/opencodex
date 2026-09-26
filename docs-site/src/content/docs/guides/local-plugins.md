---
title: Local Plugins
description: Load your own code into the proxy at startup to rewrite provider sends, for example to put a local compression proxy in front of providers.
---

A local plugin is a TypeScript or JavaScript file that `ocx start` loads before the proxy begins
serving. It can see every provider send just before it leaves the process and redirect it or add
headers — enough to place a local sidecar (a compression proxy, a recorder) in front of providers
without changing opencodex itself.

Plugins are local to one install. opencodex does not download, update or sign them.

## Where plugins live

Put plugin files in `plugins/` inside the opencodex home (`~/.opencodex/plugins/`, or
`$OPENCODEX_HOME/plugins/` when that variable is set):

```text
~/.opencodex/plugins/
  my-sidecar.ts
```

- Files ending in `.ts`, `.js` or `.mjs` are loaded in name order.
- Names starting with `.` or `_`, and `*.d.ts`, are ignored — rename a plugin to `_my-sidecar.ts`
  to switch it off.
- The directory is optional. Without it nothing is loaded.
- A plugin runs inside the proxy with your credentials, so opencodex refuses a file owned by another
  user or writable by group or others. Fix it with `chmod go-w ~/.opencodex/plugins/*`.

Restart the proxy after adding, changing or removing a plugin (`ocx service restart`, or stop and
start `ocx start`). Each loaded plugin prints a `Plugin loaded: <name>` line at startup; a skipped
plugin prints the reason.

To start once without plugins, set `OCX_PLUGINS=0`.

## Writing a plugin

A plugin default-exports an object with an optional `name` and a `setup` function. `setup` receives a
context. An asynchronous `setup` has five seconds to finish; plugins run in the proxy's own thread, so
a `setup` that blocks synchronously cannot be interrupted and delays startup until it returns.

```ts
interface UpstreamTarget {
  url: string;            // absolute upstream URL; assign a new one to redirect
  headers: Headers;       // outbound headers, including credentials — never log them
  readonly transport: "http" | "websocket";
}

export default {
  name: "my-sidecar",
  setup(ctx: {
    log(message: string): void;
    registerUpstreamRewriter(rewrite: (target: UpstreamTarget) => void): void;
    onShutdown(teardown: () => void): void;
  }) {
    ctx.registerUpstreamRewriter(target => {
      const upstream = new URL(target.url);
      if (!upstream.pathname.endsWith("/chat/completions")) return;
      target.url = `http://127.0.0.1:9000${upstream.pathname}${upstream.search}`;
      target.headers.set("x-original-origin", upstream.origin);
    });
  },
};
```

The context also carries `name`, `configDir` (the opencodex home) and `pluginDir`.

Plugins cannot import opencodex modules — in the packaged binary they are not on disk. Declare the
small interfaces you need locally, as above.

## How rewrites behave

- The rewriter runs synchronously on every provider send over HTTP and on the Codex WebSocket
  connection, after opencodex has picked the transport. Keep it fast; do network checks (health
  probes) in the background and read a cached result in the rewriter.
- Egress settings (proxy, `noProxy`) are applied to the rewritten HTTP destination. A Codex
  WebSocket redirected to a loopback address connects directly instead of through a configured
  proxy, which could not reach this machine's loopback.
- It runs after opencodex has chosen the provider, account and route, so it does not change routing,
  account selection, retries or request logs.
- A redirected send goes to the host you chose. That host sees the request exactly as the provider
  would, credentials included.
- If a rewriter throws, opencodex undoes its changes to that send, disables it for the rest of the
  process and sends the request unmodified. If `setup` throws or times out, the plugin is skipped,
  anything it registered is removed, and later registration attempts from it are ignored; other
  plugins and the proxy start normally.
- A plugin directory that exists but cannot be read (for example, wrong permissions) is reported at
  startup rather than treated as empty.
