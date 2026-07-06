import type { ISupplyDataFunctions } from 'n8n-workflow';

/**
 * Options read from the Trace Exporter node's parameters (PRD §5 "Node A
 * options") and passed down to the wrapper so the eventual callback handler
 * knows what to capture/redact/sample.
 */
export interface TraceExporterOptions {
	traceName: string;
	sessionId: string;
	userId: string;
	metadata: Record<string, unknown>;
	capturePrompts: boolean;
	captureToolIO: boolean;
	maxPayloadSizeKb: number;
	samplingRatePercent: number;
	redactionPatterns: string[];
}

/**
 * STUB — wraps an upstream LangChain chat model with an OTel-emitting
 * callback handler, per PRD §5 Node A ("Wraps the supplied LangChain model,
 * attaching an OTel-emitting callback handler") and §7 ("LangChain callback
 * dependency: wrapping uses `@langchain/core` callback interfaces").
 *
 * This function deliberately does nothing yet — it returns the model
 * unchanged — because:
 *
 * 1. PRD open question O1 ("Does `@n8n/scan-community-package` accept fully-
 *    bundled dependencies?") is unresolved. Emitting real OTel spans needs an
 *    OTel SDK (`@opentelemetry/api` + `@opentelemetry/sdk-trace-*` +
 *    `@opentelemetry/exporter-trace-otlp-http`) and a LangChain callback
 *    handler base class (`@langchain/core/callbacks/base`). Per the hard
 *    scaffold constraint, NEITHER may be added as a runtime dependency until
 *    O1 is answered — they would need to be bundled/vendored via esbuild
 *    instead, and that bundling strategy itself needs verification-team
 *    sign-off (PRD R3).
 *
 * When implemented, this function should:
 *
 * - Construct a `BaseCallbackHandler` (or `CallbackHandlerMethods` object,
 *   same pattern as core's `N8nLlmTracing`/`N8nNonEstimatingTracing` — see
 *   `packages/@n8n/nodes-langchain/nodes/ModelSelector/ModelSelector.node.ts`
 *   for how a core sub-node layers an extra callback onto a model's existing
 *   `callbacks` array without clobbering ones already attached upstream)
 *   whose `handleLLMStart`/`handleLLMEnd`/`handleLLMError`/`handleToolStart`/
 *   `handleToolEnd` etc. hooks open/close OTel spans instead of (or in
 *   addition to) n8n's own execution-log tracing.
 *
 * - F1 (GenAI semantic conventions): on every LLM call, set span attributes
 *   `gen_ai.system` (provider, e.g. "openai"/"anthropic"), `gen_ai.request.model`,
 *   `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, latency
 *   (span duration), and — only when `options.capturePrompts` is true —
 *   `gen_ai.prompt`/`gen_ai.completion` (off by default, PRD R5 privacy
 *   default). Tool calls get the equivalent tool-span attributes only when
 *   `options.captureToolIO` is true. Both payload captures must be truncated
 *   to `options.maxPayloadSizeKb` and run through `options.redactionPatterns`
 *   (regex/JSONPath) before ever leaving the process.
 *
 * - F2 (parent/child span hierarchy): use LangChain's `runId`/`parentRunId`
 *   (available on every callback hook) to build one OTel trace per agent
 *   execution, with the agent run as the root span and LLM/tool calls as
 *   children — mirroring the LangChain run tree rather than inventing a
 *   separate hierarchy.
 *
 * - F3 (n8n context attributes): attach `n8n.workflow.id`, `n8n.workflow.name`,
 *   `n8n.execution.id`, `n8n.node.name`, and environment as span attributes
 *   on the root span, read via `ctx.getWorkflow()` / `ctx.getExecutionId()`
 *   (available on `ISupplyDataFunctions`).
 *
 * - F4: attach `options.sessionId`/`options.userId`/`options.metadata` as
 *   Langfuse/Opik-style trace attributes (these three vendors all read
 *   session/user from well-known OTel attribute names — see their OTel docs)
 *   in addition to the generic n8n context attributes above.
 *
 * - Respect the PRD's non-negotiable failure policy (§5, §6 non-functional):
 *   export MUST be async, fire-and-forget, with a bounded buffer — a slow or
 *   down OTLP backend must never add blocking latency or fail the workflow.
 *   Any export error is caught, counted, and dropped; it must never surface
 *   as a thrown error from this function or from the wrapped model's calls.
 *
 * @param ctx     the sub-node's `ISupplyDataFunctions` context (for reading
 *                 workflow/execution metadata and node parameters — kept as
 *                 a param rather than read internally so this stays unit
 *                 testable without a full node execution)
 * @param model   the upstream LangChain chat model supplied via
 *                 `getInputConnectionData(NodeConnectionTypes.AiLanguageModel, itemIndex)`
 * @param options resolved Trace Exporter node parameters (PRD "Node A options")
 * @returns       the model, unwrapped for now (TODO: return a wrapped copy
 *                 with the tracing callback handler attached, once O1 is
 *                 resolved and the OTel/LangChain packages are bundled)
 */
export function wrapModelWithTracing(
	ctx: ISupplyDataFunctions,
	model: unknown,
	options: TraceExporterOptions,
): unknown {
	// TODO(PRD F1-F4, O1): attach an OTel-emitting callback handler here.
	// Referencing `ctx` and `options` keeps their intended usage visible at
	// the call site without triggering unused-parameter lint errors while
	// this remains a stub.
	void ctx;
	void options;
	return model;
}
