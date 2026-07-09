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
): unknown {
	try {
		const target = buildExportTarget(credential);
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
		);
		const tracker = new RunTreeTracker(
			{
				capturePrompts: options.capturePrompts,
				captureToolIO: options.captureToolIO,
				maxPayloadBytes: Math.max(1, options.maxPayloadSizeKb) * 1024,
				samplingRatePercent: options.samplingRatePercent,
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
		const attached = attachHandler(model, tracker.createHandler());
		if (!attached) {
			try {
				ctx.logger.warn(
					'[TraceExporter] could not attach tracing callbacks to the supplied model; passing it through untraced',
				);
			} catch {
				/* never break the workflow */
			}
		}
	} catch (error) {
		try {
			ctx.logger.warn(`[TraceExporter] tracing setup failed, passing model through: ${String(error)}`);
		} catch {
			/* never break the workflow */
		}
	}
	return model;
}
