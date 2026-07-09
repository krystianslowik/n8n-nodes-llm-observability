/**
 * Hand-rolled OTLP/HTTP JSON building blocks (spike design §"Hand-rolled
 * OTLP/JSON exporter"). Deliberately not the OTel SDK: zero dependencies,
 * no global tracer state, nothing to bundle.
 */

export type OtlpAttrValue = string | number | boolean;

export interface OtlpKeyValue {
	key: string;
	value: Record<string, unknown>;
}

export interface OtlpSpan {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
	kind: number;
	startTimeUnixNano: string;
	endTimeUnixNano: string;
	attributes: OtlpKeyValue[];
	/** OTel convention: omitted (UNSET) on success; ERROR only on failure. */
	status?: { code: number; message?: string };
}

export const SPAN_KIND_INTERNAL = 1;
export const SPAN_KIND_CLIENT = 3;
export const STATUS_ERROR = 2;

/**
 * The project's tsconfig omits the "dom" lib (it targets a Node runtime, not
 * a browser), so the Web Crypto `crypto` global has no ambient type, and the
 * n8n community lint ruleset separately bans referencing the `globalThis`
 * identifier outright. Declaring the narrow shape we actually use lets us
 * call the same runtime global (Node 19+ attaches `crypto` directly to the
 * global object) via a plain identifier — satisfies both constraints without
 * `any` and without widening to the full "dom" lib for one method.
 */
declare const crypto: {
	getRandomValues<T extends Uint8Array>(array: T): T;
};

function randomHex(byteLength: number): string {
	const bytes = new Uint8Array(byteLength);
	crypto.getRandomValues(bytes);
	let hex = '';
	for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
	return hex;
}

export function generateTraceId(): string {
	return randomHex(16);
}

export function generateSpanId(): string {
	return randomHex(8);
}

/** OTLP nanosecond timestamps exceed Number.MAX_SAFE_INTEGER — string math only. */
export function msToNanos(ms: number): string {
	return `${Math.round(ms)}000000`;
}

export function toOtlpAttributes(attrs: Record<string, OtlpAttrValue | undefined>): OtlpKeyValue[] {
	const result: OtlpKeyValue[] = [];
	for (const [key, raw] of Object.entries(attrs)) {
		if (raw === undefined) continue;
		let value: Record<string, unknown>;
		if (typeof raw === 'string') value = { stringValue: raw };
		else if (typeof raw === 'boolean') value = { boolValue: raw };
		else if (Number.isInteger(raw)) value = { intValue: String(raw) };
		else value = { doubleValue: raw };
		result.push({ key, value });
	}
	return result;
}

export function buildExportRequest(
	resourceAttributes: Record<string, OtlpAttrValue>,
	spans: OtlpSpan[],
): object {
	return {
		resourceSpans: [
			{
				resource: { attributes: toOtlpAttributes(resourceAttributes) },
				scopeSpans: [
					{
						scope: { name: 'n8n-nodes-llm-observability', version: '0.1.0' },
						spans,
					},
				],
			},
		],
	};
}
