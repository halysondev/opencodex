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
- A plugin module default-exports `{ name?, setup(context) }`. `setup` has five seconds. A plugin
  that throws, times out or has the wrong shape is reported and skipped, and every hook it
  registered during the failed setup is removed. The other plugins and the proxy start normally.
- Plugins cannot import ocx modules: in a compiled binary they live inside `$bunfs`. Everything a
  plugin may use arrives through `OcxPluginContext` (`name`, `configDir`, `pluginDir`, `log`,
  `registerUpstreamRewriter`, `onShutdown`). `onShutdown` registers through
  `src/lib/optional-shutdown-hooks.ts`.

## Upstream rewrite slot

`src/plugins/upstream-hooks.ts` is the only core-owned seam plugins attach to. It imports nothing,
so the request path depends on it without depending on the loader.

- It runs synchronously at the physical send: HTTP in `fetchWithHeaderTimeout`
  (`src/server/responses/fetch-helpers.ts`) and `fetchWithAttemptDeadline`
  (`src/lib/upstream-retry.ts`), and the Codex WebSocket dial in `CodexWsSession`
  (`src/server/responses/codex-ws-session.ts`). The target carries the URL, mutable headers and the
  transport (`http` or `websocket`).
- With no rewriter registered, the send is returned untouched and nothing is allocated.
- A rewriter that throws is disabled for the rest of the process and the send continues unmodified.
- Rewrites happen after the request is built and after egress/pacing decisions, so they do not
  change routing, account selection, retry budgets or logging identity. A rewriter that moves a send
  to another host owns that host's behaviour; the core does not re-validate it.
