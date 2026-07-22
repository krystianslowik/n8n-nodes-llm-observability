import type {
	AgentActionLike,
	LlmResultLike,
	SerializedComponent,
	TracingHooks,
} from './callbackTypes';
import {
	completionValueFrom,
	genAiSystemFrom,
	modelNameFrom,
	requestDetailsFrom,
	responseDetailsFrom,
	tokenUsageFrom,
	toolCallsFrom,
} from './genAiAttributes';
import {
	generateSpanId,
	generateTraceId,
	msToNanos,
	toOtlpAttributes,
	SPAN_KIND_CLIENT,
	SPAN_KIND_INTERNAL,
	STATUS_ERROR,
} from './otlpJson';
import type { OtlpAttrValue, OtlpSpan } from './otlpJson';

export interface TrackerEvent {
	hook: string;
	runId?: string;
	parentRunId?: string;
	atMs: number;
}

export interface TrackerConfig {
	capturePrompts: boolean;
	captureToolIO: boolean;
	maxPayloadBytes: number;
	samplingRatePercent: number;
	/** n8n context + session/user/metadata, stamped on every span (PRD F3/F4). */
	baseAttributes: Record<string, OtlpAttrValue>;
	/** Sanitizes every captured string before it leaves the process. */
	redact?: (text: string) => string;
	/** Injectable clock for tests. */
	now?: () => number;
	/** Fires per hook invocation — the live run logs these lines; they ARE the capture-depth measurement. */
	onEvent?: (event: TrackerEvent) => void;
	/**
	 * Group every run without an observed parent into ONE shared trace.
	 * Measured live in the spike: n8n's AI Agent invokes the model with no
	 * LangChain parent context (parentRunId is always undefined), so without
	 * this, each LLM call of one agent execution becomes its own trace.
	 *
	 * Every parentless span is parented under one synthetic ROOT. The ROOT is
	 * emitted after the final model answer (or from `finalize` as a fallback),
	 * so its input/output and duration describe the whole execution. Verified
	 * live against Opik: child spans may arrive before their ROOT, while a
	 * second parentless span on the same trace still produces a 409.
	 */
	singleTrace?: boolean;
	/** Name of the synthetic root span (e.g. the node's Trace Name option). */
	rootSpanName?: string;
}

/** Tool call the model requested, awaiting its result in a later model call. */
interface PendingToolCall {
	id?: string;
	name?: string;
	args?: unknown;
	requestedAtMs: number;
}

/**
 * Runaway backstop for the pending-tool-call ledger: entries only leave when
 * a matching tool result arrives or `finalize` flushes, so a pathological
 * agent loop (or a mode where synthesis never drains) must not grow it
 * unbounded. Drop-oldest.
 */
const MAX_PENDING_TOOL_CALLS = 100;

/** Callback history is diagnostics, not trace state. Retain only the newest entries. */
const MAX_TRACKER_EVENTS = 256;
const MAX_DEBUG_ID_LENGTH = 160;
const MAX_UNSEEN_PARENT_CONTEXTS = 256;
const MAX_OPEN_RUNS = 512;
const MAX_SERIALIZATION_DEPTH = 8;
const MAX_SERIALIZATION_ITEMS = 1_000;
const MAX_CONTAINER_ITEMS = 200;
const MAX_SERIALIZED_STRING_CHARS = 256 * 1024;
const MAX_MESSAGE_BATCHES = 100;
const MAX_MESSAGES_PER_BATCH = 100;
const MAX_MESSAGES_TOTAL = 500;

/**
 * Root re-emission bound: the initial emit plus at most this many re-emits
 * per execution. `notifyExportFailed` stops un-latching once the bound is
 * reached, so a persistently failing root can't poison every later batch.
 */
const MAX_ROOT_RE_EMITS = 2;

interface OpenRun {
	spanId: string;
	traceId: string;
	parentSpanId?: string;
	name: string;
	kind: number;
	startMs: number;
	firstChunkMs?: number;
	sampled: boolean;
	attributes: Record<string, OtlpAttrValue | undefined>;
}

interface TraceTotals {
	llmCalls: number;
	toolCalls: number;
	errors: number;
	inputTokens?: number;
	outputTokens?: number;
	cacheReadInputTokens?: number;
	cacheCreationInputTokens?: number;
	reasoningOutputTokens?: number;
}

function emptyTraceTotals(): TraceTotals {
	return {
		llmCalls: 0,
		toolCalls: 0,
		errors: 0,
	};
}

/**
 * Same workaround as `crypto` above: `TextEncoder` is a Node (and web)
 * global with no ambient type under this tsconfig — declare the narrow
 * shape we use, module-locally, under the same lint constraints.
 */
declare const TextEncoder: new () => {
	encode(input: string): Uint8Array;
};

/** Appended to byte-truncated payloads; its UTF-8 length is reserved inside the budget. */
const TRUNCATION_MARKER = '…[truncated]';
const TRUNCATION_MARKER_BYTES = new TextEncoder().encode(TRUNCATION_MARKER).length;

/**
 * Maps LangChain runId/parentRunId callbacks onto OTLP spans (spec §"Run-tree
 * tracker"). Runs under an observed parent get real parentage; runs under an
 * unseen parent (the expected case: the agent's chain run never reaches a
 * model-attached handler) share a trace keyed on that unseen parentRunId.
 *
 * With `singleTrace` (the only mode `wrapModelWithTracing` uses), every
 * parentless/unseen-parent run in one tracker is parented under a single
 * synthetic ROOT span — one agent execution stays one trace. Children ship
 * as they finish; the ROOT ships after the final answer so it can close with
 * full trace input/output and duration. `notifyExportFailed` re-arms a
 * failed ROOT using the SAME rootSpanId, so already-exported children remain
 * correctly linked when the retry lands. A 409 re-latches instead (the
 * backend already has that parentless ROOT), and re-emission is bounded at
 * `MAX_ROOT_RE_EMITS` per execution.
 */
export class RunTreeTracker {
	readonly events: TrackerEvent[] = [];

	handlerErrors = 0;

	droppedRuns = 0;

	private readonly runs = new Map<string, OpenRun>();

	private readonly traceForUnseenParent = new Map<string, { traceId: string; sampled: boolean }>();

	private readonly pendingToolCalls: PendingToolCall[] = [];

	private sharedTrace?: {
		traceId: string;
		rootSpanId: string;
		/** First model input and final model output, present only when capture is enabled. */
		input?: string;
		output?: string;
		/** End of the final model answer (or execution-close fallback). */
		endMs?: number;
		rootEmitted: boolean;
		/** True once the root has been handed to the exporter at least once. */
		rootAttempted: boolean;
		/** Un-latches granted so far; capped at MAX_ROOT_RE_EMITS. */
		rootReEmits: number;
		sampled: boolean;
		totals: TraceTotals;
		error?: { type: string; message: string };
	};

	private readonly startedAtMs: number;

	/** Last model boundary, used to reconstruct tool timing from V3 message history. */
	private lastLlmEndMs?: number;

	constructor(
		private readonly config: TrackerConfig,
		private readonly emit: (span: OtlpSpan) => void,
	) {
		this.startedAtMs = this.now();
	}

	private now(): number {
		return this.config.now ? this.config.now() : Date.now();
	}

	private debugId(value: unknown): string | undefined {
		if (typeof value !== 'string' || value.length === 0) return undefined;
		return value.length <= MAX_DEBUG_ID_LENGTH
			? value
			: `${value.slice(0, MAX_DEBUG_ID_LENGTH - 1)}…`;
	}

	private record(hook: string, runId?: string, parentRunId?: string): void {
		const event: TrackerEvent = {
			hook,
			runId: this.debugId(runId),
			parentRunId: this.debugId(parentRunId),
			atMs: this.now(),
		};
		this.events.push(event);
		if (this.events.length > MAX_TRACKER_EVENTS) {
			this.events.splice(0, this.events.length - MAX_TRACKER_EVENTS);
		}
		try {
			this.config.onEvent?.(event);
		} catch {
			this.handlerErrors++;
		}
	}

	private decideSampled(traceId: string): boolean {
		const rate = Number.isFinite(this.config.samplingRatePercent)
			? this.config.samplingRatePercent
			: 100;
		if (rate >= 100) return true;
		if (rate <= 0) return false;
		// Ratio sampling from a uniform portion of the trace id is deterministic:
		// every component seeing this trace id reaches the same decision.
		const sample = Number.parseInt(traceId.slice(-8), 16);
		return sample < (rate / 100) * 0x1_0000_0000;
	}

	private sharedTraceContext(): { traceId: string; sampled: boolean } {
		if (!this.sharedTrace) {
			const traceId = generateTraceId();
			this.sharedTrace = {
				traceId,
				rootSpanId: generateSpanId(),
				rootEmitted: false,
				rootAttempted: false,
				rootReEmits: 0,
				sampled: this.decideSampled(traceId),
				totals: emptyTraceTotals(),
			};
		}
		return { traceId: this.sharedTrace.traceId, sampled: this.sharedTrace.sampled };
	}

	/** Public correlation IDs for n8n execution data; never creates a trace. */
	getTraceContext(): { traceId: string; rootSpanId: string } | undefined {
		if (!this.sharedTrace) return undefined;
		return {
			traceId: this.sharedTrace.traceId,
			rootSpanId: this.sharedTrace.rootSpanId,
		};
	}

	/** Sampling decision for the shared trace; undefined until the first model run starts. */
	getSamplingDecision(): boolean | undefined {
		return this.sharedTrace?.sampled;
	}

	/** Production uses singleTrace; decide before serializing opt-in content. */
	private shouldCaptureContent(): boolean {
		return !this.config.singleTrace || this.sharedTraceContext().sampled;
	}

	private sharedTotalsForRun(runId: string): TraceTotals | undefined {
		const run = this.runs.get(runId);
		const shared = this.sharedTrace;
		return run && shared && run.traceId === shared.traceId ? shared.totals : undefined;
	}

	private recordLlmTotals(
		runId: string,
		usage: ReturnType<typeof tokenUsageFrom>,
		error: boolean,
	): void {
		const totals = this.sharedTotalsForRun(runId);
		if (!totals) return;
		totals.llmCalls++;
		if (error) totals.errors++;
		if (usage.inputTokens !== undefined) {
			totals.inputTokens = (totals.inputTokens ?? 0) + usage.inputTokens;
		}
		if (usage.outputTokens !== undefined) {
			totals.outputTokens = (totals.outputTokens ?? 0) + usage.outputTokens;
		}
		if (usage.cacheReadInputTokens !== undefined) {
			totals.cacheReadInputTokens = (totals.cacheReadInputTokens ?? 0) + usage.cacheReadInputTokens;
		}
		if (usage.cacheCreationInputTokens !== undefined) {
			totals.cacheCreationInputTokens =
				(totals.cacheCreationInputTokens ?? 0) + usage.cacheCreationInputTokens;
		}
		if (usage.reasoningOutputTokens !== undefined) {
			totals.reasoningOutputTokens =
				(totals.reasoningOutputTokens ?? 0) + usage.reasoningOutputTokens;
		}
	}

	private recordToolCallForRun(runId: string): void {
		const totals = this.sharedTotalsForRun(runId);
		if (totals) totals.toolCalls++;
	}

	private recordErrorForRun(runId: string): void {
		const totals = this.sharedTotalsForRun(runId);
		if (totals) totals.errors++;
	}

	/**
	 * Emit the shared trace's synthetic root once the final model answer is
	 * known. Child spans are deliberately allowed to export first: live Opik
	 * verification proves it accepts a child referencing a not-yet-ingested
	 * parent and later attaches the ROOT cleanly. This lets the ROOT carry the
	 * execution's real first input, final output, and end time.
	 *
	 * `rootEmitted` latches optimistically — set as soon as the root is handed
	 * to the exporter, before the export outcome is known — because emission
	 * here is decoupled from the POST. If that export batch fails,
	 * `notifyExportFailed` resets the latch so this method re-emits the exact
	 * same `rootSpanId` on the next final answer, retrying the root without
	 * orphaning children that already reference it. When there is no later
	 * answer, `retryPendingRoot` from the node's `closeFunction` is the last
	 * chance. Re-emission is
	 * bounded: at most `MAX_ROOT_RE_EMITS` re-emits per execution
	 * (`notifyExportFailed` stops un-latching past that), and a 409 failure
	 * re-latches instead of retrying. Accepted residual: if every bounded
	 * attempt fails, the trace is lost.
	 */
	private emitSharedRootIfNeeded(): void {
		const shared = this.sharedTrace;
		if (!shared || shared.rootEmitted || !shared.sampled) return;
		const configuredAgentName = this.config.baseAttributes['gen_ai.agent.name'];
		const agentName =
			typeof configuredAgentName === 'string' && configuredAgentName.length > 0
				? configuredAgentName
				: (this.config.rootSpanName ?? 'n8n agent execution');
		shared.rootEmitted = true;
		shared.rootAttempted = true;
		this.emit({
			traceId: shared.traceId,
			spanId: shared.rootSpanId,
			name: this.config.rootSpanName ?? 'n8n agent execution',
			kind: SPAN_KIND_INTERNAL,
			startTimeUnixNano: msToNanos(this.startedAtMs),
			endTimeUnixNano: msToNanos(shared.endMs ?? this.now()),
			attributes: toOtlpAttributes({
				...this.config.baseAttributes,
				'gen_ai.operation.name': 'invoke_agent',
				'gen_ai.agent.name': agentName,
				'gen_ai.usage.input_tokens': shared.totals.inputTokens,
				'gen_ai.usage.output_tokens': shared.totals.outputTokens,
				'gen_ai.usage.cache_read.input_tokens': shared.totals.cacheReadInputTokens,
				'gen_ai.usage.cache_creation.input_tokens': shared.totals.cacheCreationInputTokens,
				'gen_ai.usage.reasoning.output_tokens': shared.totals.reasoningOutputTokens,
				'n8n.gen_ai.llm.call.count': shared.totals.llmCalls,
				'n8n.gen_ai.tool.call.count': shared.totals.toolCalls,
				'n8n.gen_ai.error.count': shared.totals.errors,
				'error.type': shared.error?.type,
				'langfuse.observation.type': 'agent',
				'langfuse.trace.input': shared.input,
				'langfuse.trace.output': shared.output,
				'langfuse.observation.input': shared.input,
				'langfuse.observation.output': shared.output,
				input: shared.input,
				output: shared.output,
			}),
			...(shared.error
				? {
						status: { code: STATUS_ERROR, message: shared.error.message },
						events: [
							{
								timeUnixNano: msToNanos(shared.endMs ?? this.now()),
								name: 'exception',
								attributes: toOtlpAttributes({
									'exception.type': shared.error.type,
									'exception.message': shared.error.message,
								}),
							},
						],
					}
				: {}),
		});
	}

	/**
	 * Exporter-failure callback (wired from `wrapModelWithTracing`): if the
	 * failed batch contained the shared trace's root span, un-latch
	 * `rootEmitted` so the next `closeRun` re-emits it with the SAME
	 * `rootSpanId` — see the retry-semantics note on `emitSharedRootIfNeeded`.
	 * Two exceptions keep one bad root POST from poisoning the rest of the
	 * execution: a 409 re-latches (the backend already has the trace root —
	 * e.g. a client-side timeout after server ingest — so re-emitting would
	 * 409 every later batch carrying the root), and un-latching stops after
	 * `MAX_ROOT_RE_EMITS` re-emits. A no-op when there's no shared trace, the
	 * root was never emitted, or the failed batch didn't include the root.
	 */
	notifyExportFailed(spans: Array<{ spanId: string }>, statusCode?: number): void {
		const shared = this.sharedTrace;
		if (!shared || !shared.rootEmitted) return;
		if (!spans.some((span) => span.spanId === shared.rootSpanId)) return;
		if (statusCode === 409) return;
		if (shared.rootReEmits >= MAX_ROOT_RE_EMITS) return;
		shared.rootReEmits++;
		shared.rootEmitted = false;
	}

	/**
	 * Execution-end retry for a root whose export batch failed AFTER the last
	 * `closeRun` (single LLM call, no tools: nothing else ever re-triggers
	 * `emitSharedRootIfNeeded`). Called via `finalize` — the node's
	 * `closeFunction` entry point — when n8n tears the execution down: if the
	 * root was attempted but is currently
	 * un-latched (failed), re-emit the SAME `rootSpanId`. Still subject to the
	 * overall `MAX_ROOT_RE_EMITS` bound — if the final attempt also fails, the
	 * trace is lost (accepted residual). Never throws.
	 */
	retryPendingRoot(): void {
		try {
			const shared = this.sharedTrace;
			if (!shared || !shared.rootAttempted || shared.rootEmitted) return;
			this.emitSharedRootIfNeeded();
		} catch {
			this.handlerErrors++;
		}
	}

	private traceContextFor(parentRunId?: string): {
		traceId: string;
		parentSpanId?: string;
		sampled: boolean;
	} {
		if (parentRunId) {
			const parent = this.runs.get(parentRunId);
			if (parent) {
				return {
					traceId: parent.traceId,
					parentSpanId: parent.spanId,
					sampled: parent.sampled,
				};
			}
			if (this.config.singleTrace) {
				const shared = this.sharedTraceContext();
				return { traceId: shared.traceId, sampled: shared.sampled };
			}
			let unseen = this.traceForUnseenParent.get(parentRunId);
			if (!unseen) {
				const traceId = generateTraceId();
				unseen = { traceId, sampled: this.decideSampled(traceId) };
				if (this.traceForUnseenParent.size >= MAX_UNSEEN_PARENT_CONTEXTS) {
					const oldest = this.traceForUnseenParent.keys().next().value as string | undefined;
					if (oldest !== undefined) this.traceForUnseenParent.delete(oldest);
				}
				this.traceForUnseenParent.set(parentRunId, unseen);
			}
			return { traceId: unseen.traceId, sampled: unseen.sampled };
		}
		if (this.config.singleTrace) {
			const shared = this.sharedTraceContext();
			return { traceId: shared.traceId, sampled: shared.sampled };
		}
		const traceId = generateTraceId();
		const sampled = this.decideSampled(traceId);
		return { traceId, sampled };
	}

	private openRun(
		runId: string,
		parentRunId: string | undefined,
		name: string,
		kind: number,
		attributes: Record<string, OtlpAttrValue | undefined>,
	): void {
		const context = this.traceContextFor(parentRunId);
		if (!this.runs.has(runId) && this.runs.size >= MAX_OPEN_RUNS) {
			const oldest = this.runs.keys().next().value as string | undefined;
			if (oldest !== undefined) {
				this.runs.delete(oldest);
				this.droppedRuns++;
			}
		}
		this.runs.set(runId, {
			spanId: generateSpanId(),
			traceId: context.traceId,
			parentSpanId: context.parentSpanId,
			name,
			kind,
			startMs: this.now(),
			sampled: context.sampled,
			attributes,
		});
	}

	private markFirstChunk(runId: string): boolean {
		const run = this.runs.get(runId);
		if (!run || run.firstChunkMs !== undefined) return false;
		run.attributes['gen_ai.request.stream'] = true;
		run.firstChunkMs = this.now();
		return true;
	}

	// OTel convention: status stays UNSET (omitted) on success; only
	// failures pass an explicit ERROR status.
	private closeRun(
		runId: string,
		endAttributes: Record<string, OtlpAttrValue | undefined>,
		status?: { code: number; message?: string },
		exception?: { type: string; message: string },
	): void {
		const run = this.runs.get(runId);
		if (!run) return;
		this.runs.delete(runId);
		if (!run.sampled) return;
		let parentSpanId = run.parentSpanId;
		if (this.sharedTrace && run.traceId === this.sharedTrace.traceId) {
			parentSpanId = parentSpanId ?? this.sharedTrace.rootSpanId;
		}
		const endMs = this.now();
		this.emit({
			traceId: run.traceId,
			spanId: run.spanId,
			parentSpanId,
			name: run.name,
			kind: run.kind,
			startTimeUnixNano: msToNanos(run.startMs),
			endTimeUnixNano: msToNanos(endMs),
			attributes: toOtlpAttributes({
				...this.config.baseAttributes,
				...run.attributes,
				...endAttributes,
			}),
			...(status ? { status } : {}),
			...(exception
				? {
						events: [
							{
								timeUnixNano: msToNanos(endMs),
								name: 'exception',
								attributes: toOtlpAttributes({
									'exception.type': exception.type,
									'exception.message': exception.message,
								}),
							},
						],
					}
				: {}),
		});
	}

	/**
	 * Enforces `maxPayloadBytes` in UTF-8 BYTES (what actually crosses the
	 * wire), not UTF-16 code units. The marker's own bytes are reserved
	 * inside the budget, so truncated output never exceeds the limit (a
	 * budget smaller than the marker itself floors at marker-only output).
	 * For well-formed input the cut never lands inside a surrogate pair;
	 * input already containing lone surrogates passes through as-is.
	 */
	private truncate(text: string): string {
		const max = this.config.maxPayloadBytes;
		// A UTF-16 code unit is at most 3 UTF-8 bytes (4-byte code points are
		// surrogate PAIRS — two units), so this fast path can never fit falsely.
		if (text.length * 3 <= max) return text;
		const encoder = new TextEncoder();
		if (encoder.encode(text).length <= max) return text;
		// Reserve the marker's bytes so content + marker stays within `max`.
		const budget = Math.max(0, max - TRUNCATION_MARKER_BYTES);
		// Binary search the longest prefix within the byte budget — UTF-8
		// length is monotonic in prefix length. Every code unit encodes to at
		// least 1 byte, so no prefix longer than `budget` units can fit.
		let low = 0;
		let high = Math.min(text.length, budget);
		while (low < high) {
			const mid = Math.ceil((low + high) / 2);
			if (encoder.encode(text.slice(0, mid)).length <= budget) low = mid;
			else high = mid - 1;
		}
		// Back off a trailing high surrogate so a pair is never split.
		const end =
			low > 0 && text.charCodeAt(low - 1) >= 0xd800 && text.charCodeAt(low - 1) <= 0xdbff
				? low - 1
				: low;
		return `${text.slice(0, end)}${TRUNCATION_MARKER}`;
	}

	private sanitize(text: string): string {
		let sanitized = text;
		try {
			sanitized = this.config.redact?.(text) ?? text;
		} catch {
			this.handlerErrors++;
			// Privacy rules fail closed. A broken redactor must not turn payload
			// capture into an unredacted export path.
			sanitized = '[REDACTED]';
		}
		return this.truncate(sanitized);
	}

	/**
	 * Apply field-path rules to a captured value before placing it inside an
	 * OTel message envelope. Once wrapped, a user path such as `$.user.email`
	 * would no longer address the original value. Returning parsed JSON keeps
	 * structured parts structured; a truncated or fail-closed value stays a
	 * safe string.
	 */
	private sanitizeCapturedValue(value: unknown): unknown {
		if (typeof value === 'string') return this.sanitize(value);
		const sanitized = this.sanitize(this.safeStringify(value));
		try {
			return JSON.parse(sanitized);
		} catch {
			return sanitized;
		}
	}

	private errorMessage(error: unknown): string {
		let message = 'Unknown error';
		try {
			message = String(error);
		} catch {
			/* hostile error coercion — keep the safe fallback */
		}
		return this.sanitize(message).slice(0, 500);
	}

	private exceptionDetails(error: unknown): { type: string; message: string } {
		let type = 'Error';
		try {
			if (error && typeof error === 'object') {
				const name = (error as { name?: unknown }).name;
				if (typeof name === 'string' && name.length > 0) type = name;
			}
		} catch {
			/* best-effort error classification */
		}
		return { type: this.sanitize(type).slice(0, 200), message: this.errorMessage(error) };
	}

	private boundedSerializable(
		value: unknown,
		depth: number,
		state: { remaining: number },
		seen: WeakSet<object>,
	): unknown {
		if (typeof value === 'string') {
			return value.length <= MAX_SERIALIZED_STRING_CHARS
				? value
				: `${value.slice(0, MAX_SERIALIZED_STRING_CHARS)}${TRUNCATION_MARKER}`;
		}
		if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
		if (typeof value === 'bigint') return value.toString();
		if (value === undefined) return undefined;
		if (typeof value !== 'object') return `[${typeof value}]`;
		if (depth >= MAX_SERIALIZATION_DEPTH) return '[max depth]';
		if (seen.has(value)) return '[circular]';
		if (state.remaining <= 0) return '[item limit]';
		seen.add(value);

		if (Array.isArray(value)) {
			const result: unknown[] = [];
			const limit = Math.min(value.length, MAX_CONTAINER_ITEMS, state.remaining);
			for (let index = 0; index < limit; index++) {
				state.remaining--;
				try {
					result.push(this.boundedSerializable(value[index], depth + 1, state, seen));
				} catch {
					result.push('[unreadable]');
				}
			}
			if (limit < value.length) result.push('[items truncated]');
			return result;
		}

		const result: Record<string, unknown> = {};
		const keys = Object.keys(value).slice(0, Math.min(MAX_CONTAINER_ITEMS, state.remaining));
		for (const key of keys) {
			state.remaining--;
			try {
				result[key] = this.boundedSerializable(
					(value as Record<string, unknown>)[key],
					depth + 1,
					state,
					seen,
				);
			} catch {
				result[key] = '[unreadable]';
			}
		}
		if (keys.length < Object.keys(value).length) result['[truncated]'] = true;
		return result;
	}

	private safeStringify(value: unknown): string {
		if (typeof value === 'string') return value;
		try {
			const bounded = this.boundedSerializable(
				value,
				0,
				{ remaining: MAX_SERIALIZATION_ITEMS },
				new WeakSet<object>(),
			);
			return JSON.stringify(bounded) ?? '[unserializable]';
		} catch {
			return '[unserializable]';
		}
	}

	private messageRole(message: unknown): string {
		const m = message as { _getType?: () => string; constructor?: { name?: string } } | null;
		let raw = 'unknown';
		try {
			raw = m?._getType?.() ?? m?.constructor?.name ?? 'unknown';
		} catch {
			/* role is best-effort */
		}
		switch (raw.toLowerCase()) {
			case 'human':
			case 'humanmessage':
				return 'user';
			case 'ai':
			case 'aimessage':
				return 'assistant';
			case 'tool':
			case 'toolmessage':
				return 'tool';
			case 'systemmessage':
				return 'system';
			default:
				return raw.toLowerCase();
		}
	}

	private boundedMessages(messages: unknown[]): unknown[] {
		const result: unknown[] = [];
		const batchLimit = Math.min(messages.length, MAX_MESSAGE_BATCHES);
		for (let batchIndex = 0; batchIndex < batchLimit; batchIndex++) {
			if (!(batchIndex in messages)) continue;
			let batchOrMessage: unknown;
			try {
				batchOrMessage = messages[batchIndex];
			} catch {
				this.handlerErrors++;
				continue;
			}
			if (!Array.isArray(batchOrMessage)) {
				result.push(batchOrMessage);
				if (result.length >= MAX_MESSAGES_TOTAL) break;
				continue;
			}
			const messageLimit = Math.min(
				batchOrMessage.length,
				MAX_MESSAGES_PER_BATCH,
				MAX_MESSAGES_TOTAL - result.length,
			);
			for (let messageIndex = 0; messageIndex < messageLimit; messageIndex++) {
				if (!(messageIndex in batchOrMessage)) continue;
				try {
					result.push(batchOrMessage[messageIndex]);
				} catch {
					this.handlerErrors++;
				}
			}
			if (result.length >= MAX_MESSAGES_TOTAL) break;
		}
		return result;
	}

	/**
	 * LangChain chat messages are class instances (sometimes with circular
	 * refs); bare JSON.stringify degrades to "[object Object]". Convert them to
	 * the current OTel `gen_ai.input.messages` role/parts schema instead.
	 */
	private serializeMessages(messages: unknown): string {
		if (!Array.isArray(messages)) return this.safeStringify(messages);
		const simplified = this.boundedMessages(messages).map((message) => {
			const m = message as {
				content?: unknown;
				tool_call_id?: unknown;
				tool_calls?: Array<{ id?: unknown; name?: unknown; args?: unknown }>;
			} | null;
			const role = this.messageRole(message);
			const parts: Array<Record<string, unknown>> = [];
			const content = m?.content;
			if (role === 'tool') {
				parts.push({
					type: 'tool_call_response',
					...(typeof m?.tool_call_id === 'string' && m.tool_call_id.length > 0
						? { id: m.tool_call_id }
						: {}),
					response: this.sanitizeCapturedValue(content),
				});
			} else if (content !== undefined && content !== '') {
				parts.push({
					type: 'text',
					content:
						typeof content === 'string'
							? this.sanitize(content)
							: this.sanitize(this.safeStringify(content)),
				});
			}
			if (this.config.captureToolIO && Array.isArray(m?.tool_calls)) {
				for (const call of m.tool_calls.slice(0, MAX_PENDING_TOOL_CALLS)) {
					parts.push({
						type: 'tool_call',
						...(typeof call.id === 'string' ? { id: call.id } : {}),
						...(typeof call.name === 'string' ? { name: call.name } : {}),
						arguments: this.sanitizeCapturedValue(call.args),
					});
				}
			}
			return { role, parts };
		});
		return this.safeStringify(simplified);
	}

	private serializeOutputMessages(
		completion: unknown,
		toolCalls: Array<{ id?: string; name?: string; args?: unknown }>,
		finishReason: string,
	): string | undefined {
		const parts: Array<Record<string, unknown>> = [];
		if (typeof completion === 'string' && completion.length > 0) {
			parts.push({ type: 'text', content: this.sanitize(completion) });
		} else if (completion !== undefined && completion !== null) {
			parts.push({ type: 'json', content: this.sanitizeCapturedValue(completion) });
		}
		if (this.config.captureToolIO) {
			for (const call of toolCalls) {
				parts.push({
					type: 'tool_call',
					...(typeof call.id === 'string' ? { id: call.id } : {}),
					...(typeof call.name === 'string' ? { name: call.name } : {}),
					arguments: this.sanitizeCapturedValue(call.args),
				});
			}
		}
		return parts.length > 0
			? this.safeStringify([{ role: 'assistant', parts, finish_reason: finishReason }])
			: undefined;
	}

	private componentName(component?: SerializedComponent | null): string {
		const id = component?.id;
		if (Array.isArray(id) && id.length > 0) return String(id[id.length - 1]);
		return 'unknown';
	}

	private openLlmRun(
		llm: SerializedComponent | null,
		promptText: string | undefined,
		runId: string,
		parentRunId?: string,
		extraParams?: Record<string, unknown>,
	): void {
		const serialized = llm ?? undefined;
		const model = modelNameFrom(serialized, extraParams);
		const request = requestDetailsFrom(serialized, extraParams);
		const invocationParams = extraParams?.invocation_params as Record<string, unknown> | undefined;
		const numberParam = (...names: string[]): number | undefined => {
			const name = names.find((candidate) => invocationParams?.[candidate] !== undefined);
			const value = name ? invocationParams?.[name] : undefined;
			return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
		};
		const stop = invocationParams?.stop;
		const stopSequences = Array.isArray(stop)
			? (Array.prototype.slice.call(stop, 0, MAX_CONTAINER_ITEMS) as unknown[]).filter(
					(entry): entry is string => typeof entry === 'string',
				)
			: typeof stop === 'string'
				? [stop]
				: undefined;
		const capturedInput =
			this.config.capturePrompts && promptText !== undefined
				? this.sanitize(promptText)
				: undefined;
		this.openRun(
			runId,
			parentRunId,
			`chat ${model ?? this.componentName(serialized)}`,
			SPAN_KIND_CLIENT,
			{
				'gen_ai.provider.name': genAiSystemFrom(serialized),
				// Deprecated OTel key retained for backends that have not migrated.
				'gen_ai.system': genAiSystemFrom(serialized),
				'gen_ai.operation.name': 'chat',
				'gen_ai.request.model': model,
				'gen_ai.request.temperature': numberParam('temperature'),
				'gen_ai.request.max_tokens': numberParam('max_tokens', 'maxTokens'),
				'gen_ai.request.choice.count': request.choiceCount,
				'gen_ai.request.top_p': numberParam('top_p', 'topP'),
				'gen_ai.request.top_k': request.topK,
				'gen_ai.request.seed': request.seed,
				'gen_ai.request.stream': request.stream,
				'gen_ai.request.reasoning.level': request.reasoningLevel,
				'gen_ai.output.type': request.outputType,
				'gen_ai.request.frequency_penalty': numberParam('frequency_penalty', 'frequencyPenalty'),
				'gen_ai.request.presence_penalty': numberParam('presence_penalty', 'presencePenalty'),
				'gen_ai.request.stop_sequences': stopSequences,
				'gen_ai.input.messages': capturedInput,
				'langfuse.observation.type': 'generation',
				'langfuse.observation.input': capturedInput,
			},
		);
		if (this.config.singleTrace && capturedInput !== undefined) {
			this.sharedTraceContext();
			if (this.sharedTrace && this.sharedTrace.input === undefined) {
				this.sharedTrace.input = capturedInput;
			}
		}
	}

	private closeLlmRun(output: LlmResultLike | null, runId: string): void {
		const openRun = this.runs.get(runId);
		if (!openRun) return;
		if (!openRun.sampled) {
			this.lastLlmEndMs = this.now();
			this.closeRun(runId, {});
			return;
		}
		const result = output ?? {};
		const usage = tokenUsageFrom(result);
		const response = responseDetailsFrom(result);
		const completion = completionValueFrom(result);
		const captureContent = true;
		// Tool executions never reach a model-attached handler (measured live),
		// but the model's own response names the tools it decided to call.
		// Extracted UNCONDITIONALLY: the pending ledger drives tool-span
		// synthesis; content fields in output messages stay gated by the node's
		// capture options.
		const toolCalls = toolCallsFrom(result);
		const endedAtMs = this.now();
		this.lastLlmEndMs = endedAtMs;
		// Only KNOWN runs may ledger tool calls: a stray handleLLMEnd for a run
		// this tracker never opened must not seed phantom tool spans at finalize.
		if (this.runs.has(runId) && toolCalls.length > 0) {
			const requestedAtMs = endedAtMs;
			// Push at most the NEWEST ledger-cap's worth, then drain overflow in
			// ONE splice — a shift()-per-entry loop is O(N²) and measurably
			// blocks the event loop on giant malformed payloads.
			for (const call of toolCalls.slice(-MAX_PENDING_TOOL_CALLS)) {
				this.pendingToolCalls.push({
					id: call.id,
					name: call.name,
					// Off means off for retention too: never pin argument graphs
					// the export path would not read.
					args: this.config.captureToolIO && captureContent ? call.args : undefined,
					requestedAtMs,
				});
			}
			const excess = this.pendingToolCalls.length - MAX_PENDING_TOOL_CALLS;
			if (excess > 0) this.pendingToolCalls.splice(0, excess);
		}
		const serializedOutput = captureContent
			? this.serializeOutputMessages(
					this.config.capturePrompts ? completion : undefined,
					toolCalls,
					response.finishReasons?.[0] ?? 'unknown',
				)
			: undefined;
		const timeToFirstChunk =
			openRun?.firstChunkMs !== undefined
				? Math.max(0, openRun.firstChunkMs - openRun.startMs) / 1000
				: undefined;
		this.recordLlmTotals(runId, usage, false);
		this.closeRun(runId, {
			'gen_ai.response.id': response.id,
			'gen_ai.response.model': response.model,
			'gen_ai.response.finish_reasons': response.finishReasons,
			'gen_ai.usage.input_tokens': usage.inputTokens,
			'gen_ai.usage.output_tokens': usage.outputTokens,
			'gen_ai.usage.cache_read.input_tokens': usage.cacheReadInputTokens,
			'gen_ai.usage.cache_creation.input_tokens': usage.cacheCreationInputTokens,
			'gen_ai.usage.reasoning.output_tokens': usage.reasoningOutputTokens,
			'gen_ai.response.time_to_first_chunk': timeToFirstChunk,
			'gen_ai.output.messages':
				serializedOutput === undefined ? undefined : this.sanitize(serializedOutput),
			'langfuse.observation.output':
				serializedOutput === undefined ? undefined : this.sanitize(serializedOutput),
		});
		// A concrete text or structured answer with no requested tools is the successful end
		// of the normal V3 agent loop. Tool-only responses have empty text, so a
		// provider payload that hides tool_calls cannot close the ROOT too early.
		if (this.config.singleTrace && toolCalls.length === 0 && completion !== undefined) {
			this.sharedTraceContext();
			if (this.sharedTrace) {
				this.sharedTrace.endMs = endedAtMs;
				this.sharedTrace.output =
					this.config.capturePrompts && captureContent
						? this.sanitize(
								typeof completion === 'string' ? completion : this.safeStringify(completion),
							)
						: undefined;
			}
			this.emitSharedRootIfNeeded();
		}
	}

	private closeLlmError(error: unknown, runId: string): void {
		const endedAtMs = this.now();
		const openRun = this.runs.get(runId);
		if (!openRun) return;
		if (!openRun.sampled) {
			this.closeRun(runId, {});
			return;
		}
		const exception = this.exceptionDetails(error);
		this.recordLlmTotals(runId, {}, true);
		this.closeRun(
			runId,
			{ 'error.type': exception.type },
			{ code: STATUS_ERROR, message: exception.message },
			exception,
		);
		if (!this.config.singleTrace) return;
		this.sharedTraceContext();
		if (this.sharedTrace) {
			this.sharedTrace.endMs = endedAtMs;
			this.sharedTrace.error = exception;
		}
		this.emitSharedRootIfNeeded();
	}

	/**
	 * Model-side tool-span synthesis, chat models only (plain `handleLLMStart`
	 * prompts carry no tool messages). Tool executions never reach a
	 * model-attached handler, but their data passes the model seat twice:
	 * `handleLLMEnd` usually names the requested calls (ledgered in
	 * `closeLlmRun`), and the NEXT chat-model start echoes each tool RESULT as
	 * a ToolMessage-like entry (`tool_call_id` + `content`). On n8n's current
	 * OpenAI Responses path, however, the end callback omits tool_calls; V3
	 * still adds an assistant message shaped `Calling <name> with input: <JSON>`
	 * immediately before the tool result. That measured fallback is parsed and
	 * de-duplicated against the provider-side ledger here.
	 *
	 * Timing caveat: start/end are reconstructed from the surrounding LLM-call
	 * boundaries (previous `handleLLMEnd` -> this `handleChatModelStart`), so
	 * the span includes n8n framework overhead, not pure tool runtime.
	 */
	private pendingToolById(callId: string, calls: PendingToolCall[]): PendingToolCall | undefined {
		const index = calls.findIndex(
			(pending) => typeof pending.id === 'string' && pending.id.length > 0 && pending.id === callId,
		);
		if (index === -1) return undefined;
		const [pending] = calls.splice(index, 1);
		return pending;
	}

	private n8nToolCallSummary(content: unknown): PendingToolCall | undefined {
		if (typeof content !== 'string' || !content.startsWith('Calling ')) return undefined;
		const separator = ' with input: ';
		const separatorAt = content.indexOf(separator, 'Calling '.length);
		if (separatorAt === -1) return undefined;
		const name = content.slice('Calling '.length, separatorAt).trim();
		if (!name) return undefined;

		const rawArgs = content.slice(separatorAt + separator.length);
		let parsedArgs: unknown = rawArgs;
		try {
			parsedArgs = JSON.parse(rawArgs);
		} catch {
			/* retain the raw string */
		}
		const parsedRecord =
			parsedArgs !== null && typeof parsedArgs === 'object'
				? (parsedArgs as Record<string, unknown>)
				: undefined;
		const callId = typeof parsedRecord?.id === 'string' ? parsedRecord.id : undefined;
		let toolArgs = parsedArgs;
		if (callId !== undefined && parsedRecord) {
			// n8n V3 adds the provider call ID to its display envelope. It is
			// correlation metadata, not an argument the tool received.
			toolArgs = { ...parsedRecord, id: undefined };
		}
		return {
			id: callId,
			name,
			args: this.config.captureToolIO ? toolArgs : undefined,
			requestedAtMs: this.lastLlmEndMs ?? this.now(),
		};
	}

	private synthesizeToolSpansFrom(messages: unknown): void {
		if (!this.config.singleTrace || !Array.isArray(messages)) return;
		const callsFromMessages: PendingToolCall[] = [];
		for (const message of this.boundedMessages(messages)) {
			// Per-message guard: a hostile property getter on one message must
			// not abort the loop (or the caller's subsequent openLlmRun).
			try {
				const m = message as {
					content?: unknown;
					tool_call_id?: unknown;
					_getType?: () => string;
				} | null;
				if (m === null || typeof m !== 'object') continue;

				if (this.messageRole(m) === 'assistant') {
					const fromSummary = this.n8nToolCallSummary(m.content);
					if (fromSummary) {
						const ledgered = fromSummary.id
							? this.pendingToolById(fromSummary.id, this.pendingToolCalls)
							: undefined;
						callsFromMessages.push(ledgered ?? fromSummary);
						continue;
					}
				}

				let isToolResult = typeof m.tool_call_id === 'string';
				if (!isToolResult) {
					isToolResult = this.messageRole(m) === 'tool';
				}
				if (!isToolResult) continue;
				// Empty-string ids count as absent on BOTH sides of the match —
				// two id-less concurrent calls must not cross-match.
				const callId =
					typeof m.tool_call_id === 'string' && m.tool_call_id.length > 0
						? m.tool_call_id
						: undefined;
				const pending = callId
					? (this.pendingToolById(callId, callsFromMessages) ??
						this.pendingToolById(callId, this.pendingToolCalls))
					: callsFromMessages.shift();
				if (!pending) continue;
				this.emitSynthesizedToolSpan(pending, { resultObserved: true, output: m.content });
			} catch {
				this.handlerErrors++;
			}
		}
	}

	/**
	 * Synthesized `execute_tool <name>` span (provenance and timing caveat on
	 * `synthesizeToolSpansFrom`). Only meaningful in singleTrace mode — the
	 * only mode `wrapModelWithTracing` uses — where it parents under the
	 * shared synthetic root. Status stays UNSET: tool success/failure is not
	 * observable from the model seat.
	 */
	private emitSynthesizedToolSpan(
		pending: PendingToolCall,
		result: {
			resultObserved: boolean;
			output?: unknown;
			endMs?: number;
			error?: { type: string; message: string };
		},
	): void {
		if (!this.config.singleTrace) return;
		const context = this.sharedTraceContext();
		if (!context.sampled) return;
		const shared = this.sharedTrace;
		if (!shared) return;
		shared.totals.toolCalls++;
		if (result.error) shared.totals.errors++;
		// Extraction is unvalidated — a malformed payload can put non-strings
		// where ids/names belong; only emit them when they really are strings.
		const toolName = typeof pending.name === 'string' ? pending.name : undefined;
		const toolCallId = typeof pending.id === 'string' ? pending.id : undefined;
		const endMs = result.endMs ?? this.now();
		this.emit({
			traceId: shared.traceId,
			spanId: generateSpanId(),
			parentSpanId: shared.rootSpanId,
			name: `execute_tool ${toolName ?? 'unknown'}`,
			kind: SPAN_KIND_INTERNAL,
			startTimeUnixNano: msToNanos(pending.requestedAtMs),
			endTimeUnixNano: msToNanos(endMs),
			attributes: toOtlpAttributes({
				...this.config.baseAttributes,
				'langfuse.observation.type': 'tool',
				'gen_ai.operation.name': 'execute_tool',
				'gen_ai.tool.name': toolName,
				'gen_ai.tool.type': 'function',
				'gen_ai.tool.call.id': toolCallId,
				// Opik currently maps the standard GenAI tool I/O but does not use
				// it to set SpanType.tool. Its LiveKit name rule does. This single
				// compatibility marker makes the span first-class in Opik while the
				// standard gen_ai.* attributes remain the source of truth.
				'lk.function_tool.name': toolName,
				'n8n.span.synthesized': true,
				'n8n.span.timing_source': 'inferred',
				'n8n.tool.result_observed': result.resultObserved ? undefined : false,
				'error.type': result.error?.type,
				'gen_ai.tool.call.arguments':
					this.config.captureToolIO && pending.args !== undefined
						? this.sanitize(this.safeStringify(pending.args))
						: undefined,
				'gen_ai.tool.call.result':
					this.config.captureToolIO && result.resultObserved
						? this.sanitize(this.safeStringify(result.output))
						: undefined,
			}),
			...(result.error
				? {
						status: { code: STATUS_ERROR, message: result.error.message },
						events: [
							{
								timeUnixNano: msToNanos(endMs),
								name: 'exception',
								attributes: toOtlpAttributes({
									'exception.type': result.error.type,
									'exception.message': result.error.message,
								}),
							},
						],
					}
				: {}),
		});
	}

	/**
	 * Finalize an execution that n8n explicitly cancelled. Active runs and
	 * pending inferred tools close first, so the synthetic root is emitted last
	 * with complete call/error/token totals. Idempotent and never throws.
	 */
	finalizeCancelled(reason?: unknown, atMs?: number): void {
		const sharedContext = this.config.singleTrace ? this.sharedTraceContext() : undefined;
		const cancellation =
			sharedContext?.sampled === false
				? { type: 'CancelledError', message: 'Execution cancelled' }
				: reason === undefined
					? { type: 'CancelledError', message: 'Execution cancelled' }
					: this.exceptionDetails(reason);
		if (cancellation.type === 'Error') cancellation.type = 'CancelledError';

		for (const runId of [...this.runs.keys()]) {
			try {
				const operation = this.runs.get(runId)?.attributes['gen_ai.operation.name'];
				if (operation === 'chat') this.recordLlmTotals(runId, {}, true);
				else this.recordErrorForRun(runId);
				this.closeRun(
					runId,
					{ 'error.type': cancellation.type },
					{ code: STATUS_ERROR, message: cancellation.message },
					cancellation,
				);
			} catch {
				this.handlerErrors++;
			}
		}

		const pending = this.pendingToolCalls.splice(0, this.pendingToolCalls.length);
		for (const entry of pending) {
			try {
				this.emitSynthesizedToolSpan(entry, {
					resultObserved: false,
					endMs: atMs,
					error: cancellation,
				});
			} catch {
				this.handlerErrors++;
			}
		}

		try {
			const shared = this.sharedTrace;
			if (shared) {
				shared.endMs = atMs ?? this.now();
				shared.error = cancellation;
				shared.output = undefined;
				if (shared.totals.errors === 0) shared.totals.errors = 1;
				this.emitSharedRootIfNeeded();
			}
		} catch {
			this.handlerErrors++;
		}
		this.retryPendingRoot();
	}

	/**
	 * Execution-end flush — wired by `wrapModelWithTracing`, which invokes it
	 * from its registry sweep once an execution has stayed closed past the
	 * linger window (n8n's steppable Tools Agent fires `closeFunction` after
	 * EVERY agent step, so the close itself is not proof the execution ended
	 * — see `buildCloseFunction`). (a) Still-pending tool calls are flushed as
	 * synthesized spans with `n8n.tool.result_observed: false` and no output:
	 * the model requested the tool but no later model call carried its result
	 * (typically an error mid-tool). `atMs` — the time of the last observed
	 * close — anchors their end time, since the sweep may run long after the
	 * execution finished. (b) `retryPendingRoot` runs for a root whose export
	 * batch failed after the last closeRun. Never throws.
	 */
	finalize(atMs?: number): void {
		try {
			if (this.config.singleTrace) {
				const pending = this.pendingToolCalls.splice(0, this.pendingToolCalls.length);
				for (const entry of pending) {
					this.emitSynthesizedToolSpan(entry, { resultObserved: false, endMs: atMs });
				}
				if (this.sharedTrace && !this.sharedTrace.rootAttempted) {
					this.sharedTrace.endMs = atMs ?? this.now();
					this.emitSharedRootIfNeeded();
				}
			}
		} catch {
			this.handlerErrors++;
		}
		this.retryPendingRoot();
	}

	/** Wraps every hook: record the event first, then do the work, swallow everything. */
	private guarded<Args extends unknown[]>(
		hook: string,
		pickIds: (args: Args) => { runId?: string; parentRunId?: string },
		work: (...args: Args) => void,
	): (...args: Args) => void {
		return (...args: Args) => {
			try {
				const ids = pickIds(args);
				this.record(hook, ids.runId, ids.parentRunId);
				work(...args);
			} catch {
				this.handlerErrors++;
			}
		};
	}

	createHandler(): TracingHooks {
		return {
			name: 'n8nTraceExporterOtel',
			handleChatModelStart: this.guarded(
				'handleChatModelStart',
				(args) => ({ runId: args[2] as string, parentRunId: args[3] as string | undefined }),
				(llm, messages, runId, parentRunId, extraParams) => {
					// Before opening the new LLM run: the incoming messages carry the
					// RESULTS of tools the previous model call requested. Guarded on
					// its own so even a wholesale synthesis failure (hostile messages
					// container) still lets the LLM run open below.
					try {
						this.synthesizeToolSpansFrom(messages);
					} catch {
						this.handlerErrors++;
					}
					const promptText =
						this.config.capturePrompts && this.shouldCaptureContent()
							? this.serializeMessages(messages)
							: undefined;
					this.openLlmRun(llm, promptText, runId, parentRunId, extraParams);
				},
			),
			handleLLMStart: this.guarded(
				'handleLLMStart',
				(args) => ({ runId: args[2] as string, parentRunId: args[3] as string | undefined }),
				(llm, prompts, runId, parentRunId, extraParams) => {
					const promptText =
						this.config.capturePrompts && this.shouldCaptureContent() && Array.isArray(prompts)
							? Array.prototype.slice.call(prompts, 0, MAX_MESSAGES_TOTAL).join('\n\n')
							: undefined;
					this.openLlmRun(llm, promptText, runId, parentRunId, extraParams);
				},
			),
			handleLLMNewToken: (_token, _indices, runId, parentRunId) => {
				try {
					if (!this.markFirstChunk(runId)) return;
					this.record('handleLLMNewToken', runId, parentRunId);
				} catch {
					this.handlerErrors++;
				}
			},
			handleLLMEnd: this.guarded(
				'handleLLMEnd',
				(args) => ({ runId: args[1] as string, parentRunId: args[2] as string | undefined }),
				(output, runId) => this.closeLlmRun(output, runId),
			),
			handleLLMError: this.guarded(
				'handleLLMError',
				(args) => ({ runId: args[1] as string, parentRunId: args[2] as string | undefined }),
				(error, runId) => this.closeLlmError(error, runId),
			),
			handleChainStart: this.guarded(
				'handleChainStart',
				(args) => ({ runId: args[2] as string, parentRunId: args[3] as string | undefined }),
				(chain, _inputs, runId, parentRunId) =>
					this.openRun(
						runId,
						parentRunId,
						`chain:${this.componentName(chain)}`,
						SPAN_KIND_INTERNAL,
						{ 'langfuse.observation.type': 'chain' },
					),
			),
			handleChainEnd: this.guarded(
				'handleChainEnd',
				(args) => ({ runId: args[1] as string, parentRunId: args[2] as string | undefined }),
				(_outputs, runId) => this.closeRun(runId, {}),
			),
			handleChainError: this.guarded(
				'handleChainError',
				(args) => ({ runId: args[1] as string, parentRunId: args[2] as string | undefined }),
				(error, runId) => {
					if (this.runs.get(runId)?.sampled === false) {
						this.closeRun(runId, {});
						return;
					}
					const exception = this.exceptionDetails(error);
					this.recordErrorForRun(runId);
					this.closeRun(
						runId,
						{ 'error.type': exception.type },
						{ code: STATUS_ERROR, message: exception.message },
						exception,
					);
				},
			),
			handleToolStart: this.guarded(
				'handleToolStart',
				(args) => ({ runId: args[2] as string, parentRunId: args[3] as string | undefined }),
				(tool, input, runId, parentRunId) => {
					const toolName = this.componentName(tool);
					this.openRun(runId, parentRunId, `execute_tool ${toolName}`, SPAN_KIND_INTERNAL, {
						'langfuse.observation.type': 'tool',
						'gen_ai.operation.name': 'execute_tool',
						'gen_ai.tool.name': toolName,
						'gen_ai.tool.type': 'function',
						'lk.function_tool.name': toolName,
						'gen_ai.tool.call.arguments':
							this.config.captureToolIO && this.shouldCaptureContent()
								? this.sanitize(this.safeStringify(input))
								: undefined,
					});
					this.recordToolCallForRun(runId);
				},
			),
			handleToolEnd: this.guarded(
				'handleToolEnd',
				(args) => ({ runId: args[1] as string, parentRunId: args[2] as string | undefined }),
				(output, runId) =>
					this.closeRun(runId, {
						'gen_ai.tool.call.result':
							this.config.captureToolIO && this.runs.get(runId)?.sampled
								? this.sanitize(this.safeStringify(output))
								: undefined,
					}),
			),
			handleToolError: this.guarded(
				'handleToolError',
				(args) => ({ runId: args[1] as string, parentRunId: args[2] as string | undefined }),
				(error, runId) => {
					if (this.runs.get(runId)?.sampled === false) {
						this.closeRun(runId, {});
						return;
					}
					const exception = this.exceptionDetails(error);
					this.recordErrorForRun(runId);
					this.closeRun(
						runId,
						{ 'error.type': exception.type },
						{ code: STATUS_ERROR, message: exception.message },
						exception,
					);
				},
			),
			handleAgentAction: this.guarded<[AgentActionLike, string, string | undefined]>(
				'handleAgentAction',
				(args) => ({ runId: args[1], parentRunId: args[2] }),
				() => {
					/* observation only — recorded via `record`, no span */
				},
			),
		};
	}
}
