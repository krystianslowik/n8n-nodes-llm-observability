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
	STATUS_OK,
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
	 */
	singleTrace?: boolean;
}

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
 * Maps LangChain runId/parentRunId callbacks onto OTLP spans (spec §"Run-tree
 * tracker"). Runs under an observed parent get real parentage; runs under an
 * unseen parent (the expected case: the agent's chain run never reaches a
 * model-attached handler) share a trace keyed on that unseen parentRunId, so
 * one agent execution stays one trace even without a root span.
 */
export class RunTreeTracker {
	readonly events: TrackerEvent[] = [];

	handlerErrors = 0;

	private readonly runs = new Map<string, OpenRun>();

	private readonly traceForUnseenParent = new Map<string, { traceId: string; sampled: boolean }>();

	private readonly sampledByTraceId = new Map<string, boolean>();

	private sharedTrace?: { traceId: string; sampled: boolean };

	constructor(
		private readonly config: TrackerConfig,
		private readonly emit: (span: OtlpSpan) => void,
	) {}

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
			this.sharedTrace = { traceId: generateTraceId(), sampled: this.decideSampled() };
			this.sampledByTraceId.set(this.sharedTrace.traceId, this.sharedTrace.sampled);
		}
		return this.sharedTrace;
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

	private closeRun(
		runId: string,
		endAttributes: Record<string, OtlpAttrValue | undefined>,
		status: { code: number; message?: string },
	): void {
		const run = this.runs.get(runId);
		if (!run) return;
		this.runs.delete(runId);
		if (!(this.sampledByTraceId.get(run.traceId) ?? true)) return;
		this.emit({
			traceId: run.traceId,
			spanId: run.spanId,
			parentSpanId: run.parentSpanId,
			name: run.name,
			kind: run.kind,
			startTimeUnixNano: msToNanos(run.startMs),
			endTimeUnixNano: msToNanos(this.now()),
			attributes: toOtlpAttributes({
				...this.config.baseAttributes,
				...run.attributes,
				...endAttributes,
			}),
			status,
		});
	}

	private truncate(text: string): string {
		const max = this.config.maxPayloadBytes;
		return text.length > max ? `${text.slice(0, max)}…[truncated]` : text;
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
		// but the model's own response names the tools it decided to call —
		// surface that as an attribute so tool activity is at least visible.
		const toolCalls = this.config.captureToolIO ? toolCallsFrom(result) : [];
		this.closeRun(
			runId,
			{
				'gen_ai.usage.input_tokens': usage.inputTokens,
				'gen_ai.usage.output_tokens': usage.outputTokens,
				'gen_ai.completion': completion === undefined ? undefined : this.truncate(completion),
				'gen_ai.tool_calls':
					toolCalls.length > 0 ? this.truncate(this.safeStringify(toolCalls)) : undefined,
			},
			{ code: STATUS_OK },
		);
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
				(_outputs, runId) => this.closeRun(runId, {}, { code: STATUS_OK }),
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
					this.closeRun(
						runId,
						{
							'tool.output': this.config.captureToolIO
								? this.truncate(this.safeStringify(output))
								: undefined,
						},
						{ code: STATUS_OK },
					),
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
