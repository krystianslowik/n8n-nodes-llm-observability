import type { ISupplyDataFunctions } from 'n8n-workflow';

import type { LlmResultLike, TracingHooks } from './callbackTypes';
import { completionTextFrom, responseDetailsFrom, toolCallsFrom } from './genAiAttributes';
import type { TraceExecutionContext } from './n8nExecutionState';
import { buildExportTarget, SpanExporter } from './otlpExport';
import type { OtlpCredential } from './otlpExport';
import type { OtlpAttrValue } from './otlpJson';
import { compileRedactor } from './redaction';
import { RunTreeTracker } from './runTreeTracker';

/**
 * Options read from the Trace Exporter node's parameters (PRD §5 "Node A
 * options"). Content capture is opt-in and every captured string passes
 * through the configured regex redactor before export.
 */
export interface TraceExporterOptions {
	traceName: string;
	sessionId: string;
	userId: string;
	/** json-type node parameters can arrive as a string or an object. */
	metadata: unknown;
	capturePrompts: boolean;
	captureToolIO: boolean;
	maxPayloadSizeKb: number;
	samplingRatePercent: number;
	redactionPatterns: string[];
	redactionFieldPaths: string[];
	environment: string;
	tags: string[];
	release: string;
	serviceName: string;
	agentName: string;
	agentVersion: string;
	promptName: string;
	promptVersion: string;
	executionMode?: string;
	parentExecutionId?: string;
	contentCaptureBlocked: boolean;
	itemIndex: number;
}

/**
 * PREPEND our handler to the model's existing callbacks without clobbering
 * whatever n8n already attached (core ModelSelector pattern). Handles the
 * three runtime shapes of `model.callbacks`: absent, plain array, or a
 * CallbackManager-like object with `addHandler`.
 *
 * Order matters — measured live: n8n's own `N8nLlmTracing` handler (always
 * first in the model's constructor callbacks) MUTATES the shared LLMResult in
 * its `handleLLMEnd` — `output.generations` is rewritten keeping only
 * `text`/`generationInfo`, dropping `message` (and with it `tool_calls` and
 * `usage_metadata`). LangChain starts handlers in array order and our
 * handlers are synchronous, so running FIRST is the only way to see the
 * intact payload. The CallbackManager shape has no prepend API — there we
 * accept append order (that shape has not been observed on supplied models).
 */
export function attachHandler(model: unknown, handler: TracingHooks): boolean {
	if (model === null || typeof model !== 'object') return false;
	const target = model as { callbacks?: unknown };
	const callbacks = target.callbacks;
	if (callbacks === undefined || callbacks === null) {
		target.callbacks = [handler];
		return true;
	}
	if (Array.isArray(callbacks)) {
		// Idempotent: if n8n ever reuses a model instance across supplyData
		// calls, re-adding the same handler would double every span. Move an
		// existing instance back to the front: a fresh step-local execution
		// handler may have been attached since the prior call, but OTLP capture
		// must still run first (before n8n mutates the provider result).
		const existingIndex = callbacks.indexOf(handler);
		if (existingIndex >= 0) {
			if (existingIndex > 0) {
				callbacks.splice(existingIndex, 1);
				callbacks.unshift(handler);
			}
			return true;
		}
		callbacks.unshift(handler);
		return true;
	}
	const manager = callbacks as { addHandler?: (h: unknown, inherit?: boolean) => void };
	if (typeof manager.addHandler === 'function') {
		manager.addHandler(handler, true);
		return true;
	}
	return false;
}

function collectBaseAttributes(
	ctx: ISupplyDataFunctions,
	options: TraceExporterOptions,
	redact: (text: string) => string,
): Record<string, OtlpAttrValue> {
	const attributes: Record<string, OtlpAttrValue> = {};
	try {
		const workflow = ctx.getWorkflow();
		if (workflow.id !== undefined) attributes['n8n.workflow.id'] = String(workflow.id);
		if (workflow.name !== undefined) attributes['n8n.workflow.name'] = String(workflow.name);
		if (typeof workflow.active === 'boolean') attributes['n8n.workflow.active'] = workflow.active;
	} catch {
		/* never break the workflow */
	}
	try {
		attributes['n8n.execution.id'] = String(ctx.getExecutionId());
	} catch {
		/* never break the workflow */
	}
	try {
		const node = ctx.getNode();
		attributes['n8n.node.name'] = node.name;
		attributes['n8n.node.type'] = node.type;
		if (node.id) attributes['n8n.node.id'] = node.id;
		if (typeof node.typeVersion === 'number') {
			attributes['n8n.node.type.version'] = node.typeVersion;
		}
	} catch {
		/* never break the workflow */
	}
	const runIndex = stableRunIndex(ctx, options.itemIndex);
	if (runIndex !== undefined) attributes['n8n.node.run.index'] = runIndex;
	if (options.traceName) attributes['n8n.trace.name'] = options.traceName;
	attributes['n8n.item.index'] = options.itemIndex;
	if (options.executionMode) attributes['n8n.execution.mode'] = options.executionMode;
	if (options.parentExecutionId) {
		attributes['n8n.execution.parent.id'] = options.parentExecutionId;
	}
	if (options.contentCaptureBlocked) attributes['n8n.content.capture.blocked'] = true;
	if (options.agentName) attributes['gen_ai.agent.name'] = redact(options.agentName).slice(0, 200);
	if (options.agentVersion) {
		attributes['gen_ai.agent.version'] = redact(options.agentVersion).slice(0, 200);
	}
	if (options.promptName)
		attributes['gen_ai.prompt.name'] = redact(options.promptName).slice(0, 200);
	if (options.promptVersion) {
		attributes['gen_ai.prompt.version'] = redact(options.promptVersion).slice(0, 200);
	}
	if (options.environment) {
		attributes['deployment.environment.name'] = options.environment;
		attributes['langfuse.environment'] = options.environment;
	}
	if (options.release) {
		attributes['langfuse.release'] = options.release;
		attributes['n8n.release'] = options.release;
	}
	const tags = Array.isArray(options.tags) ? options.tags : [];
	if (tags.length > 0) {
		attributes['langfuse.trace.tags'] = tags.map((tag) => redact(String(tag)).slice(0, 200));
		attributes.tags = tags.map((tag) => redact(String(tag)).slice(0, 200));
	}
	if (options.sessionId) {
		// Langfuse maps this generic key to its Session (docs/opentelemetry/get-started).
		attributes['session.id'] = options.sessionId;
		// OTel GenAI semconv conversation key; Opik maps it to trace thread_id (verified, spike/verify-thread-mapping.mjs).
		attributes['gen_ai.conversation.id'] = options.sessionId;
		// Opik's documented Threads key (comet-ml/opik#3578); covers Opik versions without the semconv mapping.
		attributes['thread_id'] = options.sessionId;
		// Langfuse-namespaced session key; takes precedence over `session.id` per Langfuse OTel docs.
		attributes['langfuse.session.id'] = options.sessionId;
	}
	if (options.userId) {
		// Langfuse maps this generic key to its User (docs/opentelemetry/get-started).
		attributes['user.id'] = options.userId;
		// Langfuse-namespaced user key; takes precedence over `user.id` per Langfuse OTel docs.
		attributes['langfuse.user.id'] = options.userId;
	}

	let metadata = options.metadata;
	if (typeof metadata === 'string') {
		try {
			metadata = JSON.parse(metadata);
		} catch {
			metadata = undefined;
		}
	}
	if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
		let sanitizedMetadata: Record<string, unknown> | undefined;
		try {
			// Redact the complete object while user field paths still address the
			// original metadata shape. Every flattened attribute below must come
			// from this sanitized clone, never from a raw subtree whose root has
			// changed (for example `$.user.email` -> metadata.user).
			const serialized = redact(JSON.stringify(metadata));
			attributes['n8n.metadata'] = serialized.slice(0, 4096);
			const parsed: unknown = JSON.parse(serialized);
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				sanitizedMetadata = parsed as Record<string, unknown>;
			}
		} catch {
			// Fail closed for flattened metadata. The full attribute is omitted if
			// serialization/redaction failed, and no raw values are copied below.
		}
		let entries: Array<[string, unknown]> = [];
		try {
			entries = sanitizedMetadata ? Object.entries(sanitizedMetadata).slice(0, 50) : [];
		} catch {
			entries = [];
		}
		for (const [rawKey, rawValue] of entries) {
			const key = redact(rawKey)
				.replace(/[^a-zA-Z0-9_.-]/g, '_')
				.slice(0, 100);
			if (!key) continue;
			let value: string;
			try {
				value =
					typeof rawValue === 'string' ? rawValue : (JSON.stringify(rawValue) ?? String(rawValue));
			} catch {
				try {
					value = String(rawValue);
				} catch {
					value = '[unserializable]';
				}
			}
			const sanitized = redact(value).slice(0, 500);
			attributes[`n8n.metadata.${key}`] = sanitized;
			attributes[`langfuse.trace.metadata.${key}`] = sanitized;
		}
	}
	return attributes;
}

/**
 * The parent node's run index is exposed through n8n's public workflow-data
 * proxy. Unlike `getNextRunIndex()`, it does not change when this sub-node
 * paints another input/output row in the execution UI, so it is safe to use
 * as an invocation boundary across steppable-agent model calls.
 */
function stableRunIndex(ctx: ISupplyDataFunctions, itemIndex: number): number | undefined {
	try {
		const runIndex: unknown = ctx.getWorkflowDataProxy(itemIndex).$thisRunIndex;
		return typeof runIndex === 'number' && Number.isInteger(runIndex) && runIndex >= 0
			? runIndex
			: undefined;
	} catch {
		return undefined;
	}
}

/**
 * One tracing pipeline per (execution, node): measured live in the spike,
 * n8n's AI Agent re-calls supplyData for EVERY model invocation, so a pipeline
 * must survive the close/re-open cycle between tool steps. The public,
 * execution-stable boundary available to a community sub-node is:
 *
 *   execution ID + Trace Exporter node ID + parent run index + item index
 *
 * `getNextRunIndex()` is intentionally absent: it changes when this node adds
 * execution-state rows and would split one agent invocation. A second wrap on
 * an already-open boundary is instead assigned a separate slot (parallel
 * fan-out); only a closed slot or the exact same model instance is reusable.
 *
 * A terminal model result/error finalizes immediately. Tool-only steps remain
 * reusable until their next step arrives. If no continuation arrives, an
 * `AbortSignal.timeout()` closes the pending tail after a bounded quiet
 * period. Node's timeout signal is unref'ed, so this neither blocks the
 * workflow nor keeps a short-lived process alive. Cancellation uses n8n's
 * public cancellation APIs and finalizes immediately.
 */
interface PipelineEntry {
	boundaryKey: string;
	handler: TracingHooks;
	models: Set<object>;
	finalize: (atMs?: number) => void;
	retryPendingRoot: () => void;
	markCancelled: () => void;
	flushExporter: (timeoutMs?: number) => Promise<void>;
	closeExporter: () => Promise<void>;
	getTraceContext: () => TraceExecutionContext | undefined;
	/** Set once by a step close, cleared if the next V3 step reuses the entry. */
	closedAt?: number;
	terminalAt?: number;
	quietController?: AbortController;
	terminalController?: AbortController;
	cancellationCleanup?: () => void;
}

const pipelineByExecution = new Map<string, PipelineEntry>();
const pipelineForModel = new WeakMap<object, string>();
const MAX_PIPELINES = 200;
let nextPipelineSlot = 0;

/** Long enough for normal tools, bounded so a failed tool cannot pin a trace forever. */
export const PIPELINE_QUIET_MS = 60_000;
/** Covers three 10-second HTTP attempts plus two capped Retry-After delays. */
const TERMINAL_RETRY_GRACE_MS = 95_000;
/** Small acknowledgement window: useful for short-lived workers without materially delaying workflows. */
const FINAL_EXPORT_FLUSH_MS = 250;
/** Backward-compatible test/export name from 0.1.x. */
export const PIPELINE_LINGER_MS = PIPELINE_QUIET_MS;

function pipelineBoundaryKey(
	ctx: ISupplyDataFunctions,
	options: TraceExporterOptions,
): string | undefined {
	try {
		const node = ctx.getNode();
		const nodeIdentity = node.id || node.name;
		const runIndex = stableRunIndex(ctx, options.itemIndex);
		return [
			ctx.getExecutionId(),
			nodeIdentity,
			runIndex === undefined ? 'run:unknown' : `run:${runIndex}`,
			`item:${options.itemIndex}`,
		].join('::');
	} catch {
		return undefined;
	}
}

function freshRegistryKey(boundaryKey: string): string {
	nextPipelineSlot++;
	return `${boundaryKey}::pipeline:${nextPipelineSlot}`;
}

function isModelObject(model: unknown): model is object {
	return model !== null && typeof model === 'object';
}

function entryForWrap(
	boundaryKey: string,
	model: unknown,
): { key: string; entry: PipelineEntry } | undefined {
	if (isModelObject(model)) {
		const modelKey = pipelineForModel.get(model);
		const modelEntry = modelKey ? pipelineByExecution.get(modelKey) : undefined;
		if (
			modelKey &&
			modelEntry?.boundaryKey === boundaryKey &&
			modelEntry.terminalAt === undefined
		) {
			return { key: modelKey, entry: modelEntry };
		}
	}

	let newestClosed: { key: string; entry: PipelineEntry } | undefined;
	for (const [key, entry] of pipelineByExecution) {
		if (entry.boundaryKey !== boundaryKey || entry.closedAt === undefined || entry.terminalAt) {
			continue;
		}
		if (!newestClosed || entry.closedAt > (newestClosed.entry.closedAt ?? 0)) {
			newestClosed = { key, entry };
		}
	}
	return newestClosed;
}

function hasMeaningfulStructuredValue(value: unknown): boolean {
	if (typeof value === 'string') return value.length > 0;
	if (Array.isArray(value)) return value.length > 0;
	if (value !== null && typeof value === 'object') return Object.keys(value).length > 0;
	return value !== undefined && value !== null;
}

/**
 * Empty, metadata-only ends remain ambiguous because OpenAI Responses can
 * hide a tool call from the callback payload. Concrete text, structured
 * content, or a non-tool finish reason is terminal.
 */
function isTerminalModelOutput(output: LlmResultLike): boolean {
	try {
		if (toolCallsFrom(output).length > 0) return false;
		if (completionTextFrom(output) !== undefined) return true;

		const finishReasons = responseDetailsFrom(output).finishReasons ?? [];
		if (finishReasons.some((reason) => /tool|function/i.test(reason))) return false;
		if (finishReasons.length > 0) return true;

		const generation = output.generations?.[0]?.[0] as
			| { text?: unknown; message?: { content?: unknown } }
			| undefined;
		if (!generation) return false;
		if (typeof generation.text !== 'string' && generation.text !== undefined) {
			return hasMeaningfulStructuredValue(generation.text);
		}
		const content = generation.message?.content;
		if (!hasMeaningfulStructuredValue(content)) return false;
		if (Array.isArray(content)) {
			const types = content.flatMap((part) => {
				if (part === null || typeof part !== 'object') return [];
				const type = (part as { type?: unknown }).type;
				return typeof type === 'string' ? [type] : [];
			});
			if (types.length > 0 && types.every((type) => /tool|function/i.test(type))) return false;
		}
		if (content !== null && typeof content === 'object' && !Array.isArray(content)) {
			const type = (content as { type?: unknown }).type;
			if (typeof type === 'string' && /tool|function/i.test(type)) return false;
		}
		return true;
	} catch {
		return false;
	}
}

type ExecutionHintKey =
	| 'callbackAttachFailed'
	| 'contentCaptureBlocked'
	| 'exportFailed'
	| 'exportFlushTimedOut'
	| 'exportPartiallyAccepted'
	| 'invalidRedactionFieldPath'
	| 'invalidRedactionPattern'
	| 'queueOverflow'
	| 'setupFailed';

interface ExecutionFeedback {
	ctx: ISupplyDataFunctions;
	hints: Set<ExecutionHintKey>;
	queued: boolean;
}

const feedbackByExecution = new Map<string, ExecutionFeedback>();
const hintSetByBoundary = new Map<string, Set<ExecutionHintKey>>();

function createExecutionFeedback(
	ctx: ISupplyDataFunctions,
	hints: Set<ExecutionHintKey> = new Set(),
): ExecutionFeedback {
	return { ctx, hints, queued: false };
}

function feedbackForExecution(
	ctx: ISupplyDataFunctions,
	registryKey: string | undefined,
	boundaryKey: string | undefined,
): ExecutionFeedback {
	if (!registryKey) return createExecutionFeedback(ctx);
	const existing = feedbackByExecution.get(registryKey);
	if (existing) {
		existing.ctx = ctx;
		return existing;
	}
	let hints: Set<ExecutionHintKey> | undefined;
	if (boundaryKey) {
		hints = hintSetByBoundary.get(boundaryKey);
		if (!hints) {
			if (hintSetByBoundary.size >= MAX_PIPELINES) {
				const oldest = hintSetByBoundary.keys().next().value;
				if (oldest !== undefined) hintSetByBoundary.delete(oldest);
			}
			hints = new Set();
			hintSetByBoundary.set(boundaryKey, hints);
		}
	}
	if (feedbackByExecution.size >= MAX_PIPELINES) {
		const oldest = feedbackByExecution.keys().next().value;
		if (oldest !== undefined) feedbackByExecution.delete(oldest);
	}
	const feedback = createExecutionFeedback(ctx, hints);
	feedbackByExecution.set(registryKey, feedback);
	return feedback;
}

function addExecutionHintOnce(
	feedback: ExecutionFeedback,
	key: ExecutionHintKey,
	message: string,
): void {
	if (feedback.hints.has(key)) return;
	try {
		if (typeof feedback.ctx.addExecutionHints !== 'function') return;
		feedback.ctx.addExecutionHints({ message, type: 'warning', location: 'outputPane' });
		feedback.hints.add(key);
	} catch {
		// Execution feedback is best-effort and must never affect the model.
	}
}

function traceExecutionContext(
	tracker: RunTreeTracker,
	feedback: ExecutionFeedback,
): TraceExecutionContext | undefined {
	const sampled = tracker.getSamplingDecision();
	if (sampled === undefined) return undefined;
	if (!sampled) {
		return { tracing: 'attached', sampling: 'notSampled', exportStatus: 'notSampled' };
	}
	const context = tracker.getTraceContext();
	if (!context) return undefined;
	return {
		tracing: 'attached',
		sampling: 'sampled',
		...context,
		...(feedback.queued ? { exportStatus: 'queued' as const } : {}),
	};
}

function detachHandler(model: object, handler: TracingHooks): void {
	try {
		const callbacks = (model as { callbacks?: unknown }).callbacks;
		if (Array.isArray(callbacks)) {
			for (let index = callbacks.length - 1; index >= 0; index--) {
				if (callbacks[index] === handler) callbacks.splice(index, 1);
			}
			return;
		}
		const manager = callbacks as { removeHandler?: (candidate: unknown) => void } | undefined;
		manager?.removeHandler?.(handler);
	} catch {
		/* callback cleanup is best-effort */
	}
}

function detachPipelineHandlers(registryKey: string, entry: PipelineEntry): void {
	for (const model of entry.models) {
		detachHandler(model, entry.handler);
		if (pipelineForModel.get(model) === registryKey) pipelineForModel.delete(model);
	}
}

function deletePipeline(registryKey: string, entry: PipelineEntry): void {
	if (pipelineByExecution.get(registryKey) !== entry) return;
	entry.quietController?.abort();
	entry.terminalController?.abort();
	entry.quietController = undefined;
	entry.terminalController = undefined;
	entry.cancellationCleanup?.();
	entry.cancellationCleanup = undefined;
	detachPipelineHandlers(registryKey, entry);
	pipelineByExecution.delete(registryKey);
	feedbackByExecution.delete(registryKey);
}

function scheduleTerminalCleanup(registryKey: string, entry: PipelineEntry): void {
	if (entry.terminalController) return;
	const controller = new AbortController();
	const signal = AbortSignal.any([AbortSignal.timeout(TERMINAL_RETRY_GRACE_MS), controller.signal]);
	entry.terminalController = controller;
	signal.addEventListener(
		'abort',
		() => {
			if (controller.signal.aborted || entry.terminalController !== controller) return;
			entry.terminalController = undefined;
			try {
				entry.retryPendingRoot();
			} catch {
				/* never break the workflow */
			}
			void entry.closeExporter().finally(() => deletePipeline(registryKey, entry));
		},
		{ once: true },
	);
}

function completePipeline(registryKey: string, entry: PipelineEntry, atMs: number): void {
	if (pipelineByExecution.get(registryKey) !== entry || entry.terminalAt !== undefined) return;
	entry.closedAt = undefined;
	entry.quietController?.abort();
	entry.quietController = undefined;
	entry.terminalAt = atMs;
	try {
		entry.finalize(atMs);
	} catch {
		/* never break the workflow */
	}
	void entry.flushExporter();
	// Do not mutate a callback array while LangChain may still be iterating it.
	void Promise.resolve().then(() => detachPipelineHandlers(registryKey, entry));
	scheduleTerminalCleanup(registryKey, entry);
}

function settleQuietPipeline(
	registryKey: string,
	entry: PipelineEntry,
	controller: AbortController,
): void {
	if (
		controller.signal.aborted ||
		entry.quietController !== controller ||
		entry.closedAt === undefined ||
		entry.terminalAt !== undefined
	) {
		return;
	}
	completePipeline(registryKey, entry, entry.closedAt);
}

function scheduleQuietFinalization(registryKey: string, entry: PipelineEntry): void {
	entry.quietController?.abort();
	const controller = new AbortController();
	const signal = AbortSignal.any([AbortSignal.timeout(PIPELINE_QUIET_MS), controller.signal]);
	entry.quietController = controller;
	signal.addEventListener('abort', () => settleQuietPipeline(registryKey, entry, controller), {
		once: true,
	});
}

/**
 * Synchronous backstop for tests, capacity eviction, and older runtimes.
 * Normal quiet-instance cleanup is independently scheduled by closeFunction.
 */
export function sweepStalePipelines(nowMs: number, skipKey?: string): void {
	for (const [key, entry] of pipelineByExecution) {
		if (key === skipKey) continue;
		if (entry.terminalAt !== undefined) {
			if (nowMs - entry.terminalAt <= TERMINAL_RETRY_GRACE_MS) continue;
			try {
				entry.retryPendingRoot();
			} catch {
				/* never break the workflow */
			}
			void entry.closeExporter();
			deletePipeline(key, entry);
			continue;
		}
		if (entry.closedAt === undefined || nowMs - entry.closedAt <= PIPELINE_QUIET_MS) continue;
		try {
			entry.finalize(entry.closedAt);
			entry.retryPendingRoot();
		} catch {
			/* never break the workflow */
		}
		void entry.closeExporter();
		deletePipeline(key, entry);
	}
}

/**
 * `closeFunction` is a step boundary, not necessarily an execution boundary.
 * It marks the slot reusable and starts a quiet fallback without awaiting it.
 */
function buildCloseFunction(registryKey: string, entry: PipelineEntry): () => Promise<void> {
	return async () => {
		detachPipelineHandlers(registryKey, entry);
		if (pipelineByExecution.get(registryKey) !== entry) return;
		if (entry.terminalAt !== undefined) {
			const flushDeadline = Date.now() + FINAL_EXPORT_FLUSH_MS;
			await entry.flushExporter(FINAL_EXPORT_FLUSH_MS);
			try {
				entry.retryPendingRoot();
			} catch {
				/* never break the workflow */
			}
			await entry.flushExporter(Math.max(0, flushDeadline - Date.now()));
			return;
		}
		try {
			entry.retryPendingRoot();
		} catch {
			/* never break the workflow */
		}
		if (entry.closedAt !== undefined) return;
		entry.closedAt = Date.now();
		scheduleQuietFinalization(registryKey, entry);
	};
}

function registerCancellation(
	ctx: ISupplyDataFunctions,
	registryKey: string,
	entry: PipelineEntry,
): void {
	if (entry.cancellationCleanup) return;
	const cancel = () => {
		if (pipelineByExecution.get(registryKey) !== entry || entry.terminalAt !== undefined) return;
		try {
			entry.markCancelled();
		} catch {
			/* never break the workflow */
		}
		completePipeline(registryKey, entry, Date.now());
	};
	try {
		const signal = ctx.getExecutionCancelSignal?.();
		if (signal) {
			if (signal.aborted) {
				entry.cancellationCleanup = () => {};
				cancel();
				return;
			}
			signal.addEventListener('abort', cancel, { once: true });
			entry.cancellationCleanup = () => signal.removeEventListener('abort', cancel);
			return;
		}
	} catch {
		/* fall through to the callback API */
	}
	try {
		if (typeof ctx.onExecutionCancellation === 'function') {
			// The public callback API has no unsubscribe handle. Register it once
			// per pipeline instead of once per steppable-agent model invocation.
			entry.cancellationCleanup = () => {};
			ctx.onExecutionCancellation(cancel);
		}
	} catch {
		entry.cancellationCleanup = undefined;
		/* cancellation integration is best-effort on older n8n versions */
	}
}

/** Result of {@link wrapModelWithTracing} — the model plus its eviction hook. */
export interface WrappedModel {
	model: unknown;
	closeFunction?: () => Promise<void>;
	getTraceContext?: () => TraceExecutionContext | undefined;
}

/**
 * Wraps the supplied LangChain model with the OTel tracing pipeline (spec
 * §"Wire-up"): tracker (callback hooks -> spans) -> exporter (spans -> OTLP/
 * JSON POST via ctx.helpers.httpRequest, fire-and-forget). Returns the SAME
 * model instance; on any setup failure the model passes through untraced —
 * trace loss over workflow failure, always (PRD §5 failure policy).
 */
export function wrapModelWithTracing(
	ctx: ISupplyDataFunctions,
	model: unknown,
	options: TraceExporterOptions,
	credential: OtlpCredential,
): WrappedModel {
	let feedback = createExecutionFeedback(ctx);
	try {
		const boundaryKey = pipelineBoundaryKey(ctx, options);
		sweepStalePipelines(Date.now());
		const reusable = boundaryKey ? entryForWrap(boundaryKey, model) : undefined;
		if (reusable) {
			const { key: registryKey, entry: existing } = reusable;
			feedback = feedbackForExecution(ctx, registryKey, existing.boundaryKey);
			// A later V3 step voids the prior step's quiet-close mark. An open
			// pipeline is reused only when n8n supplied the exact same model object.
			existing.closedAt = undefined;
			existing.quietController?.abort();
			existing.quietController = undefined;
			if (isModelObject(model)) pipelineForModel.set(model, registryKey);
			registerCancellation(ctx, registryKey, existing);
			if (!attachHandler(model, existing.handler)) {
				addExecutionHintOnce(
					feedback,
					'callbackAttachFailed',
					'Tracing could not attach to the supplied Chat Model. The model ran without observability. Connect a supported Chat Model directly to this node.',
				);
				try {
					ctx.logger.warn(
						'[TraceExporter] could not attach tracing callbacks to the supplied model; passing it through untraced',
					);
				} catch {
					/* never break the workflow */
				}
			} else if (isModelObject(model)) {
				existing.models.add(model);
			}
			return {
				model,
				closeFunction: buildCloseFunction(registryKey, existing),
				getTraceContext: existing.getTraceContext,
			};
		}
		const registryKey = boundaryKey ? freshRegistryKey(boundaryKey) : undefined;
		feedback = feedbackForExecution(ctx, registryKey, boundaryKey);
		if (options.contentCaptureBlocked) {
			addExecutionHintOnce(
				feedback,
				'contentCaptureBlocked',
				'n8n redaction policy disabled prompt, response, and tool content capture for this execution.',
			);
		}

		const target = buildExportTarget(credential);
		const redactor = compileRedactor(
			Array.isArray(options.redactionPatterns) ? options.redactionPatterns : [],
			{
				fieldPaths: Array.isArray(options.redactionFieldPaths) ? options.redactionFieldPaths : [],
				maxInputChars:
					(Number.isFinite(options.maxPayloadSizeKb) ? Math.max(1, options.maxPayloadSizeKb) : 32) *
					1024,
			},
		);
		if (redactor.invalidPatternCount > 0) {
			addExecutionHintOnce(
				feedback,
				'invalidRedactionPattern',
				`${redactor.invalidPatternCount} redaction pattern(s) were invalid and ignored. Fix or remove them before relying on content redaction.`,
			);
			try {
				ctx.logger.warn(
					`[TraceExporter] ignored ${redactor.invalidPatternCount} invalid redaction pattern(s)`,
				);
			} catch {
				/* never break the workflow */
			}
		}
		// `tracker` is constructed after `exporter`, but the exporter's
		// failure callback needs to call back into the tracker (Fix: root
		// re-emit on export failure). Resolve the chicken/egg with a mutable
		// box the closure reads from, filled in once the tracker exists below
		// — a box property mutates in place, so this stays lint-clean as a
		// `const` (unlike a plain forward-declared `let`).
		const trackerBox: { current?: RunTreeTracker } = {};
		const exporter = new SpanExporter(
			target,
			// `timeout` bounds each export POST: the exporter allows one batch
			// in flight at a time, so a hung backend would otherwise pin that
			// slot (and grow the bounded queue into drops) forever.
			async (url, headers, body) =>
				ctx.helpers.httpRequest({ method: 'POST', url, headers, body, json: true, timeout: 10000 }),
			{
				'service.name': options.serviceName || 'n8n',
				...(options.release ? { 'service.version': options.release } : {}),
			},
			(message) => {
				try {
					ctx.logger.warn(`[TraceExporter] ${message}`);
				} catch {
					/* never break the workflow */
				}
			},
			(spans, statusCode) => {
				trackerBox.current?.notifyExportFailed(spans, statusCode);
			},
			() => {
				addExecutionHintOnce(
					feedback,
					'queueOverflow',
					'The trace export queue is full and some spans were dropped. Check the observability backend availability and response time.',
				);
			},
		);
		const reportExporterDiagnostics = (flushed: boolean): void => {
			const diagnostics = exporter.getDiagnostics();
			if (!flushed) {
				addExecutionHintOnce(
					feedback,
					'exportFlushTimedOut',
					'Trace delivery is still running in the background after the final flush window.',
				);
			}
			if (diagnostics.partialSuccessBatches > 0 || diagnostics.rejectedSpans > 0) {
				addExecutionHintOnce(
					feedback,
					'exportPartiallyAccepted',
					`The OTLP backend rejected ${diagnostics.rejectedSpans} span(s) from this trace.`,
				);
			}
			if (diagnostics.failedSpans > 0) {
				addExecutionHintOnce(
					feedback,
					'exportFailed',
					`${diagnostics.failedSpans} trace span(s) could not be delivered after retry.`,
				);
			}
		};
		const flushExporter = async (timeoutMs = FINAL_EXPORT_FLUSH_MS): Promise<void> => {
			const flushed = await exporter.forceFlush(timeoutMs);
			reportExporterDiagnostics(flushed);
		};
		let exporterClosePromise: Promise<void> | undefined;
		const closeExporter = (): Promise<void> => {
			exporterClosePromise ??= (async () => {
				const flushed = await exporter.close(FINAL_EXPORT_FLUSH_MS);
				reportExporterDiagnostics(flushed);
			})();
			return exporterClosePromise;
		};
		const capturePrompts = options.capturePrompts && !options.contentCaptureBlocked;
		const captureToolIO = options.captureToolIO && !options.contentCaptureBlocked;
		const tracker = new RunTreeTracker(
			{
				capturePrompts,
				captureToolIO,
				// A non-numeric node option would make the budget NaN — every
				// byte comparison then fails and EVERYTHING truncates to the bare
				// marker. Fall back to the option's 32 KB default instead.
				maxPayloadBytes:
					(Number.isFinite(options.maxPayloadSizeKb) ? Math.max(1, options.maxPayloadSizeKb) : 32) *
					1024,
				samplingRatePercent: options.samplingRatePercent,
				singleTrace: true,
				rootSpanName: options.traceName || 'n8n agent execution',
				baseAttributes: collectBaseAttributes(ctx, options, redactor.redact),
				redact: redactor.redact,
			},
			(span) => {
				feedback.queued = true;
				const rootSpanId = trackerBox.current?.getTraceContext()?.rootSpanId;
				exporter.add(span, {
					isolated: span.parentSpanId === undefined && span.spanId === rootSpanId,
				});
			},
		);
		trackerBox.current = tracker;
		const trackerHandler = tracker.createHandler();
		const lifecycle: { complete?: () => void } = {};
		const handler: TracingHooks = {
			...trackerHandler,
			handleLLMEnd: (output, runId, parentRunId) => {
				trackerHandler.handleLLMEnd?.(output, runId, parentRunId);
				if (isTerminalModelOutput(output)) lifecycle.complete?.();
			},
			handleLLMError: (error, runId, parentRunId) => {
				trackerHandler.handleLLMError?.(error, runId, parentRunId);
				lifecycle.complete?.();
			},
		};
		let entry: PipelineEntry | undefined;
		if (registryKey && boundaryKey) {
			if (pipelineByExecution.size >= MAX_PIPELINES) {
				// Prefer a completed/closed slot. A live slot is the bounded-map
				// backstop only; finalize it before eviction so its root/tail survives.
				let evictKey: string | undefined;
				for (const [key, candidate] of pipelineByExecution) {
					if (candidate.terminalAt !== undefined || candidate.closedAt !== undefined) {
						evictKey = key;
						break;
					}
				}
				evictKey ??= pipelineByExecution.keys().next().value;
				if (evictKey !== undefined) {
					const evicted = pipelineByExecution.get(evictKey);
					if (evicted) {
						try {
							evicted.finalize(evicted.closedAt ?? evicted.terminalAt ?? Date.now());
							evicted.retryPendingRoot();
						} catch {
							/* never break the workflow */
						}
						void evicted.closeExporter();
						deletePipeline(evictKey, evicted);
					}
				}
			}
			if (redactor.invalidFieldPathCount > 0) {
				addExecutionHintOnce(
					feedback,
					'invalidRedactionFieldPath',
					`${redactor.invalidFieldPathCount} structured redaction path(s) were invalid and ignored.`,
				);
			}
			const registeredEntry: PipelineEntry = {
				boundaryKey,
				handler,
				models: new Set(),
				finalize: (atMs?: number) => tracker.finalize(atMs),
				retryPendingRoot: () => tracker.retryPendingRoot(),
				markCancelled: () =>
					tracker.finalizeCancelled(new Error('n8n execution cancelled'), Date.now()),
				flushExporter,
				closeExporter,
				getTraceContext: () => traceExecutionContext(tracker, feedback),
			};
			entry = registeredEntry;
			pipelineByExecution.set(registryKey, registeredEntry);
			if (isModelObject(model)) pipelineForModel.set(model, registryKey);
			lifecycle.complete = () => completePipeline(registryKey, registeredEntry, Date.now());
			registerCancellation(ctx, registryKey, registeredEntry);
		} else {
			lifecycle.complete = () => tracker.finalize(Date.now());
		}
		const attached = attachHandler(model, handler);
		if (!attached) {
			addExecutionHintOnce(
				feedback,
				'callbackAttachFailed',
				'Tracing could not attach to the supplied Chat Model. The model ran without observability. Connect a supported Chat Model directly to this node.',
			);
			try {
				ctx.logger.warn(
					'[TraceExporter] could not attach tracing callbacks to the supplied model; passing it through untraced',
				);
			} catch {
				/* never break the workflow */
			}
		} else if (entry && isModelObject(model)) {
			entry.models.add(model);
		}
		return {
			model,
			closeFunction: registryKey && entry ? buildCloseFunction(registryKey, entry) : undefined,
			getTraceContext: () => traceExecutionContext(tracker, feedback),
		};
	} catch (error) {
		addExecutionHintOnce(
			feedback,
			'setupFailed',
			'Tracing setup failed and the model ran without observability. Check the OTLP credential and Trace Exporter settings.',
		);
		try {
			ctx.logger.warn(
				`[TraceExporter] tracing setup failed, passing model through: ${String(error)}`,
			);
		} catch {
			/* never break the workflow */
		}
	}
	return { model };
}
