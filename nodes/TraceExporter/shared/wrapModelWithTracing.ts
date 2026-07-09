import type { ISupplyDataFunctions } from 'n8n-workflow';

import type { TracingHooks } from './callbackTypes';
import { buildExportTarget, SpanExporter } from './otlpExport';
import type { OtlpCredential } from './otlpExport';
import type { OtlpAttrValue } from './otlpJson';
import { RunTreeTracker } from './runTreeTracker';

/**
 * Options read from the Trace Exporter node's parameters (PRD §5 "Node A
 * options"). `redactionPatterns` is accepted but not yet applied — the spike
 * scopes redaction out (spec §"Out of scope"); FINDINGS.md records it.
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
}

/**
 * Append our handler to the model's existing callbacks without clobbering
 * whatever n8n already attached (core ModelSelector pattern). Handles the
 * three runtime shapes of `model.callbacks`: absent, plain array, or a
 * CallbackManager-like object with `addHandler`.
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
		callbacks.push(handler);
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
		attributes['n8n.node.name'] = ctx.getNode().name;
	} catch {
		/* never break the workflow */
	}
	if (options.traceName) attributes['n8n.trace.name'] = options.traceName;
	if (options.sessionId) attributes['session.id'] = options.sessionId;
	if (options.userId) attributes['user.id'] = options.userId;

	let metadata = options.metadata;
	if (typeof metadata === 'string') {
		try {
			metadata = JSON.parse(metadata);
		} catch {
			metadata = undefined;
		}
	}
	if (metadata && typeof metadata === 'object' && Object.keys(metadata).length > 0) {
		try {
			attributes['n8n.metadata'] = JSON.stringify(metadata).slice(0, 4096);
		} catch {
			/* never break the workflow */
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
 * Primary eviction is the `closeFunction` returned from `supplyData` (n8n
 * invokes it when the supplied data's owning execution finishes) — see the
 * `closeFunction` construction below. `MAX_PIPELINES` FIFO eviction is only
 * the safety net for pipelines whose execution never reaches `closeFunction`
 * (e.g. a crash), so long-lived instances still can't grow this without
 * bound.
 *
 * Each entry also carries the tracker's `retryPendingRoot` so `closeFunction`
 * can fire the execution-end root retry (see `RunTreeTracker.retryPendingRoot`)
 * before deleting the entry.
 */
interface PipelineEntry {
	handler: TracingHooks;
	retryPendingRoot: () => void;
}

const pipelineByExecution = new Map<string, PipelineEntry>();
const MAX_PIPELINES = 200;

/**
 * Retry the execution's pending root (if any), then evict the registry entry.
 * Returned as `SupplyData.closeFunction` from every supplyData call of the
 * execution — idempotent, n8n may call it several times.
 */
function buildCloseFunction(registryKey: string): () => Promise<void> {
	return async () => {
		const entry = pipelineByExecution.get(registryKey);
		if (entry) {
			try {
				entry.retryPendingRoot();
			} catch {
				/* never break the workflow */
			}
		}
		pipelineByExecution.delete(registryKey);
	};
}

/** Result of {@link wrapModelWithTracing} — the model plus its eviction hook. */
export interface WrappedModel {
	model: unknown;
	closeFunction?: () => Promise<void>;
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
		const existing = registryKey ? pipelineByExecution.get(registryKey) : undefined;
		if (existing && registryKey) {
			if (!attachHandler(model, existing.handler)) {
				try {
					ctx.logger.warn(
						'[TraceExporter] could not attach tracing callbacks to the supplied model; passing it through untraced',
					);
				} catch {
					/* never break the workflow */
				}
			}
			return { model, closeFunction: buildCloseFunction(registryKey) };
		}

		const target = buildExportTarget(credential);
		// `tracker` is constructed after `exporter`, but the exporter's
		// failure callback needs to call back into the tracker (Fix: root
		// re-emit on export failure). Resolve the chicken/egg with a mutable
		// box the closure reads from, filled in once the tracker exists below
		// — a box property mutates in place, so this stays lint-clean as a
		// `const` (unlike a plain forward-declared `let`).
		const trackerBox: { current?: RunTreeTracker } = {};
		const exporter = new SpanExporter(
			target,
			async (url, headers, body) =>
				ctx.helpers.httpRequest({ method: 'POST', url, headers, body, json: true }),
			{ 'service.name': 'n8n-trace-exporter' },
			(message) => {
				try {
					ctx.logger.warn(`[TraceExporter] ${message}`);
				} catch {
					/* never break the workflow */
				}
			},
			(spans) => trackerBox.current?.notifyExportFailed(spans),
		);
		const tracker = new RunTreeTracker(
			{
				capturePrompts: options.capturePrompts,
				captureToolIO: options.captureToolIO,
				maxPayloadBytes: Math.max(1, options.maxPayloadSizeKb) * 1024,
				samplingRatePercent: options.samplingRatePercent,
				singleTrace: true,
				rootSpanName: options.traceName || 'n8n agent execution',
				baseAttributes: collectBaseAttributes(ctx, options),
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
				const oldest = pipelineByExecution.keys().next().value;
				if (oldest !== undefined) pipelineByExecution.delete(oldest);
			}
			pipelineByExecution.set(registryKey, {
				handler,
				retryPendingRoot: () => tracker.retryPendingRoot(),
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
