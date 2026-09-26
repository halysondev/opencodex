/**
 * Upstream rewrite slot for local plugins.
 *
 * A plugin loaded by `src/plugins/loader.ts` may register a rewriter that sees every
 * provider send immediately before it leaves the process: HTTP through
 * `fetchWithHeaderTimeout` / `fetchWithAttemptDeadline`, and the Codex WebSocket dial in
 * `CodexWsSession`. The rewriter may replace the URL and add or change headers — enough to
 * put a local sidecar (a compression proxy, a recorder) in front of the provider without
 * the core knowing it exists.
 *
 * This module imports nothing, so the request path pays one array-length check when no
 * plugin is installed. A rewriter that throws is disabled for the rest of the process and
 * the send continues unmodified: a broken plugin must never take the proxy down with it.
 */

export type UpstreamTransport = "http" | "websocket";

export interface UpstreamTarget {
  /** Absolute upstream URL. A rewriter may assign a new one. */
  url: string;
  /** Mutable outbound headers. Credentials are present; a rewriter must not log them. */
  headers: Headers;
  readonly transport: UpstreamTransport;
}

export type UpstreamRewriter = (target: UpstreamTarget) => void;

interface Registration {
  readonly name: string;
  readonly rewrite: UpstreamRewriter;
  disabled: boolean;
}

const registrations: Registration[] = [];

export function registerUpstreamRewriter(name: string, rewrite: UpstreamRewriter): () => void {
  const registration: Registration = { name, rewrite, disabled: false };
  registrations.push(registration);
  return () => {
    const index = registrations.indexOf(registration);
    if (index >= 0) registrations.splice(index, 1);
  };
}

export function hasUpstreamRewriters(): boolean {
  return registrations.length > 0;
}

/**
 * Run every active rewriter over one send. Returns the input untouched (same objects) when
 * no rewriter is registered, so the common path allocates nothing.
 */
export function rewriteUpstream<H extends HeadersInit | undefined>(
  url: string,
  headers: H,
  transport: UpstreamTransport,
): { url: string; headers: H | Headers } {
  if (registrations.length === 0) return { url, headers };
  const target: UpstreamTarget = { url, headers: new Headers(headers), transport };
  for (const registration of registrations) {
    if (registration.disabled) continue;
    try {
      registration.rewrite(target);
    } catch (error) {
      registration.disabled = true;
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`[opencodex] plugin "${registration.name}" upstream rewriter disabled after an error: ${reason}`);
    }
  }
  return { url: target.url, headers: target.headers };
}

/** Plain-record variant for callers that hold headers as `Record<string, string>` (WebSocket dial). */
export function rewriteUpstreamRecord(
  url: string,
  headers: Record<string, string>,
  transport: UpstreamTransport,
): { url: string; headers: Record<string, string> } {
  if (registrations.length === 0) return { url, headers };
  const result = rewriteUpstream(url, headers, transport);
  const record: Record<string, string> = {};
  new Headers(result.headers).forEach((value, key) => { record[key] = value; });
  return { url: result.url, headers: record };
}

export function resetUpstreamRewritersForTests(): void {
  registrations.length = 0;
}
