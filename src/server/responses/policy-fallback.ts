import { getCodexQuotaRevision } from "../../codex/quota-events";
import { isCodexStrictQuotaEnabled } from "../../codex/strict-quota";
import { isStrictQuotaWaitResponse } from "./strict-quota-response";
import { waitForStrictQuotaResponse, type StrictQuotaWaitOptions } from "./strict-quota-wait";
import { comboFailureDecision } from "../../combos/failover";
import { readBoundedResponseBody } from "../../lib/bounded-body";
import { isNonReplayableResponse } from "../../lib/upstream-retry";
import { finishRequestAttempt, type RequestLogContext } from "../request-log";
import { linkRequestSessionLane } from "../request-log-conversation";
import type { OcxConfig } from "../../types";
import type { RouteCandidateTrace, RouteDecisionTraceV1 } from "../../routing/trace";
import { handleResponses as handleResponsesCore, type ResponsesReplaySnapshot } from "./core";
import { requestPacingOverloadResponse } from "./pacing-overload";
import { captureExplicitOpenAiCallerAuth } from "../../providers/openai-sidecar";
import { captureCallerDirectAuth } from "../../providers/caller-authorization";
import { resolvePolicyProfileId } from "../../routing/profile";
import { parseSyntheticRowId } from "../fast-row";

type CoreHandler = typeof handleResponsesCore;
type CoreOptions = Parameters<CoreHandler>[3];

export interface PolicyFallbackDeps {
  runCore?: CoreHandler;
  quotaWait?: Pick<StrictQuotaWaitOptions, "waitForChange" | "heartbeatMs">;
}

function candidateKey(candidate: Pick<RouteCandidateTrace, "provider" | "model">): string {
  return `${candidate.provider}\u0000${candidate.model}`;
}

/**
 * Rank the remaining candidates from the ORIGINAL policy trace. The initial
 * decision stays immutable; fallback execution belongs in attempts[], not in a
 * rewritten decision trace.
 */
export function rankPolicyFallbackCandidates(
  trace: RouteDecisionTraceV1,
  tried: ReadonlySet<string>,
): RouteCandidateTrace[] {
  return trace.candidates
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) =>
      candidate.eligible
      && candidate.exclusions.length === 0
      && !tried.has(candidateKey(candidate)))
    .sort((left, right) => {
      const scoreDelta = (right.candidate.score?.total ?? Number.NEGATIVE_INFINITY)
        - (left.candidate.score?.total ?? Number.NEGATIVE_INFINITY);
      return scoreDelta || left.index - right.index;
    })
    .map(({ candidate }) => candidate);
}

function requestWithBody(req: Request, rawBody: Record<string, unknown>, signal = req.signal): Request {
  const headers = new Headers(req.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.set("content-type", "application/json");
  return new Request(req.url, { method: req.method, headers, body: JSON.stringify(rawBody), signal });
}

function requestWithCandidate(
  req: Request,
  rawBody: Record<string, unknown>,
  candidate: Pick<RouteCandidateTrace, "provider" | "model">,
): Request {
  const headers = new Headers(req.headers);
  // The next candidate owns a different physical credential domain. Typed
  // admission and any claimed Claude snapshot stay in caller-owned CoreOptions.
  headers.delete("authorization");
  headers.delete("chatgpt-account-id");
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.set("content-type", "application/json");
  const retryRequest = new Request(req.url, {
    method: req.method,
    headers,
    body: JSON.stringify({ ...rawBody, model: `${candidate.provider}/${candidate.model}` }),
    signal: req.signal,
  });
  // A sessionless request keeps the lane it was already allocated. Without this the second
  // candidate reaches OpenCode Go under a different x-opencode-session than the first attempt,
  // which is the same conversation split the header exists to prevent.
  linkRequestSessionLane(req, retryRequest);
  return retryRequest;
}

function errorCodeFromText(text: string): string | undefined {
  if (!text) return undefined;
  try {
    const payload = JSON.parse(text) as { error?: { code?: unknown; type?: unknown }; code?: unknown };
    const candidate = payload.error?.code ?? payload.error?.type ?? payload.code;
    return typeof candidate === "string" ? candidate : undefined;
  } catch {
    return undefined;
  }
}

async function shouldHopPolicyCandidate(response: Response, signal?: AbortSignal): Promise<boolean> {
  if (response.status < 400 || signal?.aborted) return false;
  // A response that must not be sent again cannot open a policy-candidate retry either.
  if (isNonReplayableResponse(response)) return false;
  try {
    const inspected = await readBoundedResponseBody(response.clone(), { signal });
    const text = inspected.displaySafe ? inspected.text : "";
    return comboFailureDecision(response.status, text, { code: errorCodeFromText(text) }) === "hop";
  } catch {
    return false;
  }
}

function isPolicyDecision(trace: RouteDecisionTraceV1 | undefined): trace is RouteDecisionTraceV1 {
  return trace?.routeKind === "policy" && !!trace.profile;
}

/** Finalize the failed physical attempt so the retry receives a fresh attempt row. */
function finishFailedPolicyAttempt(logCtx: RequestLogContext, status: number): void {
  const attempt = logCtx.activeAttempt;
  if (attempt) {
    const startedAt = logCtx.activeAttemptStartedAt ?? Date.now();
    finishRequestAttempt(attempt, status, Math.max(0, Date.now() - startedAt), attempt.usage ?? logCtx.usage);
  }
  delete logCtx.activeAttempt;
  delete logCtx.activeAttemptStartedAt;
  delete logCtx.usage;
  delete logCtx.usageFromBridge;
  delete logCtx.upstreamError;
  delete logCtx.terminalHttpStatus;
  delete logCtx.terminalErrorCode;
  delete logCtx.terminalIncompleteReason;
}

/**
 * Run a Responses request and, only for an explicitly selected policy profile,
 * hop to the next eligible policy candidate after a retryable pre-success
 * failure. The initial policy trace remains the canonical selection evidence;
 * physical retries continue to accumulate in the existing request attempts.
 */
export async function handleResponsesWithPolicyFallback(
  req: Request,
  config: OcxConfig,
  logCtx: RequestLogContext,
  options: CoreOptions = {},
  deps: PolicyFallbackDeps = {},
): Promise<Response> {
  const runCore = deps.runCore ?? handleResponsesCore;
  // Teed before runCore consumes the request: the strict-quota wait rebuilds the
  // request to resume, and a dispatcher that never reports the parsed body still
  // leaves this lazy copy available.
  const wireBody = req.clone();
  let requestBodyReadNotified = false;
  let storedPool401ReplayDispatched = false;
  let rawBody: Record<string, unknown> | null = null;
  let captureQuotaReplay: (() => ResponsesReplaySnapshot) | undefined;
  const coreOptions: CoreOptions = {
    ...options,
    onQuotaReplaySnapshot: capture => { captureQuotaReplay = capture; },
    openAiSidecarAuth: options.openAiSidecarAuth === undefined
      ? captureExplicitOpenAiCallerAuth(req.headers, config) : options.openAiSidecarAuth,
    nativeCallerAuth: options.nativeCallerAuth === undefined
      ? captureExplicitOpenAiCallerAuth(req.headers, config) : options.nativeCallerAuth,
    callerDirectAuth: options.callerDirectAuth === undefined
      ? captureCallerDirectAuth(req.headers, config) : options.callerDirectAuth,
    ...(options.onRequestBodyRead ? {
      onRequestBodyRead: () => {
        if (requestBodyReadNotified) return;
        requestBodyReadNotified = true;
        options.onRequestBodyRead?.();
      },
    } : {}),
    onRequestBodyParsed: body => {
      options.onRequestBodyParsed?.(body);
      if (rawBody === null && body && typeof body === "object" && !Array.isArray(body)
        && typeof (body as { model?: unknown }).model === "string") {
        const model = (body as { model: string }).model;
        const { fastRow, effortRow } = parseSyntheticRowId(model, config);
        // Policy retries and strict-quota waits both replay the captured body; keep the
        // snapshot whenever either could need it.
        if (resolvePolicyProfileId(config, fastRow?.baseId ?? effortRow?.baseId ?? model) === null
          && !isCodexStrictQuotaEnabled(config)) return;
        // Recovery and other core preparation may mutate the parsed body in place. Keep an
        // immutable snapshot of the original wire body so a retry cannot serialize those
        // mutations. Object-identity metadata is re-established by each attempt, not serialized.
        rawBody = structuredClone(body as Record<string, unknown>);
      }
    },
    onStoredPool401ReplayDispatched: () => {
      storedPool401ReplayDispatched = true;
      options.onStoredPool401ReplayDispatched?.();
    },
  };
  let response: Response;
  let quotaRevisionBeforeCore = getCodexQuotaRevision();
  try {
    response = await runCore(req, config, logCtx, coreOptions);
  } catch (error) {
    const overload = requestPacingOverloadResponse(error);
    if (overload) return overload;
    throw error;
  }
  const initialTrace = logCtx.routeDecision;
  const initialRequestedModel = logCtx.requestedModel;
  const settleQuotaWait = async (first: Response, raw: Record<string, unknown> | null): Promise<Response> => {
    const snapshot = captureQuotaReplay?.();
    captureQuotaReplay = undefined;
    let body = (snapshot?.sourceBody ?? raw) as Record<string, unknown> | null;
    if (!body) {
      try {
        const parsed = await wireBody.json();
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return first;
        body = parsed as Record<string, unknown>;
      } catch {
        return first;
      }
    }
    return waitForStrictQuotaResponse({
      config, quotaPolicy: options.codexAuthPolicy, initial: first, stream: body.stream === true,
      signals: [req.signal, options.abortSignal], lease: options.turnAdmissionLease,
      canReplay: () => !storedPool401ReplayDispatched,
      finishAttempt: status => finishFailedPolicyAttempt(logCtx, status),
      observedRevision: () => quotaRevisionBeforeCore,
      onFailure: status => { logCtx.terminalHttpStatus = status; },
      ...deps.quotaWait,
      resume: async signal => {
        quotaRevisionBeforeCore = getCodexQuotaRevision();
        try {
          return await runCore(requestWithBody(req, body, signal), config, logCtx, {
            ...coreOptions, abortSignal: signal, quotaReplaySnapshot: snapshot,
            onQuotaReplaySnapshot: undefined,
            // The heartbeat response is inspected by the ordinary outer SSE logger. Native
            // callbacks would otherwise finalize the same logical request a second time.
            ...(body.stream === true ? {
              onNativePassthroughTerminal: undefined, onNativePassthroughCancel: undefined,
            } : {}),
          });
        } catch (error) {
          const overload = requestPacingOverloadResponse(error);
          if (overload) return overload;
          throw error;
        } finally {
          logCtx.requestedModel = initialRequestedModel;
          logCtx.routeDecision = initialTrace;
        }
      },
    });
  };
  if (!rawBody || !isPolicyDecision(initialTrace)) {
    return !storedPool401ReplayDispatched && isStrictQuotaWaitResponse(response)
      ? settleQuotaWait(response, rawBody) : response;
  }
  // Captured for the loop: `rawBody` is also assigned inside `onRequestBodyParsed`,
  // so narrowing is dropped at call sites below.
  const parsedBody = rawBody as Record<string, unknown>;
  let quotaReplayBody: Record<string, unknown> = parsedBody;

  const tried = new Set<string>([
    candidateKey({ provider: initialTrace.selected.provider, model: initialTrace.selected.model }),
  ]);

  while (!storedPool401ReplayDispatched && await shouldHopPolicyCandidate(response, req.signal)) {
    if (req.signal.aborted) return response;
    const next = rankPolicyFallbackCandidates(initialTrace, tried)[0];
    if (!next) break;
    tried.add(candidateKey(next));

    finishFailedPolicyAttempt(logCtx, response.status);
    const retryRequest = requestWithCandidate(req, parsedBody, next);
    quotaReplayBody = { ...parsedBody, model: `${next.provider}/${next.model}` };
    try {
      try {
        quotaRevisionBeforeCore = getCodexQuotaRevision();
        captureQuotaReplay = undefined;
        response = await runCore(retryRequest, config, logCtx, coreOptions);
      } catch (error) {
        const overload = requestPacingOverloadResponse(error);
        if (overload) return overload;
        throw error;
      }
    } finally {
      logCtx.requestedModel = initialRequestedModel;
      logCtx.routeDecision = initialTrace;
    }
  }

  // Exhaust the operator's existing policy candidates before waiting on the final quota lane.
  return !storedPool401ReplayDispatched && isStrictQuotaWaitResponse(response)
    ? settleQuotaWait(response, quotaReplayBody) : response;
}

export const handleResponses = handleResponsesWithPolicyFallback;
