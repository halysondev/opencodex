/**
 * `/api/headroom` — status, metrics, and the enable/baseUrl knobs for the
 * Headroom sidecar redirect (`src/headroom/`). The sidecar itself is queried
 * over its loopback listener; nothing here exposes it beyond management.
 */

import { saveConfigPreservingClaudeCode } from "../../config";
import {
  fetchHeadroomJson,
  headroomStatus,
  resolveHeadroomConfig,
} from "../../headroom";
import { jsonResponse } from "../auth-cors";
import { readManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";
import { isPlainRecord } from "./shared";
import type { ManagementContext } from "./context";

export async function handleHeadroomRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config, deps } = ctx;
  if (url.pathname !== "/api/headroom" && url.pathname !== "/api/headroom/stats") return null;

  if (url.pathname === "/api/headroom" && req.method === "GET") {
    return jsonResponse(await headroomStatus(config));
  }

  if (url.pathname === "/api/headroom/stats" && req.method === "GET") {
    const { baseUrl } = resolveHeadroomConfig(config);
    const stats = await fetchHeadroomJson(baseUrl, "/stats");
    if (stats === undefined) return jsonResponse({ error: "headroom unreachable", baseUrl }, 502);
    return jsonResponse(stats);
  }

  if (url.pathname === "/api/headroom" && req.method === "PUT") {
    let raw: unknown;
    try { raw = await readManagementJsonBody(req); } catch (error) { rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "invalid JSON body" }, 400); }
    if (!isPlainRecord(raw)) return jsonResponse({ error: "body must be a JSON object" }, 400);
    if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
      return jsonResponse({ error: "enabled must be a boolean" }, 400);
    }
    let baseUrl: string | undefined;
    if (raw.baseUrl !== undefined) {
      if (typeof raw.baseUrl !== "string" || !raw.baseUrl.trim()) {
        return jsonResponse({ error: "baseUrl must be a non-empty string" }, 400);
      }
      try {
        const parsed = new URL(raw.baseUrl.trim());
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          return jsonResponse({ error: "baseUrl must be an http(s) URL" }, 400);
        }
        baseUrl = parsed.origin + parsed.pathname.replace(/\/+$/, "");
      } catch {
        return jsonResponse({ error: "baseUrl must be a valid URL" }, 400);
      }
    }
    const next = { ...(config.headroom ?? {}) };
    if (raw.enabled !== undefined) next.enabled = raw.enabled;
    if (baseUrl !== undefined) next.baseUrl = baseUrl;
    config.headroom = next;
    (deps.saveConfigPreservingClaudeCode ?? saveConfigPreservingClaudeCode)(config);
    return jsonResponse(await headroomStatus(config));
  }

  return jsonResponse({ error: "method not allowed" }, 405);
}
