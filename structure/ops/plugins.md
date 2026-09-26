# Local Plugins

Local plugins let an operator put code in front of provider sends without editing the core.
They are local extensions of one install, not a distribution channel: nothing fetches, updates
or signs them.

## Loading

- `ocx start` calls `loadAndReportOcxPlugins()` from `src/plugins/loader.ts` after the config is
  loaded and before `startServer`, so every hook is registered before the listener binds.
  `startServer` itself stays synchronous; plugin loading is awaited in the CLI, never inside it.
- The loader imports `*.ts`, `*.js` and `*.mjs` from `$OPENCODEX_HOME/plugins/`, sorted by name.
  Names starting with `.` or `_` and `*.d.ts` are ignored. A missing directory loads nothing.
- `OCX_PLUGINS=0` disables loading for that process.
- A plugin runs with the operator's credentials, so the loader refuses a file that is not a regular
  file, is owned by another user, or is writable by group or others (POSIX). This is the same trust
  boundary as `config.json`.
- A missing plugin directory means no plugins. Any other read failure (`EACCES`, `ENOTDIR`) is
  reported as a skipped `plugins directory` entry.
- A plugin module default-exports `{ name?, setup(context) }`. An asynchronous `setup` has five
  seconds; plugins share the proxy thread, so a setup that blocks synchronously cannot be
  interrupted. A plugin that throws, times out or has the wrong shape is reported and skipped:
  its context is closed, every hook it registered is removed, and a setup that resumes after the
  deadline cannot register again. The other plugins and the proxy start normally.
- Plugins cannot import ocx modules: in a compiled binary they live inside `$bunfs`. Everything a
  plugin may use arrives through `OcxPluginContext` (`name`, `configDir`, `pluginDir`, `log`,
  `registerUpstreamRewriter`, `onShutdown`). `onShutdown` registers through
  `src/lib/optional-shutdown-hooks.ts` under a per-file key, so plugins sharing a display name keep
  separate teardowns.

## Upstream rewrite slot

`src/plugins/upstream-hooks.ts` is the only core-owned seam plugins attach to. It imports nothing,
so the request path depends on it without depending on the loader.

- It runs synchronously at the physical send, after the transport was chosen: HTTP in
  `sendWithConnectionPolicy` (`src/server/responses/fetch-helpers.ts`), and the Codex WebSocket
  dial in `CodexWsSession` (`src/server/responses/codex-ws-session.ts`). Rewriting any earlier would
  hide the ChatGPT origin from the WebSocket selection and push Codex turns onto HTTP. The target
  carries the URL, mutable headers and the transport (`http` or `websocket`).
- `sendWithConnectionPolicy` can run twice for one send (an override handing back to the supplied
  executor). The outer pass rewrites and marks the init; the inner pass does not rewrite again.
- HTTP connection and egress decisions in `sendWithConnectionPolicy` follow the rewritten
  destination. The WebSocket proxy is chosen by the caller for the original destination, so
  `rewriteWebSocketDial` drops it when the rewrite targets loopback.
- With no rewriter registered, the send is returned untouched and nothing is allocated.
- A rewriter that throws has its edits to that send undone, is disabled for the rest of the
  process, and the send continues unmodified.
- Rewrites happen after the request is built, routed and paced, so they do not change routing,
  account selection, retry budgets or logging identity. A rewriter that moves a send
  to another host owns that host's behaviour; the core does not re-validate it.
