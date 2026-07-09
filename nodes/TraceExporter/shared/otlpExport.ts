import { buildExportRequest } from './otlpJson';
import type { OtlpAttrValue, OtlpSpan } from './otlpJson';

/** Decrypted `otlpExporterApi` credential shape (credentials/OtlpExporterApi.credentials.ts). */
export interface OtlpCredential {
	endpointUrl: string;
	authType: 'basicAuth' | 'apiKeyHeader' | 'customHeaders';
	username?: string;
	password?: string;
	apiKey?: string;
	headerName?: string;
	customHeaders?: string | Record<string, string>;
}

/**
 * Credential -> concrete OTLP target. Mirrors the credential's `authenticate`
 * logic; duplicated here (rather than `httpRequestWithAuthentication`) so the
 * export path is a pure function testable without an n8n runtime — the spike
 * verdict depends on trusting this exact request shape.
 */
export function buildExportTarget(credential: OtlpCredential): {
	url: string;
	headers: Record<string, string>;
} {
	const base = (credential.endpointUrl ?? '').replace(/\/+$/, '');
	const url = base.endsWith('/v1/traces') ? base : `${base}/v1/traces`;

	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (credential.authType === 'basicAuth') {
		const token = Buffer.from(`${credential.username ?? ''}:${credential.password ?? ''}`).toString(
			'base64',
		);
		headers.Authorization = `Basic ${token}`;
	} else if (credential.authType === 'apiKeyHeader') {
		if (credential.apiKey) headers[credential.headerName || 'Authorization'] = credential.apiKey;
	} else if (credential.authType === 'customHeaders') {
		let custom: Record<string, string> = {};
		if (typeof credential.customHeaders === 'string') {
			try {
				custom = JSON.parse(credential.customHeaders) as Record<string, string>;
			} catch {
				custom = {};
			}
		} else if (credential.customHeaders && typeof credential.customHeaders === 'object') {
			custom = credential.customHeaders;
		}
		Object.assign(headers, custom);
	}
	return { url, headers };
}

export type HttpPost = (
	url: string,
	headers: Record<string, string>,
	body: object,
) => Promise<unknown>;

/**
 * Fire-and-forget OTLP shipper (spec §"Hand-rolled OTLP/JSON exporter").
 * No timers (scanner bans setTimeout): every completed span triggers a flush.
 * The POST promise is detached and `.catch`-guarded — a slow or down backend
 * can only ever mean dropped spans and an incremented counter, never a
 * workflow failure (PRD §5 failure policy).
 */
export class SpanExporter {
	exportedSpans = 0;

	exportErrors = 0;

	droppedSpans = 0;

	private readonly queue: OtlpSpan[] = [];

	private inFlight = false;

	private static readonly MAX_QUEUE = 200;

	constructor(
		private readonly target: { url: string; headers: Record<string, string> },
		private readonly post: HttpPost,
		private readonly resourceAttributes: Record<string, OtlpAttrValue>,
		private readonly onError?: (message: string) => void,
	) {}

	add(span: OtlpSpan): void {
		if (this.queue.length >= SpanExporter.MAX_QUEUE) {
			this.queue.shift();
			this.droppedSpans++;
		}
		this.queue.push(span);
		this.flush();
	}

	private flush(): void {
		if (this.inFlight || this.queue.length === 0) return;
		const spans = this.queue.splice(0);
		const body = buildExportRequest(this.resourceAttributes, spans);
		this.inFlight = true;
		void Promise.resolve()
			.then(async () => this.post(this.target.url, this.target.headers, body))
			.then(() => {
				this.exportedSpans += spans.length;
			})
			.catch((error: unknown) => {
				this.exportErrors++;
				try {
					this.onError?.(`OTLP export failed: ${String(error).slice(0, 300)}`);
				} catch {
					// onError must never take the workflow down either
				}
			})
			.then(() => {
				this.inFlight = false;
				this.flush();
			});
	}
}
