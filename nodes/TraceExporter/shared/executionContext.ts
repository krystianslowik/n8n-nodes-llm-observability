import type { ISupplyDataFunctions } from 'n8n-workflow';

import type { TraceExecutionContext } from './n8nExecutionState';

type RedactionSnapshot =
	| {
			version: 1;
			policy: 'none' | 'all' | 'non-manual' | 'manual-only';
	  }
	| {
			version: 2;
			production: boolean;
			manual: boolean;
	  };

export interface ExecutionObservabilityContext {
	mode?: string;
	parentExecutionId?: string;
	contentCaptureBlocked: boolean;
}

interface RuntimeMetadataContext {
	getExecuteData?: () => {
		metadata?: {
			tracing?: unknown;
		};
	};
	setMetadata?: (metadata: { tracing: Record<string, string | number | boolean> }) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function redactionSnapshotFrom(value: unknown): RedactionSnapshot | undefined {
	if (!isRecord(value)) return undefined;
	if (
		value.version === 1 &&
		(value.policy === 'none' ||
			value.policy === 'all' ||
			value.policy === 'non-manual' ||
			value.policy === 'manual-only')
	) {
		return { version: 1, policy: value.policy };
	}
	if (
		value.version === 2 &&
		typeof value.production === 'boolean' &&
		typeof value.manual === 'boolean'
	) {
		return {
			version: 2,
			production: value.production,
			manual: value.manual,
		};
	}
	return undefined;
}

function blocksContent(snapshot: RedactionSnapshot | undefined, mode: string | undefined): boolean {
	if (!snapshot) return true;
	if (snapshot.version === 2) {
		if (mode === 'manual') return snapshot.manual;
		if (mode !== undefined) return snapshot.production;
		return snapshot.manual || snapshot.production;
	}

	switch (snapshot.policy) {
		case 'none':
			return false;
		case 'all':
			return true;
		case 'non-manual':
			return mode === undefined || mode !== 'manual';
		case 'manual-only':
			return mode === undefined || mode === 'manual';
	}
}

/**
 * Read only the non-sensitive execution context required by trace correlation.
 * n8n's redaction snapshot is a hard ceiling: when it suppresses execution data,
 * opt-in prompt/tool capture is suppressed too.
 */
export function executionObservabilityContextFrom(
	ctx: ISupplyDataFunctions,
): ExecutionObservabilityContext {
	try {
		const mode = ctx.getMode();
		const executionContext = ctx.getExecutionContext();
		const redaction = redactionSnapshotFrom(executionContext?.redaction);
		return {
			mode,
			...(executionContext?.parentExecutionId
				? { parentExecutionId: executionContext.parentExecutionId }
				: {}),
			contentCaptureBlocked: blocksContent(redaction, mode),
		};
	} catch {
		// Privacy fails closed. If the runtime cannot expose its redaction
		// policy, non-content telemetry still works but payload capture does not.
		return { contentCaptureBlocked: true };
	}
}

/**
 * Add queryable correlation attributes to n8n's native node span when its
 * concrete SupplyData runtime exposes the otherwise non-public metadata API.
 * This does not create OTel parentage. The call is deliberately best-effort:
 * trace export must never change workflow behavior.
 */
export function correlateNativeNodeSpan(
	ctx: ISupplyDataFunctions,
	traceContext: TraceExecutionContext | undefined,
): boolean {
	if (traceContext?.sampling !== 'sampled') return false;

	try {
		const runtimeContext = ctx as ISupplyDataFunctions & RuntimeMetadataContext;
		if (
			typeof runtimeContext.getExecuteData !== 'function' ||
			typeof runtimeContext.setMetadata !== 'function'
		) {
			return false;
		}

		const existingTracing = runtimeContext.getExecuteData()?.metadata?.tracing;
		const preserved = isRecord(existingTracing)
			? Object.fromEntries(
					Object.entries(existingTracing).filter(
						(entry): entry is [string, string | number | boolean] =>
							typeof entry[1] === 'string' ||
							typeof entry[1] === 'number' ||
							typeof entry[1] === 'boolean',
					),
				)
			: {};

		runtimeContext.setMetadata({
			tracing: {
				...preserved,
				ai_observability_trace_id: traceContext.traceId,
				ai_observability_root_span_id: traceContext.rootSpanId,
			},
		});
		return true;
	} catch {
		return false;
	}
}
