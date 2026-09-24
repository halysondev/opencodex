import type { OcxConfig } from "../../types";
import type { RequestLogContext } from "../request-log";
import type { HandleResponsesOptions } from "./core-options";
import type { TranslatorBudget } from "../../lib/translator-budget";
import { captureExplicitOpenAiCallerAuth } from "../../providers/openai-sidecar";
import { captureCallerDirectAuth } from "../../providers/caller-authorization";
import { createRequestExecutionBudget } from "../../lib/request-execution-budget";
import { attachRequestSpendTracker } from "./request-spend";
import { finalizeOwnedTranslatorBudget, finalizeResponseLifecycle } from "./core-lifetime";
import { demaskGuardrailsResponse } from "../../guardrails/turn";
import { captureGuardrailsPolicy, retainCapturedGuardrailsRuntimeSnapshot } from "../../guardrails/activation";
import type { GuardrailsRuntimeSnapshotLease } from "../../guardrails/runtime";
import { recordGuardrailsEvent, recordGuardrailsToolArgumentRestoreSkipped } from "../../guardrails/telemetry";

/**
 * The Guardrails request boundary around `handleResponsesInner`: capture one
 * immutable policy before work, retain an inherited snapshot lease, demask
 * successful assistant output, and release every lease exactly once.
 */
export async function runResponsesRequestWithGuardrails(args: {
  req: Request;
  config: OcxConfig;
  logCtx: RequestLogContext;
  options: HandleResponsesOptions;
  translatorBudget: TranslatorBudget;
  ownsBudget: boolean;
  inner: (
    innerOptions: HandleResponsesOptions & { translatorBudget: TranslatorBudget },
  ) => Promise<Response>;
}): Promise<Response> {
  const { req, config, logCtx, options, translatorBudget, ownsBudget, inner } = args;
  const inheritedGuardrailsSnapshot = options.guardrailsTurn?.snapshot ?? options.guardrailsSnapshot;
  const capturedGuardrailsPolicy = options.guardrailsCapturedPolicy
    ?? captureGuardrailsPolicy(config);
  const guardrailsTelemetrySurface = options.inboundWire === "chat"
    ? "chat"
    : options.inboundWire === "anthropic"
      ? "messages"
      : "responses";
  let guardrailsLease: GuardrailsRuntimeSnapshotLease | undefined;
  let innerOptions: (HandleResponsesOptions & { translatorBudget: TranslatorBudget }) | undefined;
  const guardrailsPassthroughFailure = options.guardrailsPassthroughFailure === true;
  try {
    if (inheritedGuardrailsSnapshot) {
      guardrailsLease = await retainCapturedGuardrailsRuntimeSnapshot(inheritedGuardrailsSnapshot);
    }
    innerOptions = {
      ...options,
      openAiSidecarAuth: options.openAiSidecarAuth === undefined
        ? captureExplicitOpenAiCallerAuth(req.headers, config) : options.openAiSidecarAuth,
      nativeCallerAuth: options.nativeCallerAuth === undefined
        ? captureExplicitOpenAiCallerAuth(req.headers, config) : options.nativeCallerAuth,
      callerDirectAuth: options.callerDirectAuth === undefined
        ? captureCallerDirectAuth(req.headers, config) : options.callerDirectAuth,
      // Capture before combo replay rebuilds the Request headers; children carry options.
      visionDescribeTerminal: options.visionDescribeTerminal === true
        || req.headers.get("x-opencodex-vision-describe") === "1",
      translatorBudget,
      // Once at ingress, spend observer included: a combo child inherits the parent's holder.
      sendBudget: options.sendBudget ?? createRequestExecutionBudget(undefined, undefined, attachRequestSpendTracker(req, logCtx)),
      guardrailsCapturedPolicy: capturedGuardrailsPolicy,
      guardrailsSnapshot: options.guardrailsSnapshot ?? guardrailsLease?.snapshot,
      guardrailsPassthroughFailure,
    };
    const response = await inner(innerOptions);
    const demasked = innerOptions.guardrailsResponseProcessedByComboChild
      ? response
      : await demaskGuardrailsResponse(
          response,
          innerOptions.guardrailsTurn,
          translatorBudget,
          () => recordGuardrailsEvent({
            surface: guardrailsTelemetrySurface,
            mode: innerOptions?.guardrailsTurn?.mode ?? "enforce",
            result: "demask_warning",
            registryGeneration: innerOptions?.guardrailsTurn?.snapshot.generation ?? 0,
            count: 1,
            categoryIds: [],
            ruleIds: [],
            latencyMs: 0,
            severity: "warning",
          }),
          count => recordGuardrailsToolArgumentRestoreSkipped(
            guardrailsTelemetrySurface,
            innerOptions?.guardrailsTurn,
            count,
          ),
        );
    const releaseGuardrailsLifecycle = () => {
      innerOptions?.guardrailsResponseContinuationLease?.release();
      innerOptions?.guardrailsParentContinuationLease?.release();
      innerOptions?.guardrailsCompactContinuationLease?.release();
      innerOptions?.guardrailsRuntimeLease?.release();
      guardrailsLease?.release();
    };
    const hasGuardrailsLifecycle = guardrailsLease !== undefined
      || innerOptions.guardrailsResponseContinuationLease !== undefined
      || innerOptions.guardrailsParentContinuationLease !== undefined
      || innerOptions.guardrailsCompactContinuationLease !== undefined
      || innerOptions.guardrailsRuntimeLease !== undefined;
    return ownsBudget
      ? finalizeOwnedTranslatorBudget(demasked, translatorBudget, releaseGuardrailsLifecycle)
      : hasGuardrailsLifecycle
        ? finalizeResponseLifecycle(demasked, releaseGuardrailsLifecycle)
        : demasked;
  } catch (error) {
    innerOptions?.guardrailsResponseContinuationLease?.release();
    innerOptions?.guardrailsParentContinuationLease?.release();
    innerOptions?.guardrailsCompactContinuationLease?.release();
    innerOptions?.guardrailsRuntimeLease?.release();
    guardrailsLease?.release();
    if (ownsBudget) translatorBudget.dispose();
    throw error;
  }
}
