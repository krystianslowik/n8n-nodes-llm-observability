import type {
	AgentActionLike,
	LlmResultLike,
	SerializedComponent,
	TracingHooks,
} from './callbackTypes';
import {
	completionTextFrom,
	genAiSystemFrom,
	modelNameFrom,
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
	 * A synthetic ROOT span is emitted before the trace's first real span and
	 * every parentless span is parented under it. Also measured live: Opik's
	 * OTLP intake creates a trace per parentless span and answers 409 "Trace
	 * already exists" for later batches with another parentless span on the
	 * same traceId — child spans, by contrast, append cleanly.
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
	attributes: Record<string, OtlpAttrValue | undefined>;
}

/**
 * Same constraint `otlpJson.ts` already solved: the project's tsconfig omits
 * the "dom" lib and n8n's lint bans referencing `globalThis` outright.
 * Declaring the narrow shape we actually use lets us call the same runtime
 * global (Node 19+ attaches `crypto` directly to the global object) via a
 * plain identifier, module-locally, without `any` or widening the lib.
 */
declare const crypto: {
	getRandomValues<T extends Uint8Array>(array: T): T;
};

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
 * synthetic ROOT span, emitted once before the trace's first real span (see
 * `emitSharedRootIfNeeded`) — one agent execution stays one trace. That root
 * ships as its own solo export batch, the coldest request against the
 * backend: if it fails, every child span already sent (or about to be sent)
 * references a parentSpanId the backend never received. `notifyExportFailed`
 * closes that gap — when the exporter reports a failed batch containing the
 * root, the tracker re-arms emission so the next `closeRun` re-emits the
 * SAME root spanId; children that already referenced it become valid once
 * it lands. A 409 failure re-latches instead of re-arming — it proves the
 * backend already ingested the root (Opik answers 409 for a second
 * parentless span on a known traceId — see `singleTrace` doc above
 * `TrackerConfig`) — and re-emission is bounded at `MAX_ROOT_RE_EMITS` per
 * execution.
 */
export class RunTreeTracker {
	readonly events: TrackerEvent[] = [];

	handlerErrors = 0;

	private readonly runs = new Map<string, OpenRun>();

	private readonly traceForUnseenParent = new Map<string, { traceId: string; sampled: boolean }>();

	private readonly pendingToolCalls: PendingToolCall[] = [];

	private readonly sampledByTraceId = new Map<string, boolean>();

	private sharedTrace?: {
		traceId: string;
		rootSpanId: string;
		rootEmitted: boolean;
		/** True once the root has been handed to the exporter at least once. */
		rootAttempted: boolean;
		/** Un-latches granted so far; capped at MAX_ROOT_RE_EMITS. */
		rootReEmits: number;
		sampled: boolean;
	};

	private readonly startedAtMs: number;

	constructor(
		private readonly config: TrackerConfig,
		private readonly emit: (span: OtlpSpan) => void,
	) {
		this.startedAtMs = this.now();
	}

	private now(): number {
		return this.config.now ? this.config.now() : Date.now();
	}

	private record(hook: string, runId?: string, parentRunId?: string): void {
		const event: TrackerEvent = { hook, runId, parentRunId, atMs: this.now() };
		this.events.push(event);
		try {
			this.config.onEvent?.(event);
		} catch {
			this.handlerErrors++;
		}
	}

	private decideSampled(): boolean {
		const rate = this.config.samplingRatePercent;
		if (rate >= 100) return true;
		if (rate <= 0) return false;
		const byte = new Uint8Array(1);
		crypto.getRandomValues(byte);
		return byte[0] < (rate / 100) * 256;
	}

	private sharedTraceContext(): { traceId: string; sampled: boolean } {
		if (!this.sharedTrace) {
			this.sharedTrace = {
				traceId: generateTraceId(),
				rootSpanId: generateSpanId(),
				rootEmitted: false,
				rootAttempted: false,
				rootReEmits: 0,
				sampled: this.decideSampled(),
			};
			this.sampledByTraceId.set(this.sharedTrace.traceId, this.sharedTrace.sampled);
		}
		return { traceId: this.sharedTrace.traceId, sampled: this.sharedTrace.sampled };
	}

	/**
	 * Emit the shared trace's synthetic root before its first real span, so
	 * the backend's trace entity is created exactly once (Opik 409 semantics —
	 * see `singleTrace` doc). Children appended in later batches may end after
	 * this root's recorded end time; that approximation is a known spike
	 * trade-off (no timers, no end-of-execution hook to close the root with).
	 *
	 * `rootEmitted` latches optimistically — set as soon as the root is handed
	 * to the exporter, before the export outcome is known — because emission
	 * here is decoupled from the POST. If that export batch fails,
	 * `notifyExportFailed` resets the latch so this method re-emits the exact
	 * same `rootSpanId` on the next call, retrying the root without orphaning
	 * children that already reference it. The next call normally comes from a
	 * later `closeRun`; when there is none (single LLM call, no tools),
	 * `retryPendingRoot` — invoked via `finalize` from the node's
	 * `closeFunction` at execution end — is the last chance. Re-emission is
	 * bounded: at most `MAX_ROOT_RE_EMITS` re-emits per execution
	 * (`notifyExportFailed` stops un-latching past that), and a 409 failure
	 * re-latches instead of retrying. Accepted residual: if every bounded
	 * attempt fails, the trace is lost.
	 */
	private emitSharedRootIfNeeded(): void {
		const shared = this.sharedTrace;
		if (!shared || shared.rootEmitted || !shared.sampled) return;
		shared.rootEmitted = true;
		shared.rootAttempted = true;
		this.emit({
			traceId: shared.traceId,
			spanId: shared.rootSpanId,
			name: this.config.rootSpanName ?? 'n8n agent execution',
			kind: SPAN_KIND_INTERNAL,
			startTimeUnixNano: msToNanos(this.startedAtMs),
			endTimeUnixNano: msToNanos(this.now()),
			attributes: toOtlpAttributes(this.config.baseAttributes),
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
					sampled: this.sampledByTraceId.get(parent.traceId) ?? true,
				};
			}
			let unseen = this.traceForUnseenParent.get(parentRunId);
			if (!unseen) {
				unseen = this.config.singleTrace
					? { ...this.sharedTraceContext() }
					: { traceId: generateTraceId(), sampled: this.decideSampled() };
				this.traceForUnseenParent.set(parentRunId, unseen);
				this.sampledByTraceId.set(unseen.traceId, unseen.sampled);
			}
			return { traceId: unseen.traceId, sampled: unseen.sampled };
		}
		if (this.config.singleTrace) {
			const shared = this.sharedTraceContext();
			return { traceId: shared.traceId, sampled: shared.sampled };
		}
		const traceId = generateTraceId();
		const sampled = this.decideSampled();
		this.sampledByTraceId.set(traceId, sampled);
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
		this.runs.set(runId, {
			spanId: generateSpanId(),
			traceId: context.traceId,
			parentSpanId: context.parentSpanId,
			name,
			kind,
			startMs: this.now(),
			attributes,
		});
	}

	// OTel convention: status stays UNSET (omitted) on success; only
	// failures pass an explicit ERROR status.
	private closeRun(
		runId: string,
		endAttributes: Record<string, OtlpAttrValue | undefined>,
		status?: { code: number; message?: string },
	): void {
		const run = this.runs.get(runId);
		if (!run) return;
		this.runs.delete(runId);
		if (!(this.sampledByTraceId.get(run.traceId) ?? true)) return;
		let parentSpanId = run.parentSpanId;
		if (this.sharedTrace && run.traceId === this.sharedTrace.traceId) {
			this.emitSharedRootIfNeeded();
			parentSpanId = parentSpanId ?? this.sharedTrace.rootSpanId;
		}
		this.emit({
			traceId: run.traceId,
			spanId: run.spanId,
			parentSpanId,
			name: run.name,
			kind: run.kind,
			startTimeUnixNano: msToNanos(run.startMs),
			endTimeUnixNano: msToNanos(this.now()),
			attributes: toOtlpAttributes({
				...this.config.baseAttributes,
				...run.attributes,
				...endAttributes,
			}),
			...(status ? { status } : {}),
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
		const end = low > 0 && text.charCodeAt(low - 1) >= 0xd800 && text.charCodeAt(low - 1) <= 0xdbff ? low - 1 : low;
		return `${text.slice(0, end)}${TRUNCATION_MARKER}`;
	}

	private safeStringify(value: unknown): string {
		if (typeof value === 'string') return value;
		try {
			return JSON.stringify(value) ?? String(value);
		} catch {
			return String(value);
		}
	}

	/**
	 * LangChain chat messages are class instances (sometimes with circular
	 * refs); bare JSON.stringify degrades to "[object Object]" — measured live
	 * in the spike. Extract role+content per message instead.
	 */
	private serializeMessages(messages: unknown): string {
		if (!Array.isArray(messages)) return this.safeStringify(messages);
		const simplified = (messages as unknown[]).flat().map((message) => {
			const m = message as {
				content?: unknown;
				_getType?: () => string;
				constructor?: { name?: string };
			} | null;
			let role = 'unknown';
			try {
				role = m?._getType?.() ?? m?.constructor?.name ?? 'unknown';
			} catch {
				/* role is best-effort */
			}
			return { role, content: m?.content ?? this.safeStringify(message) };
		});
		return this.safeStringify(simplified);
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
		this.openRun(runId, parentRunId, `llm:${model ?? this.componentName(serialized)}`, SPAN_KIND_CLIENT, {
			'gen_ai.system': genAiSystemFrom(serialized),
			'gen_ai.request.model': model,
			'gen_ai.prompt':
				this.config.capturePrompts && promptText !== undefined ? this.truncate(promptText) : undefined,
		});
	}

	private closeLlmRun(output: LlmResultLike | null, runId: string): void {
		const result = output ?? {};
		const usage = tokenUsageFrom(result);
		const completion = this.config.capturePrompts ? completionTextFrom(result) : undefined;
		// Tool executions never reach a model-attached handler (measured live),
		// but the model's own response names the tools it decided to call.
		// Extracted UNCONDITIONALLY: the pending ledger drives tool-span
		// synthesis; only the gen_ai.tool_calls attribute stays gated by
		// captureToolIO.
		const toolCalls = toolCallsFrom(result);
		// Only KNOWN runs may ledger tool calls: a stray handleLLMEnd for a run
		// this tracker never opened must not seed phantom tool spans at finalize.
		if (this.runs.has(runId) && toolCalls.length > 0) {
			const requestedAtMs = this.now();
			// Push at most the NEWEST ledger-cap's worth, then drain overflow in
			// ONE splice — a shift()-per-entry loop is O(N²) and measurably
			// blocks the event loop on giant malformed payloads.
			for (const call of toolCalls.slice(-MAX_PENDING_TOOL_CALLS)) {
				this.pendingToolCalls.push({
					id: call.id,
					name: call.name,
					// Off means off for retention too: never pin argument graphs
					// the export path would not read.
					args: this.config.captureToolIO ? call.args : undefined,
					requestedAtMs,
				});
			}
			const excess = this.pendingToolCalls.length - MAX_PENDING_TOOL_CALLS;
			if (excess > 0) this.pendingToolCalls.splice(0, excess);
		}
		this.closeRun(
			runId,
			{
				'gen_ai.usage.input_tokens': usage.inputTokens,
				'gen_ai.usage.output_tokens': usage.outputTokens,
				'gen_ai.completion': completion === undefined ? undefined : this.truncate(completion),
				'gen_ai.tool_calls':
					this.config.captureToolIO && toolCalls.length > 0
						? this.truncate(this.safeStringify(toolCalls))
						: undefined,
			},
		);
	}

	/**
	 * Model-side tool-span synthesis, chat models only (plain `handleLLMStart`
	 * prompts carry no tool messages). Tool executions never reach a
	 * model-attached handler, but their data passes the model seat twice:
	 * `handleLLMEnd`'s output names the calls the model requested (ledgered in
	 * `closeLlmRun`), and the NEXT chat-model start echoes each tool RESULT as
	 * a ToolMessage-like entry (`tool_call_id` + `content`). Matching results
	 * to pending requests by `tool_call_id` yields one synthesized span per
	 * completed call. Unmatched tool-result messages (no pending entry, e.g.
	 * ledger overflow) are ignored.
	 *
	 * Timing caveat: start/end are reconstructed from the surrounding LLM-call
	 * boundaries (previous `handleLLMEnd` -> this `handleChatModelStart`), so
	 * the span includes n8n framework overhead, not pure tool runtime.
	 */
	private synthesizeToolSpansFrom(messages: unknown): void {
		if (!this.config.singleTrace) return;
		if (this.pendingToolCalls.length === 0 || !Array.isArray(messages)) return;
		for (const message of (messages as unknown[]).flat()) {
			// Per-message guard: a hostile property getter on one message must
			// not abort the loop (or the caller's subsequent openLlmRun).
			try {
				const m = message as {
					content?: unknown;
					tool_call_id?: unknown;
					_getType?: () => string;
				} | null;
				if (m === null || typeof m !== 'object') continue;
				let isToolResult = typeof m.tool_call_id === 'string';
				if (!isToolResult) {
					try {
						isToolResult = m._getType?.() === 'tool';
					} catch {
						/* detection is best-effort */
					}
				}
				if (!isToolResult) continue;
				// Empty-string ids count as absent on BOTH sides of the match —
				// two id-less concurrent calls must not cross-match.
				const callId =
					typeof m.tool_call_id === 'string' && m.tool_call_id.length > 0 ? m.tool_call_id : undefined;
				const index =
					callId === undefined
						? -1
						: this.pendingToolCalls.findIndex(
								(pending) =>
									typeof pending.id === 'string' && pending.id.length > 0 && pending.id === callId,
							);
				if (index === -1) continue;
				const [pending] = this.pendingToolCalls.splice(index, 1);
				this.emitSynthesizedToolSpan(pending, { resultObserved: true, output: m.content });
			} catch {
				this.handlerErrors++;
			}
		}
	}

	/**
	 * Synthesized `tool:<name>` span (provenance and timing caveat on
	 * `synthesizeToolSpansFrom`). Only meaningful in singleTrace mode — the
	 * only mode `wrapModelWithTracing` uses — where it parents under the
	 * shared synthetic root. Status stays UNSET: tool success/failure is not
	 * observable from the model seat.
	 */
	private emitSynthesizedToolSpan(
		pending: PendingToolCall,
		result: { resultObserved: boolean; output?: unknown; endMs?: number },
	): void {
		if (!this.config.singleTrace) return;
		const context = this.sharedTraceContext();
		if (!context.sampled) return;
		this.emitSharedRootIfNeeded();
		const shared = this.sharedTrace;
		if (!shared) return;
		// Extraction is unvalidated — a malformed payload can put non-strings
		// where ids/names belong; only emit them when they really are strings.
		const toolName = typeof pending.name === 'string' ? pending.name : undefined;
		const toolCallId = typeof pending.id === 'string' ? pending.id : undefined;
		this.emit({
			traceId: shared.traceId,
			spanId: generateSpanId(),
			parentSpanId: shared.rootSpanId,
			name: `tool:${toolName ?? 'unknown'}`,
			kind: SPAN_KIND_INTERNAL,
			startTimeUnixNano: msToNanos(pending.requestedAtMs),
			endTimeUnixNano: msToNanos(result.endMs ?? this.now()),
			attributes: toOtlpAttributes({
				...this.config.baseAttributes,
				'gen_ai.operation.name': 'execute_tool',
				'gen_ai.tool.name': toolName,
				'gen_ai.tool.call.id': toolCallId,
				'n8n.span.synthesized': true,
				'n8n.tool.result_observed': result.resultObserved ? undefined : false,
				'tool.input':
					this.config.captureToolIO && pending.args !== undefined
						? this.truncate(this.safeStringify(pending.args))
						: undefined,
				'tool.output':
					this.config.captureToolIO && result.resultObserved
						? this.truncate(this.safeStringify(result.output))
						: undefined,
			}),
		});
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
					const promptText = this.config.capturePrompts ? this.serializeMessages(messages) : undefined;
					this.openLlmRun(llm, promptText, runId, parentRunId, extraParams);
				},
			),
			handleLLMStart: this.guarded(
				'handleLLMStart',
				(args) => ({ runId: args[2] as string, parentRunId: args[3] as string | undefined }),
				(llm, prompts, runId, parentRunId, extraParams) => {
					const promptText =
						this.config.capturePrompts && Array.isArray(prompts) ? prompts.join('\n\n') : undefined;
					this.openLlmRun(llm, promptText, runId, parentRunId, extraParams);
				},
			),
			handleLLMEnd: this.guarded(
				'handleLLMEnd',
				(args) => ({ runId: args[1] as string, parentRunId: args[2] as string | undefined }),
				(output, runId) => this.closeLlmRun(output, runId),
			),
			handleLLMError: this.guarded(
				'handleLLMError',
				(args) => ({ runId: args[1] as string, parentRunId: args[2] as string | undefined }),
				(error, runId) =>
					this.closeRun(runId, {}, { code: STATUS_ERROR, message: String(error).slice(0, 500) }),
			),
			handleChainStart: this.guarded(
				'handleChainStart',
				(args) => ({ runId: args[2] as string, parentRunId: args[3] as string | undefined }),
				(chain, _inputs, runId, parentRunId) =>
					this.openRun(runId, parentRunId, `chain:${this.componentName(chain)}`, SPAN_KIND_INTERNAL, {}),
			),
			handleChainEnd: this.guarded(
				'handleChainEnd',
				(args) => ({ runId: args[1] as string, parentRunId: args[2] as string | undefined }),
				(_outputs, runId) => this.closeRun(runId, {}),
			),
			handleChainError: this.guarded(
				'handleChainError',
				(args) => ({ runId: args[1] as string, parentRunId: args[2] as string | undefined }),
				(error, runId) =>
					this.closeRun(runId, {}, { code: STATUS_ERROR, message: String(error).slice(0, 500) }),
			),
			handleToolStart: this.guarded(
				'handleToolStart',
				(args) => ({ runId: args[2] as string, parentRunId: args[3] as string | undefined }),
				(tool, input, runId, parentRunId) =>
					this.openRun(runId, parentRunId, `tool:${this.componentName(tool)}`, SPAN_KIND_INTERNAL, {
						'tool.input': this.config.captureToolIO ? this.truncate(this.safeStringify(input)) : undefined,
					}),
			),
			handleToolEnd: this.guarded(
				'handleToolEnd',
				(args) => ({ runId: args[1] as string, parentRunId: args[2] as string | undefined }),
				(output, runId) =>
					this.closeRun(runId, {
						'tool.output': this.config.captureToolIO
							? this.truncate(this.safeStringify(output))
							: undefined,
					}),
			),
			handleToolError: this.guarded(
				'handleToolError',
				(args) => ({ runId: args[1] as string, parentRunId: args[2] as string | undefined }),
				(error, runId) =>
					this.closeRun(runId, {}, { code: STATUS_ERROR, message: String(error).slice(0, 500) }),
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
