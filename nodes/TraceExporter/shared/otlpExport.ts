import { sleep as n8nSleep, sleepWithAbort as n8nSleepWithAbort } from 'n8n-workflow';

import { buildExportRequest } from './otlpJson';
import type { OtlpAttrValue, OtlpSpan } from './otlpJson';

/** Decrypted `otlpExporterApi` credential shape (credentials/OtlpExporterApi.credentials.ts). */
export interface OtlpCredential {
	endpointUrl: string;
	preset?: 'langfuse' | 'opik' | 'datadog' | 'custom';
	authType?: 'backendDefault' | 'basicAuth' | 'apiKeyHeader' | 'customHeaders';
	username?: string;
	password?: string;
	apiKey?: string;
	headerName?: string;
	customHeaders?: string | Record<string, unknown>;
	opikWorkspace?: string;
	opikProjectName?: string;
	datadogMlApp?: string;
}

export type ResolvedAuthType = 'basicAuth' | 'apiKeyHeader' | 'customHeaders';

/**
 * Keep authentication explicit and backward compatible. Existing credentials
 * retain their stored authType; only the new Backend Default choice derives a
 * mode from the selected backend. Missing authType uses the pre-0.1.5 defaults.
 */
export function resolveAuthType(credential: OtlpCredential): ResolvedAuthType {
	if (credential.authType && credential.authType !== 'backendDefault') return credential.authType;
	if (credential.authType === undefined) {
		if (credential.preset === 'opik') return 'apiKeyHeader';
		return 'basicAuth';
	}
	if (credential.preset === 'langfuse') return 'basicAuth';
	if (credential.preset === 'opik') return 'apiKeyHeader';
	return 'customHeaders';
}

export function resolveApiKeyHeaderName(credential: OtlpCredential): string {
	if (credential.authType === 'backendDefault' && credential.preset === 'opik') {
		return 'Authorization';
	}
	return credential.headerName || 'Authorization';
}

/** Parse only primitive header values; objects cannot be valid HTTP headers. */
export function parseAdditionalHeaders(raw: unknown): Record<string, string> {
	let parsed: unknown = raw;
	if (typeof raw === 'string') {
		try {
			parsed = JSON.parse(raw);
		} catch {
			return {};
		}
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
	const headers: Record<string, string> = {};
	for (const [key, value] of Object.entries(parsed)) {
		if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
			headers[key] = String(value);
		}
	}
	return headers;
}

/** Routing headers required by backends that accept this node's OTLP/JSON directly. */
export function presetHeaders(credential: OtlpCredential): Record<string, string> {
	if (credential.preset === 'langfuse') {
		return { 'x-langfuse-ingestion-version': '4' };
	}
	if (credential.preset === 'opik') {
		return {
			...(credential.opikWorkspace ? { 'Comet-Workspace': credential.opikWorkspace } : {}),
			...(credential.opikProjectName ? { projectName: credential.opikProjectName } : {}),
		};
	}
	return {};
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
	backend: NonNullable<OtlpCredential['preset']>;
} {
	const endpoint = credential.endpointUrl ?? '';
	const suffixIndex = endpoint.search(/[?#]/);
	const rawPath = suffixIndex === -1 ? endpoint : endpoint.slice(0, suffixIndex);
	const suffix = suffixIndex === -1 ? '' : endpoint.slice(suffixIndex);
	const base = rawPath.replace(/\/+$/, '');
	const url = `${base.endsWith('/v1/traces') ? base : `${base}/v1/traces`}${suffix}`;

	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
		...presetHeaders(credential),
	};
	const authType = resolveAuthType(credential);
	if (authType === 'basicAuth') {
		const token = Buffer.from(`${credential.username ?? ''}:${credential.password ?? ''}`).toString(
			'base64',
		);
		headers.Authorization = `Basic ${token}`;
	} else if (authType === 'apiKeyHeader') {
		const headerName = resolveApiKeyHeaderName(credential);
		if (credential.apiKey) headers[headerName] = credential.apiKey;
	}
	// Additional headers are additive for every auth mode and intentionally
	// applied last so advanced/self-hosted deployments can override defaults.
	Object.assign(headers, parseAdditionalHeaders(credential.customHeaders));
	return { url, headers, backend: credential.preset ?? 'custom' };
}

export type HttpPost = (
	url: string,
	headers: Record<string, string>,
	body: object,
) => Promise<unknown>;

export interface SpanExporterOptions {
	/** Maximum spans retained while a backend is unavailable. Oldest spans are dropped first. */
	maxQueueSpans?: number;
	/** Maximum serialized span bytes retained in the local queue. */
	maxQueueBytes?: number;
	/** Maximum spans sent in one OTLP request. */
	maxBatchSpans?: number;
	/** Maximum estimated serialized OTLP request size. Oversized individual spans are dropped. */
	maxBatchBytes?: number;
	/** Total attempts, including the initial request. */
	maxAttempts?: number;
	initialBackoffMs?: number;
	maxBackoffMs?: number;
	/** Upper safety bound for a server-provided Retry-After delay. */
	maxRetryAfterMs?: number;
	jitterRatio?: number;
	defaultFlushTimeoutMs?: number;
	/** Test seam; production uses n8n-workflow's scanner-safe sleep helper. */
	sleep?: (milliseconds: number) => Promise<void>;
	/** Test seam for deterministic jitter. */
	random?: () => number;
	/** Test seam for HTTP-date Retry-After. */
	now?: () => number;
}

export interface SpanAddOptions {
	/** Send this span as a singleton request, acting as a barrier on both sides of the queue. */
	isolated?: boolean;
}

export type SpanDropReason =
	| 'exporter_closed'
	| 'global_request_queue_full'
	| 'queue_bytes'
	| 'queue_spans'
	| 'span_too_large';

export type SpanExporterFailureCategory =
	| 'http'
	| 'network'
	| 'partial_success'
	| 'request_queue'
	| 'retry_delay'
	| 'serialization'
	| 'unknown';

export interface SpanExporterDiagnostics {
	queuedSpans: number;
	queuedBytes: number;
	inFlight: boolean;
	exportedSpans: number;
	exportedBatches: number;
	exportAttempts: number;
	retryAttempts: number;
	exportErrors: number;
	failedSpans: number;
	partialSuccessBatches: number;
	rejectedSpans: number;
	droppedSpans: number;
	flushTimeouts: number;
	lastStatusCode?: number;
	lastError?: string;
	lastErrorCategory?: SpanExporterFailureCategory;
	lastDropReason?: SpanDropReason;
}

interface ResolvedSpanExporterOptions {
	maxQueueSpans: number;
	maxQueueBytes: number;
	maxBatchSpans: number;
	maxBatchBytes: number;
	maxAttempts: number;
	initialBackoffMs: number;
	maxBackoffMs: number;
	maxRetryAfterMs: number;
	jitterRatio: number;
	defaultFlushTimeoutMs: number;
	sleep: (milliseconds: number) => Promise<void>;
	random: () => number;
	now: () => number;
}

interface QueuedSpan {
	span: OtlpSpan;
	serializedBytes: number;
	isolated: boolean;
}

interface PartialSuccess {
	rejectedSpans: number;
	hasErrorMessage: boolean;
}

interface IdleWaiter {
	resolve: (flushed: boolean) => void;
}

const DEFAULT_MAX_QUEUE_SPANS = 200;
const DEFAULT_MAX_QUEUE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_BATCH_SPANS = 64;
const DEFAULT_MAX_BATCH_BYTES = 512 * 1024;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_INITIAL_BACKOFF_MS = 250;
const DEFAULT_MAX_BACKOFF_MS = 5_000;
const DEFAULT_MAX_RETRY_AFTER_MS = 30_000;
const DEFAULT_JITTER_RATIO = 0.2;
const DEFAULT_FLUSH_TIMEOUT_MS = 5_000;

const RETRYABLE_HTTP_STATUSES = new Set([429, 502, 503, 504]);
const RETRYABLE_NETWORK_CODES = new Set([
	'EAI_AGAIN',
	'ECONNABORTED',
	'ECONNREFUSED',
	'ECONNRESET',
	'ENETDOWN',
	'ENETUNREACH',
	'ENOTFOUND',
	'EPIPE',
	'ETIMEDOUT',
	'UND_ERR_CONNECT_TIMEOUT',
	'UND_ERR_HEADERS_TIMEOUT',
	'UND_ERR_SOCKET',
]);

function positiveInteger(value: number | undefined, fallback: number): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return fallback;
	return Math.floor(value);
}

function nonNegativeNumber(value: number | undefined, fallback: number): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback;
	return value;
}

function resolveOptions(options: SpanExporterOptions): ResolvedSpanExporterOptions {
	const maxQueueSpans = positiveInteger(options.maxQueueSpans, DEFAULT_MAX_QUEUE_SPANS);
	const maxQueueBytes = positiveInteger(options.maxQueueBytes, DEFAULT_MAX_QUEUE_BYTES);
	const maxBatchSpans = Math.min(
		positiveInteger(options.maxBatchSpans, DEFAULT_MAX_BATCH_SPANS),
		maxQueueSpans,
	);
	const maxBatchBytes = Math.min(
		positiveInteger(options.maxBatchBytes, DEFAULT_MAX_BATCH_BYTES),
		maxQueueBytes,
	);
	const initialBackoffMs = nonNegativeNumber(options.initialBackoffMs, DEFAULT_INITIAL_BACKOFF_MS);
	const maxBackoffMs = Math.max(
		initialBackoffMs,
		nonNegativeNumber(options.maxBackoffMs, DEFAULT_MAX_BACKOFF_MS),
	);
	return {
		maxQueueSpans,
		maxQueueBytes,
		maxBatchSpans,
		maxBatchBytes,
		maxAttempts: positiveInteger(options.maxAttempts, DEFAULT_MAX_ATTEMPTS),
		initialBackoffMs,
		maxBackoffMs,
		maxRetryAfterMs: nonNegativeNumber(options.maxRetryAfterMs, DEFAULT_MAX_RETRY_AFTER_MS),
		jitterRatio: Math.min(1, nonNegativeNumber(options.jitterRatio, DEFAULT_JITTER_RATIO)),
		defaultFlushTimeoutMs: nonNegativeNumber(
			options.defaultFlushTimeoutMs,
			DEFAULT_FLUSH_TIMEOUT_MS,
		),
		sleep: options.sleep ?? n8nSleep,
		random: options.random ?? Math.random,
		now: options.now ?? Date.now,
	};
}

class RequestQueueFullError extends Error {
	readonly code = 'OTLP_GLOBAL_REQUEST_QUEUE_FULL';
}

/**
 * One package-level limiter prevents many concurrent n8n executions from
 * independently opening an unbounded number of collector connections. Each
 * SpanExporter is serial already; this limiter bounds concurrency across all
 * exporters in the worker process and caps its own pending queue.
 */
class GlobalRequestLimiter {
	private activeRequests = 0;

	private readonly pending: Array<{
		task: () => Promise<unknown>;
		resolve: (value: unknown) => void;
		reject: (reason: unknown) => void;
	}> = [];

	constructor(
		private readonly maxConcurrentRequests: number,
		private readonly maxPendingRequests: number,
	) {}

	run(task: () => Promise<unknown>): Promise<unknown> {
		return new Promise((resolve, reject) => {
			if (this.activeRequests < this.maxConcurrentRequests) {
				this.start({ task, resolve, reject });
				return;
			}
			if (this.pending.length >= this.maxPendingRequests) {
				reject(new RequestQueueFullError('The process-wide OTLP request queue is full'));
				return;
			}
			this.pending.push({ task, resolve, reject });
		});
	}

	private start(job: {
		task: () => Promise<unknown>;
		resolve: (value: unknown) => void;
		reject: (reason: unknown) => void;
	}): void {
		this.activeRequests++;
		void Promise.resolve()
			.then(job.task)
			.then(job.resolve, job.reject)
			.then(() => {
				this.activeRequests--;
				const next = this.pending.shift();
				if (next) this.start(next);
			});
	}
}

const GLOBAL_REQUEST_LIMITER = new GlobalRequestLimiter(4, 256);

/**
 * Best-effort HTTP status from a rejected POST. n8n's `httpRequest` error
 * shape varies by version/transport — `httpCode` (a string on NodeApiError),
 * `statusCode`, `response.status`, or an axios-style `cause.response.status`
 * — so probe them all defensively; undefined when none yields a number.
 */
function statusCodeFrom(error: unknown): number | undefined {
	try {
		if (error === null || typeof error !== 'object') return undefined;
		const e = error as {
			httpCode?: unknown;
			statusCode?: unknown;
			response?: { status?: unknown } | null;
			cause?: { response?: { status?: unknown } | null } | null;
		};
		const candidates = [e.httpCode, e.statusCode, e.response?.status, e.cause?.response?.status];
		for (const candidate of candidates) {
			const parsed = typeof candidate === 'string' ? Number(candidate) : candidate;
			if (typeof parsed === 'number' && Number.isFinite(parsed)) return parsed;
		}
	} catch {
		// hostile error object — status stays unknown
	}
	return undefined;
}

function errorCodeFrom(error: unknown): string | undefined {
	try {
		if (error === null || typeof error !== 'object') return undefined;
		const e = error as { code?: unknown; cause?: { code?: unknown } | null };
		const code = e.code ?? e.cause?.code;
		return typeof code === 'string' ? code.toUpperCase() : undefined;
	} catch {
		return undefined;
	}
}

function safeFailureFrom(
	error: unknown,
	statusCode: number | undefined,
	category?: SpanExporterFailureCategory,
): { category: SpanExporterFailureCategory; description: string } {
	if (category === 'serialization') {
		return { category, description: 'request serialization failed' };
	}
	if (category === 'retry_delay') {
		return { category, description: 'retry delay failed' };
	}
	if (error instanceof RequestQueueFullError) {
		return { category: 'request_queue', description: 'process request queue full' };
	}
	if (statusCode !== undefined) {
		return { category: 'http', description: `HTTP ${statusCode}` };
	}
	const code = errorCodeFrom(error);
	if (code !== undefined && RETRYABLE_NETWORK_CODES.has(code)) {
		return { category: 'network', description: `network ${code}` };
	}
	return { category: 'unknown', description: 'unknown transport error' };
}

function isRetryableNetworkError(error: unknown): boolean {
	const code = errorCodeFrom(error);
	return code !== undefined && RETRYABLE_NETWORK_CODES.has(code);
}

function headerValue(headers: unknown, name: string): string | undefined {
	try {
		if (headers === null || typeof headers !== 'object') return undefined;
		const withGet = headers as { get?: (key: string) => unknown };
		if (typeof withGet.get === 'function') {
			const value = withGet.get(name);
			if (typeof value === 'string') return value;
		}
		for (const [key, value] of Object.entries(headers)) {
			if (key.toLowerCase() !== name.toLowerCase()) continue;
			if (typeof value === 'string' || typeof value === 'number') return String(value);
			if (Array.isArray(value) && value.length > 0) return String(value[0]);
		}
	} catch {
		// Hostile response headers are treated as absent.
	}
	return undefined;
}

function retryAfterFrom(error: unknown, now: number): number | undefined {
	try {
		if (error === null || typeof error !== 'object') return undefined;
		const e = error as {
			headers?: unknown;
			response?: { headers?: unknown } | null;
			cause?: { response?: { headers?: unknown } | null } | null;
		};
		const raw =
			headerValue(e.headers, 'retry-after') ??
			headerValue(e.response?.headers, 'retry-after') ??
			headerValue(e.cause?.response?.headers, 'retry-after');
		if (raw === undefined) return undefined;
		const trimmed = raw.trim();
		if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1_000;
		const at = Date.parse(trimmed);
		if (!Number.isFinite(at)) return undefined;
		return Math.max(0, at - now);
	} catch {
		return undefined;
	}
}

function objectFrom(value: unknown): Record<string, unknown> | undefined {
	if (typeof value === 'string') {
		try {
			const parsed = JSON.parse(value) as unknown;
			return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
				? (parsed as Record<string, unknown>)
				: undefined;
		} catch {
			return undefined;
		}
	}
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function partialSuccessFrom(response: unknown): PartialSuccess | undefined {
	try {
		const outer = objectFrom(response);
		if (!outer) return undefined;
		const responseBody = objectFrom(outer.body) ?? objectFrom(outer.data) ?? outer;
		const raw = responseBody.partialSuccess ?? responseBody.partial_success;
		const partial = objectFrom(raw);
		if (!partial) return undefined;
		const rawRejected = partial.rejectedSpans ?? partial.rejected_spans ?? 0;
		const parsedRejected =
			typeof rawRejected === 'number' ? rawRejected : Number(String(rawRejected));
		const rejectedSpans =
			Number.isFinite(parsedRejected) && parsedRejected > 0 ? Math.floor(parsedRejected) : 0;
		const rawMessage = partial.errorMessage ?? partial.error_message;
		return {
			rejectedSpans,
			hasErrorMessage: typeof rawMessage === 'string' && rawMessage.length > 0,
		};
	} catch {
		return undefined;
	}
}

/**
 * Best-effort OTLP/HTTP JSON shipper. Synchronous adds are coalesced in the
 * same microtask, then split by both span count and serialized request size.
 * Delivery stays detached from the workflow, but forceFlush/close let callers
 * explicitly wait for a bounded acknowledgement window.
 */
export class SpanExporter {
	exportedSpans = 0;

	exportedBatches = 0;

	exportAttempts = 0;

	retryAttempts = 0;

	exportErrors = 0;

	failedSpans = 0;

	partialSuccessBatches = 0;

	rejectedSpans = 0;

	droppedSpans = 0;

	flushTimeouts = 0;

	private readonly queue: QueuedSpan[] = [];

	private readonly options: ResolvedSpanExporterOptions;

	private readonly emptyRequestBytes: number;

	private queuedBytes = 0;

	private drainRunning = false;

	private closed = false;

	private lastStatusCode?: number;

	private lastError?: string;

	private lastErrorCategory?: SpanExporterFailureCategory;

	private lastDropReason?: SpanDropReason;

	private readonly idleWaiters = new Set<IdleWaiter>();

	constructor(
		private readonly target: {
			url: string;
			headers: Record<string, string>;
			backend?: NonNullable<OtlpCredential['preset']>;
		},
		private readonly post: HttpPost,
		private readonly resourceAttributes: Record<string, OtlpAttrValue>,
		private readonly onError?: (message: string) => void,
		private readonly onBatchFailed?: (spans: OtlpSpan[], statusCode?: number) => void,
		private readonly onDrop?: (totalDropped: number) => void,
		options: SpanExporterOptions = {},
	) {
		this.options = resolveOptions(options);
		try {
			this.emptyRequestBytes = Buffer.byteLength(
				JSON.stringify(buildExportRequest(this.resourceAttributes, [])),
				'utf8',
			);
		} catch {
			// Preserve add()'s never-throw contract for malformed runtime input.
			// Body construction will be reported as a final export error later.
			this.emptyRequestBytes = 0;
		}
	}

	add(span: OtlpSpan, options: SpanAddOptions = {}): void {
		try {
			if (this.closed) {
				this.recordDrop('exporter_closed');
				return;
			}
			// buildExportRequest supplies the sampled flag when the span omits it;
			// include that exact wire shape in both queue and batch byte budgets.
			const serializedBytes = Buffer.byteLength(
				JSON.stringify({ ...span, flags: span.flags ?? 1 }),
				'utf8',
			);
			if (
				serializedBytes > this.options.maxQueueBytes ||
				this.estimatedRequestBytes(serializedBytes, 1) > this.options.maxBatchBytes
			) {
				this.recordDrop('span_too_large');
				return;
			}

			while (
				this.queue.length > 0 &&
				(this.queue.length >= this.options.maxQueueSpans ||
					this.queuedBytes + serializedBytes > this.options.maxQueueBytes)
			) {
				const reason: SpanDropReason =
					this.queue.length >= this.options.maxQueueSpans ? 'queue_spans' : 'queue_bytes';
				const dropped = this.queue.shift();
				if (dropped) this.queuedBytes -= dropped.serializedBytes;
				this.recordDrop(reason);
			}

			if (
				this.queue.length >= this.options.maxQueueSpans ||
				this.queuedBytes + serializedBytes > this.options.maxQueueBytes
			) {
				this.recordDrop(
					this.queue.length >= this.options.maxQueueSpans ? 'queue_spans' : 'queue_bytes',
				);
				return;
			}

			this.queue.push({ span, serializedBytes, isolated: options.isolated === true });
			this.queuedBytes += serializedBytes;
			this.startDrain();
		} catch (error) {
			// A hostile span object must not escape into the workflow execution.
			this.recordFinalFailure([span], error, undefined, 'serialization');
		}
	}

	getDiagnostics(): Readonly<SpanExporterDiagnostics> {
		return {
			queuedSpans: this.queue.length,
			queuedBytes: this.queuedBytes,
			inFlight: this.drainRunning,
			exportedSpans: this.exportedSpans,
			exportedBatches: this.exportedBatches,
			exportAttempts: this.exportAttempts,
			retryAttempts: this.retryAttempts,
			exportErrors: this.exportErrors,
			failedSpans: this.failedSpans,
			partialSuccessBatches: this.partialSuccessBatches,
			rejectedSpans: this.rejectedSpans,
			droppedSpans: this.droppedSpans,
			flushTimeouts: this.flushTimeouts,
			...(this.lastStatusCode !== undefined ? { lastStatusCode: this.lastStatusCode } : {}),
			...(this.lastError !== undefined ? { lastError: this.lastError } : {}),
			...(this.lastErrorCategory !== undefined
				? { lastErrorCategory: this.lastErrorCategory }
				: {}),
			...(this.lastDropReason !== undefined ? { lastDropReason: this.lastDropReason } : {}),
		};
	}

	/** Wait until queued and in-flight batches settle, without waiting forever. */
	async forceFlush(timeoutMs = this.options.defaultFlushTimeoutMs): Promise<boolean> {
		this.startDrain();
		if (this.isIdle()) return true;
		const boundedTimeout = nonNegativeNumber(timeoutMs, this.options.defaultFlushTimeoutMs);
		if (boundedTimeout === 0) {
			this.flushTimeouts++;
			return false;
		}

		const waiter: IdleWaiter = { resolve: () => {} };
		const idle = new Promise<boolean>((resolve) => {
			waiter.resolve = resolve;
			this.idleWaiters.add(waiter);
		});
		const timeoutController = new AbortController();
		const timedOut = n8nSleepWithAbort(boundedTimeout, timeoutController.signal).then(
			() => false,
			() => false,
		);
		const flushed = await Promise.race([idle, timedOut]);
		if (flushed) timeoutController.abort();
		else {
			this.idleWaiters.delete(waiter);
			this.flushTimeouts++;
		}
		return flushed;
	}

	/** Reject future adds, then perform the same bounded flush as forceFlush. */
	async close(timeoutMs = this.options.defaultFlushTimeoutMs): Promise<boolean> {
		this.closed = true;
		return await this.forceFlush(timeoutMs);
	}

	private isIdle(): boolean {
		return !this.drainRunning && this.queue.length === 0;
	}

	private resolveIdleWaiters(): void {
		if (!this.isIdle()) return;
		for (const waiter of this.idleWaiters) waiter.resolve(true);
		this.idleWaiters.clear();
	}

	private startDrain(): void {
		if (this.drainRunning || this.queue.length === 0) return;
		this.drainRunning = true;
		void Promise.resolve()
			.then(async () => {
				while (this.queue.length > 0) {
					const batch = this.takeBatch();
					if (batch.length === 0) break;
					await this.exportBatch(batch);
				}
			})
			.catch((error: unknown) => {
				// Defensive backstop: exportBatch handles all expected failures.
				this.recordFinalFailure([], error);
			})
			.then(() => {
				this.drainRunning = false;
				if (this.queue.length > 0) this.startDrain();
				else this.resolveIdleWaiters();
			});
	}

	private estimatedRequestBytes(serializedSpanBytes: number, spanCount: number): number {
		return this.emptyRequestBytes + serializedSpanBytes + Math.max(0, spanCount - 1);
	}

	private takeBatch(): OtlpSpan[] {
		const batch: OtlpSpan[] = [];
		let spanBytes = 0;
		while (batch.length < this.options.maxBatchSpans && this.queue.length > 0) {
			const next = this.queue[0];
			if (batch.length > 0 && next.isolated) break;
			const nextBytes = spanBytes + next.serializedBytes;
			if (
				batch.length > 0 &&
				this.estimatedRequestBytes(nextBytes, batch.length + 1) > this.options.maxBatchBytes
			) {
				break;
			}
			this.queue.shift();
			this.queuedBytes -= next.serializedBytes;
			batch.push(next.span);
			spanBytes = nextBytes;
			if (next.isolated) break;
		}
		return batch;
	}

	private async exportBatch(spans: OtlpSpan[]): Promise<void> {
		let body: object;
		try {
			body = buildExportRequest(this.resourceAttributes, spans);
		} catch (error) {
			this.recordFinalFailure(spans, error, undefined, 'serialization');
			return;
		}

		for (let attempt = 1; attempt <= this.options.maxAttempts; attempt++) {
			this.exportAttempts++;
			try {
				const response = await GLOBAL_REQUEST_LIMITER.run(
					async () => await this.post(this.target.url, this.target.headers, body),
				);
				this.recordSuccess(spans, response);
				return;
			} catch (error) {
				const statusCode = statusCodeFrom(error);
				const retryable =
					(statusCode !== undefined && RETRYABLE_HTTP_STATUSES.has(statusCode)) ||
					(statusCode === undefined && isRetryableNetworkError(error));
				if (!retryable || attempt >= this.options.maxAttempts) {
					this.recordFinalFailure(spans, error, statusCode);
					return;
				}
				this.retryAttempts++;
				const retryAfter = retryAfterFrom(error, this.options.now());
				const delay =
					retryAfter === undefined
						? this.exponentialBackoff(attempt)
						: Math.min(retryAfter, this.options.maxRetryAfterMs);
				try {
					await this.options.sleep(delay);
				} catch (sleepError) {
					this.recordFinalFailure(spans, sleepError, statusCode, 'retry_delay');
					return;
				}
			}
		}
	}

	private exponentialBackoff(failedAttempt: number): number {
		const exponential = Math.min(
			this.options.maxBackoffMs,
			this.options.initialBackoffMs * 2 ** Math.max(0, failedAttempt - 1),
		);
		const random = Math.min(1, Math.max(0, this.options.random()));
		const multiplier = 1 + (random * 2 - 1) * this.options.jitterRatio;
		return Math.min(this.options.maxBackoffMs, Math.max(0, Math.round(exponential * multiplier)));
	}

	private recordSuccess(spans: OtlpSpan[], response: unknown): void {
		const partial = partialSuccessFrom(response);
		this.exportedBatches++;
		if (!partial) {
			this.exportedSpans += spans.length;
			return;
		}

		this.partialSuccessBatches++;
		this.rejectedSpans += partial.rejectedSpans;
		this.exportedSpans += Math.max(0, spans.length - partial.rejectedSpans);
		if (partial.rejectedSpans > 0 || partial.hasErrorMessage) {
			this.exportErrors++;
			this.lastErrorCategory = 'partial_success';
			this.lastError =
				partial.rejectedSpans > 0
					? `${partial.rejectedSpans} span(s) rejected by collector`
					: 'collector reported partial success';
			this.reportError(`OTLP export partially accepted: ${this.lastError}`);
		}
	}

	private recordFinalFailure(
		spans: OtlpSpan[],
		error: unknown,
		statusCode = statusCodeFrom(error),
		category?: SpanExporterFailureCategory,
	): void {
		this.exportErrors++;
		this.failedSpans += spans.length;
		this.lastStatusCode = statusCode;
		const safeFailure = safeFailureFrom(error, statusCode, category);
		this.lastErrorCategory = safeFailure.category;
		this.lastError = safeFailure.description;
		if (error instanceof RequestQueueFullError) this.lastDropReason = 'global_request_queue_full';
		this.reportError(`OTLP export failed (${this.lastError})`);
		try {
			// Opik uses 409 to signal that a re-emitted synthetic root already
			// exists. Preserve that root-specific suppression only for an explicit
			// Opik preset. Other backends still expose 409 in diagnostics but the
			// legacy callback receives no 409 sentinel, so it may retry the root.
			const callbackStatus =
				statusCode === 409 && this.target.backend !== 'opik' ? undefined : statusCode;
			this.onBatchFailed?.(spans, callbackStatus);
		} catch {
			// Failure feedback must never take down the workflow.
		}
	}

	private reportError(message: string): void {
		try {
			this.onError?.(message);
		} catch {
			// Failure feedback must never take down the workflow.
		}
	}

	private recordDrop(reason: SpanDropReason): void {
		this.droppedSpans++;
		this.lastDropReason = reason;
		try {
			this.onDrop?.(this.droppedSpans);
		} catch {
			// Drop feedback must never take down the workflow.
		}
	}
}
