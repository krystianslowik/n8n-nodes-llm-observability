import type { ISupplyDataFunctions } from 'n8n-workflow';

import type { TracingHooks } from './callbackTypes';
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
	environment: string;
	tags: string[];
	release: string;
	serviceName: string;
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
	} catch {
		/* never break the workflow */
	}
	if (options.traceName) attributes['n8n.trace.name'] = options.traceName;
	attributes['n8n.item.index'] = options.itemIndex;
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
		try {
			attributes['n8n.metadata'] = redact(JSON.stringify(metadata)).slice(0, 4096);
		} catch {
			/* never break the workflow */
		}
		let entries: Array<[string, unknown]> = [];
		try {
			entries = Object.entries(metadata).slice(0, 50);
		} catch {
			entries = [];
		}
		for (const [rawKey, rawValue] of entries) {
			const key = rawKey.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 100);
			if (!key) continue;
			let value: string;
			try {
				value =
					typeof rawValue === 'string'
						? rawValue
						: (JSON.stringify(rawValue) ?? String(rawValue));
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
 * One tracing pipeline per (execution, node): measured live in the spike,
 * n8n's AI Agent re-calls supplyData for EVERY model invocation, so per-call
 * pipelines would split one agent run into one trace per LLM call. Module
 * scope survives across those calls within the n8n process.
 *
 * Eviction is deliberately LAZY. n8n runs the `closeFunction`s collected from
 * supplyData in the `finally` of every `runNode` invocation — and the
 * steppable Tools Agent (V3) returns an `EngineRequest` per step and is
 * re-invoked with the tool results, so ONE agent execution is MANY runNode
 * invocations and `closeFunction` fires after every step, not at execution
 * end (measured live: evict-on-close split one chat execution into one trace
 * per LLM call and orphaned the pending-tool ledger). So `closeFunction` only
 * MARKS the entry closed (`closedAt`); a later supplyData for the same
 * execution — the next agent step — clears the mark and keeps the same
 * tracker/trace. Entries that stay closed past `PIPELINE_LINGER_MS` are
 * finalized (pending tool-span flush anchored at `closedAt`, pending-root
 * retry — see `RunTreeTracker.finalize`) and deleted by `sweepStalePipelines`,
 * which runs on every wrap call. `MAX_PIPELINES` FIFO eviction (closed
 * entries first) is the backstop for pipelines whose execution never reaches
 * `closeFunction` (e.g. a crash), so long-lived instances can't grow this
 * without bound.
 *
 * Accepted residuals: an entry pins its step-1 context (via the exporter's
 * post closure) for up to the linger window after the execution really ends;
 * and an agent step whose tool runs LONGER than the linger window while other
 * traffic sweeps the registry gets split into a second trace.
 */
interface PipelineEntry {
	handler: TracingHooks;
	finalize: (atMs?: number) => void;
	retryPendingRoot: () => void;
	getTraceContext: () => { traceId: string; rootSpanId: string } | undefined;
	/** Set at every closeFunction, cleared when a later step reuses the entry. */
	closedAt?: number;
}

const pipelineByExecution = new Map<string, PipelineEntry>();
const MAX_PIPELINES = 200;
export const PIPELINE_LINGER_MS = 10 * 60_000;

/**
 * Finalize + evict every entry that has stayed closed past the linger window.
 * Called with `Date.now()` from every `wrapModelWithTracing` call; exported
 * (with an explicit clock) so tests can drive the window. Never throws.
 */
export function sweepStalePipelines(nowMs: number, skipKey?: string): void {
	for (const [key, entry] of pipelineByExecution) {
		if (key === skipKey) continue;
		if (entry.closedAt === undefined || nowMs - entry.closedAt <= PIPELINE_LINGER_MS) continue;
		try {
			entry.finalize(entry.closedAt);
		} catch {
			/* never break the workflow */
		}
		pipelineByExecution.delete(key);
	}
}

/**
 * Returned as `SupplyData.closeFunction` from every supplyData call of the
 * execution — idempotent, n8n may call it several times, and on the steppable
 * Tools Agent it fires after EVERY agent step (see the registry doc above).
 * It must therefore not tear anything down: it retries a pending failed root
 * (safe at any point) and marks the entry closed for the lazy sweep. The
 * pending-tool flush must NOT run here — mid-execution the results are still
 * on their way back to the next step's model call.
 */
function buildCloseFunction(registryKey: string): () => Promise<void> {
	return async () => {
		const entry = pipelineByExecution.get(registryKey);
		if (!entry) return;
		try {
			entry.retryPendingRoot();
		} catch {
			/* never break the workflow */
		}
		entry.closedAt = Date.now();
	};
}

/** Result of {@link wrapModelWithTracing} — the model plus its eviction hook. */
export interface WrappedModel {
	model: unknown;
	closeFunction?: () => Promise<void>;
	getTraceContext?: () => { traceId: string; rootSpanId: string } | undefined;
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
	try {
		let registryKey: string | undefined;
		try {
			registryKey = `${ctx.getExecutionId()}::${ctx.getNode().name}`;
		} catch {
			registryKey = undefined;
		}
		sweepStalePipelines(Date.now(), registryKey);
		const existing = registryKey ? pipelineByExecution.get(registryKey) : undefined;
		if (existing && registryKey) {
			// A later agent step of the same execution: the entry stays live and
			// the earlier closeFunction's mark is void (see the registry doc).
			existing.closedAt = undefined;
			if (!attachHandler(model, existing.handler)) {
				try {
					ctx.logger.warn(
						'[TraceExporter] could not attach tracing callbacks to the supplied model; passing it through untraced',
					);
				} catch {
					/* never break the workflow */
				}
			}
			return {
				model,
				closeFunction: buildCloseFunction(registryKey),
				getTraceContext: existing.getTraceContext,
			};
		}

		const target = buildExportTarget(credential);
		const redactor = compileRedactor(
			Array.isArray(options.redactionPatterns) ? options.redactionPatterns : [],
		);
		if (redactor.invalidPatternCount > 0) {
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
			(spans, statusCode) => trackerBox.current?.notifyExportFailed(spans, statusCode),
		);
		const tracker = new RunTreeTracker(
			{
				capturePrompts: options.capturePrompts,
				captureToolIO: options.captureToolIO,
				// A non-numeric node option would make the budget NaN — every
				// byte comparison then fails and EVERYTHING truncates to the bare
				// marker. Fall back to the option's 32 KB default instead.
				maxPayloadBytes:
					(Number.isFinite(options.maxPayloadSizeKb) ? Math.max(1, options.maxPayloadSizeKb) : 32) * 1024,
				samplingRatePercent: options.samplingRatePercent,
				singleTrace: true,
				rootSpanName: options.traceName || 'n8n agent execution',
				baseAttributes: collectBaseAttributes(ctx, options, redactor.redact),
				redact: redactor.redact,
				onEvent: (event) => {
					try {
						ctx.logger.info(
							`[TraceExporter] hook=${event.hook} runId=${event.runId ?? '-'} parentRunId=${event.parentRunId ?? '-'}`,
						);
					} catch {
						/* never break the workflow */
					}
				},
			},
			(span) => exporter.add(span),
		);
		trackerBox.current = tracker;
		const handler = tracker.createHandler();
		if (registryKey) {
			if (pipelineByExecution.size >= MAX_PIPELINES) {
				// Prefer the oldest CLOSED entry (its execution is likely over —
				// finalize flushes what it can). Falling back to the oldest live
				// entry is the accepted residual: that pipeline loses its pending
				// tool flush and root retry — its finalize is never reachable again.
				let evictKey: string | undefined;
				for (const [key, entry] of pipelineByExecution) {
					if (entry.closedAt !== undefined) {
						evictKey = key;
						break;
					}
				}
				if (evictKey !== undefined) {
					const evicted = pipelineByExecution.get(evictKey);
					try {
						evicted?.finalize(evicted.closedAt);
					} catch {
						/* never break the workflow */
					}
				} else {
					evictKey = pipelineByExecution.keys().next().value;
				}
				if (evictKey !== undefined) pipelineByExecution.delete(evictKey);
			}
			pipelineByExecution.set(registryKey, {
				handler,
				finalize: (atMs?: number) => tracker.finalize(atMs),
				retryPendingRoot: () => tracker.retryPendingRoot(),
				getTraceContext: () => tracker.getTraceContext(),
			});
		}
		const attached = attachHandler(model, handler);
		if (!attached) {
			try {
				ctx.logger.warn(
					'[TraceExporter] could not attach tracing callbacks to the supplied model; passing it through untraced',
				);
			} catch {
				/* never break the workflow */
			}
		}
		return {
			model,
			closeFunction: registryKey ? buildCloseFunction(registryKey) : undefined,
			getTraceContext: () => tracker.getTraceContext(),
		};
	} catch (error) {
		try {
			ctx.logger.warn(`[TraceExporter] tracing setup failed, passing model through: ${String(error)}`);
		} catch {
			/* never break the workflow */
		}
	}
	return { model };
}
