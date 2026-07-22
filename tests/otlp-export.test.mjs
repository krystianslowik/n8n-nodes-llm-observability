import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExportTarget, SpanExporter } from '../dist/nodes/TraceExporter/shared/otlpExport.js';

function span(name = 's') {
	return {
		traceId: 'a'.repeat(32),
		spanId: 'b'.repeat(16),
		name,
		kind: 3,
		startTimeUnixNano: '1',
		endTimeUnixNano: '2',
		attributes: [],
		status: { code: 1 },
	};
}

const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

test('buildExportTarget appends /v1/traces exactly once', () => {
	assert.equal(
		buildExportTarget({
			endpointUrl: 'http://localhost:5173/api/v1/private/otel',
			authType: 'customHeaders',
		}).url,
		'http://localhost:5173/api/v1/private/otel/v1/traces',
	);
	assert.equal(
		buildExportTarget({ endpointUrl: 'http://x/otel/v1/traces/', authType: 'customHeaders' }).url,
		'http://x/otel/v1/traces',
	);
	assert.equal(
		buildExportTarget({
			endpointUrl: 'https://host/base/?x=1#collector',
			authType: 'customHeaders',
		}).url,
		'https://host/base/v1/traces?x=1#collector',
	);
	assert.equal(
		buildExportTarget({
			endpointUrl: 'https://host/base/v1/traces/?x=1',
			authType: 'customHeaders',
		}).url,
		'https://host/base/v1/traces?x=1',
	);
});

test('buildExportTarget builds Basic auth header', () => {
	const { headers } = buildExportTarget({
		endpointUrl: 'http://x',
		authType: 'basicAuth',
		username: 'pk',
		password: 'sk',
	});
	assert.equal(headers.Authorization, `Basic ${Buffer.from('pk:sk').toString('base64')}`);
	assert.equal(headers['Content-Type'], 'application/json');
});

test('buildExportTarget builds API-key header under a custom name', () => {
	const { headers } = buildExportTarget({
		endpointUrl: 'http://x',
		authType: 'apiKeyHeader',
		apiKey: 'k-123',
		headerName: 'DD-API-KEY',
	});
	assert.equal(headers['DD-API-KEY'], 'k-123');
});

test('buildExportTarget parses custom headers from a JSON string, tolerates garbage', () => {
	const good = buildExportTarget({
		endpointUrl: 'http://x',
		authType: 'customHeaders',
		customHeaders: '{"x-api-key":"v"}',
	});
	assert.equal(good.headers['x-api-key'], 'v');
	const bad = buildExportTarget({
		endpointUrl: 'http://x',
		authType: 'customHeaders',
		customHeaders: 'not json',
	});
	assert.equal(bad.headers['Content-Type'], 'application/json');
});

test('backend defaults add required routing and auth without overriding explicit auth', () => {
	const langfuse = buildExportTarget({
		endpointUrl: 'http://x',
		preset: 'langfuse',
		authType: 'backendDefault',
		username: 'pk',
		password: 'sk',
	});
	assert.equal(langfuse.headers['x-langfuse-ingestion-version'], '4');
	assert.match(langfuse.headers.Authorization, /^Basic /);

	const opik = buildExportTarget({
		endpointUrl: 'http://x',
		preset: 'opik',
		authType: 'backendDefault',
		apiKey: 'opik-key',
		headerName: 'wrong-header',
		opikWorkspace: 'workspace-a',
		opikProjectName: 'project-a',
		customHeaders: { projectName: 'override-project', ignored: { nested: true } },
	});
	assert.equal(opik.headers.Authorization, 'opik-key');
	assert.equal(opik.headers['wrong-header'], undefined);
	assert.equal(opik.headers['Comet-Workspace'], 'workspace-a');
	assert.equal(opik.headers.projectName, 'override-project');
	assert.equal(opik.headers.ignored, undefined, 'non-primitive headers are ignored');

	const datadog = buildExportTarget({
		endpointUrl: 'http://x',
		preset: 'datadog',
		authType: 'backendDefault',
		apiKey: 'dd-key',
		headerName: 'x-collector-key',
		datadogMlApp: 'support-agent',
	});
	assert.equal(datadog.headers.Authorization, undefined);
	assert.equal(datadog.headers['x-collector-key'], undefined);
	assert.equal(datadog.headers['dd-api-key'], undefined);
	assert.equal(datadog.headers['dd-otlp-source'], undefined);
	assert.equal(datadog.headers['dd-ml-app'], undefined);

	const explicitOpikProxy = buildExportTarget({
		endpointUrl: 'http://x',
		preset: 'opik',
		authType: 'basicAuth',
		username: 'proxy-user',
		password: 'proxy-secret',
		opikWorkspace: 'workspace-b',
	});
	assert.equal(
		explicitOpikProxy.headers.Authorization,
		`Basic ${Buffer.from('proxy-user:proxy-secret').toString('base64')}`,
	);
	assert.equal(explicitOpikProxy.headers['Comet-Workspace'], 'workspace-b');
});

test('missing authType keeps legacy defaults for stored credentials', () => {
	const legacyGeneric = buildExportTarget({
		endpointUrl: 'http://x',
		preset: 'custom',
		username: 'legacy-user',
		password: 'legacy-secret',
	});
	assert.equal(
		legacyGeneric.headers.Authorization,
		`Basic ${Buffer.from('legacy-user:legacy-secret').toString('base64')}`,
	);

	const legacyOpik = buildExportTarget({
		endpointUrl: 'http://x',
		preset: 'opik',
		apiKey: 'legacy-opik-key',
		opikWorkspace: 'workspace',
	});
	assert.equal(legacyOpik.headers.Authorization, 'legacy-opik-key');
});

async function waitFor(predicate, message = 'condition was not reached') {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (predicate()) return;
		await flushMicrotasks();
	}
	assert.fail(message);
}

test('buildExportTarget carries the explicit backend preset into delivery policy', () => {
	assert.equal(
		buildExportTarget({ endpointUrl: 'http://x', preset: 'opik', authType: 'customHeaders' })
			.backend,
		'opik',
	);
	assert.equal(
		buildExportTarget({ endpointUrl: 'http://x', authType: 'customHeaders' }).backend,
		'custom',
	);
});

test('SpanExporter posts an OTLP body and exposes delivery diagnostics', async () => {
	const calls = [];
	const exporter = new SpanExporter(
		{ url: 'http://x/v1/traces', headers: { h: '1' } },
		async (url, headers, body) => {
			calls.push({ url, headers, body });
		},
		{ 'service.name': 'n8n-trace-exporter' },
	);
	exporter.add(span());
	assert.equal(await exporter.forceFlush(1_000), true);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, 'http://x/v1/traces');
	assert.equal(calls[0].body.resourceSpans[0].scopeSpans[0].spans.length, 1);
	assert.equal(exporter.exportedSpans, 1);
	assert.equal(exporter.exportErrors, 0);
	assert.deepEqual(exporter.getDiagnostics(), {
		queuedSpans: 0,
		queuedBytes: 0,
		inFlight: false,
		exportedSpans: 1,
		exportedBatches: 1,
		exportAttempts: 1,
		retryAttempts: 0,
		exportErrors: 0,
		failedSpans: 0,
		partialSuccessBatches: 0,
		rejectedSpans: 0,
		droppedSpans: 0,
		flushTimeouts: 0,
	});
});

test('SpanExporter swallows non-retryable post failures and never creates an unhandled rejection', async () => {
	const errors = [];
	let attempts = 0;
	let unhandled = 0;
	const onUnhandled = () => unhandled++;
	process.on('unhandledRejection', onUnhandled);
	try {
		const exporter = new SpanExporter(
			{ url: 'http://x', headers: {} },
			async () => {
				attempts++;
				throw new Error('backend down');
			},
			{},
			(message) => errors.push(message),
		);
		exporter.add(span());
		assert.equal(await exporter.forceFlush(1_000), true);
		assert.equal(attempts, 1, 'an unknown error is not assumed to be a network disconnect');
		assert.equal(exporter.exportErrors, 1);
		assert.equal(exporter.exportedSpans, 0);
		assert.equal(exporter.failedSpans, 1);
		assert.equal(errors.length, 1);
		assert.equal(errors[0], 'OTLP export failed (unknown transport error)');
		assert.doesNotMatch(errors[0], /backend down/);
		assert.equal(unhandled, 0);
	} finally {
		process.off('unhandledRejection', onUnhandled);
	}
});

test('SpanExporter never exposes collector error text, response data, or headers', async () => {
	const secret = 'sk-live-secret-echo';
	const errors = [];
	const exporter = new SpanExporter(
		{ url: 'https://collector.example/v1/traces', headers: {} },
		async () => {
			throw Object.assign(new Error(`collector echoed ${secret}`), {
				statusCode: 500,
				response: {
					data: `response body ${secret}`,
					headers: { 'x-debug-secret': secret },
				},
			});
		},
		{},
		(message) => errors.push(message),
	);
	exporter.add(span());
	assert.equal(await exporter.forceFlush(1_000), true);
	const visible = JSON.stringify({ errors, diagnostics: exporter.getDiagnostics() });
	assert.doesNotMatch(visible, new RegExp(secret));
	assert.deepEqual(errors, ['OTLP export failed (HTTP 500)']);
	assert.equal(exporter.getDiagnostics().lastError, 'HTTP 500');
	assert.equal(exporter.getDiagnostics().lastErrorCategory, 'http');
});

test('SpanExporter guards body construction: garbage resourceAttributes never throws into add() and counts an export error', async () => {
	let unhandled = 0;
	const onUnhandled = () => unhandled++;
	process.on('unhandledRejection', onUnhandled);
	try {
		const exporter = new SpanExporter(
			{ url: 'http://x', headers: {} },
			async () => {},
			null, // garbage: buildExportRequest will throw on Object.entries(null)
		);
		assert.doesNotThrow(() => exporter.add(span()));
		assert.equal(await exporter.forceFlush(1_000), true);
		assert.equal(exporter.exportErrors, 1);
		assert.equal(exporter.exportedSpans, 0);
		assert.equal(unhandled, 0);
	} finally {
		process.off('unhandledRejection', onUnhandled);
	}
});

test('SpanExporter coalesces synchronous adds and splits batches by span count', async () => {
	const batchSizes = [];
	const exporter = new SpanExporter(
		{ url: 'http://x', headers: {} },
		async (url, headers, body) => {
			batchSizes.push(body.resourceSpans[0].scopeSpans[0].spans.length);
		},
		{},
		undefined,
		undefined,
		undefined,
		{ maxBatchSpans: 2 },
	);
	for (let index = 0; index < 5; index++) exporter.add(span(`s${index}`));
	assert.equal(await exporter.forceFlush(1_000), true);
	assert.deepEqual(batchSizes, [2, 2, 1]);
	assert.equal(exporter.exportedSpans, 5);
});

test('an isolated span after normal spans is a singleton batch barrier', async () => {
	const batches = [];
	const exporter = new SpanExporter(
		{ url: 'http://x', headers: {} },
		async (url, headers, body) => {
			batches.push(body.resourceSpans[0].scopeSpans[0].spans.map((entry) => entry.name));
		},
		{},
	);
	exporter.add(span('child-before'));
	exporter.add(span('root'), { isolated: true });
	assert.equal(await exporter.forceFlush(1_000), true);
	assert.deepEqual(batches, [['child-before'], ['root']]);
});

test('an isolated span before normal spans is a singleton batch barrier', async () => {
	const batches = [];
	const exporter = new SpanExporter(
		{ url: 'http://x', headers: {} },
		async (url, headers, body) => {
			batches.push(body.resourceSpans[0].scopeSpans[0].spans.map((entry) => entry.name));
		},
		{},
	);
	exporter.add(span('root'), { isolated: true });
	exporter.add(span('child-after'));
	assert.equal(await exporter.forceFlush(1_000), true);
	assert.deepEqual(batches, [['root'], ['child-after']]);
});

test('an Opik duplicate-root 409 cannot fail child spans queued after the isolated root', async () => {
	const batches = [];
	const failures = [];
	const exporter = new SpanExporter(
		{ url: 'http://x', headers: {}, backend: 'opik' },
		async (url, headers, body) => {
			const names = body.resourceSpans[0].scopeSpans[0].spans.map((entry) => entry.name);
			batches.push(names);
			if (names[0] === 'root') {
				throw Object.assign(new Error('duplicate root'), { statusCode: 409 });
			}
		},
		{},
		undefined,
		(spans, statusCode) => failures.push([spans.map((entry) => entry.name), statusCode]),
	);
	exporter.add(span('root'), { isolated: true });
	exporter.add(span('child-after'));
	assert.equal(await exporter.forceFlush(1_000), true);
	assert.deepEqual(batches, [['root'], ['child-after']]);
	assert.deepEqual(failures, [[['root'], 409]]);
	assert.equal(exporter.failedSpans, 1);
	assert.equal(exporter.exportedSpans, 1);
});

test('SpanExporter splits batches by serialized OTLP request bytes', async () => {
	const maxBatchBytes = 900;
	const bodySizes = [];
	const exporter = new SpanExporter(
		{ url: 'http://x', headers: {} },
		async (url, headers, body) => {
			bodySizes.push(Buffer.byteLength(JSON.stringify(body)));
		},
		{},
		undefined,
		undefined,
		undefined,
		{ maxBatchBytes, maxQueueBytes: 10_000, maxBatchSpans: 10 },
	);
	for (let index = 0; index < 3; index++) exporter.add(span(`s${index}-${'x'.repeat(350)}`));
	assert.equal(await exporter.forceFlush(1_000), true);
	assert.ok(bodySizes.length > 1, 'the byte budget should split the synchronous adds');
	assert.ok(
		bodySizes.every((size) => size <= maxBatchBytes),
		JSON.stringify(bodySizes),
	);
	assert.equal(exporter.exportedSpans, 3);
});

test('SpanExporter keeps draining after a failed batch', async () => {
	const calls = [];
	let callCount = 0;
	const exporter = new SpanExporter(
		{ url: 'http://x/v1/traces', headers: {} },
		async (url, headers, body) => {
			callCount++;
			calls.push(body);
			if (callCount === 1) throw new Error('first batch down');
		},
		{},
		undefined,
		undefined,
		undefined,
		{ maxBatchSpans: 1 },
	);
	exporter.add(span('s0'));
	exporter.add(span('s1'));
	exporter.add(span('s2'));
	assert.equal(await exporter.forceFlush(1_000), true);
	assert.equal(exporter.exportErrors, 1, 'only the first batch failed');
	assert.equal(exporter.exportedSpans, 2, 's1 and s2 still made it out after the failure');
	const drainedNames = calls
		.slice(1)
		.flatMap((body) => body.resourceSpans[0].scopeSpans[0].spans.map((s) => s.name));
	assert.deepEqual(
		drainedNames,
		['s1', 's2'],
		'queued spans still get posted after a failed batch',
	);
});

test('SpanExporter never rejects even when onError itself throws; export still counted and queue still drains', async () => {
	let unhandled = 0;
	const onUnhandled = () => unhandled++;
	process.on('unhandledRejection', onUnhandled);
	try {
		const calls = [];
		let callCount = 0;
		const exporter = new SpanExporter(
			{ url: 'http://x', headers: {} },
			async (url, headers, body) => {
				callCount++;
				calls.push(body);
				if (callCount === 1) throw new Error('backend down');
			},
			{},
			() => {
				throw new Error('onError itself is broken');
			},
			undefined,
			undefined,
			{ maxBatchSpans: 1 },
		);
		exporter.add(span('s0'));
		exporter.add(span('s1'));
		assert.equal(await exporter.forceFlush(1_000), true);
		assert.equal(exporter.exportErrors, 1, 'error still counted despite onError throwing');
		assert.equal(exporter.exportedSpans, 1, 's1 still drained after the failed+throwing batch');
		assert.equal(unhandled, 0, 'a throwing onError must never produce an unhandled rejection');
	} finally {
		process.off('unhandledRejection', onUnhandled);
	}
});

test('SpanExporter retries only transient OTLP statuses and respects capped Retry-After', async () => {
	const delays = [];
	let attempts = 0;
	const exporter = new SpanExporter(
		{ url: 'http://x', headers: {} },
		async () => {
			attempts++;
			if (attempts === 1) {
				throw Object.assign(new Error('busy'), {
					statusCode: 503,
					response: { headers: { 'Retry-After': '2' } },
				});
			}
		},
		{},
		undefined,
		undefined,
		undefined,
		{
			maxAttempts: 3,
			maxRetryAfterMs: 1_500,
			sleep: async (milliseconds) => delays.push(milliseconds),
		},
	);
	exporter.add(span());
	await waitFor(() => exporter.exportedSpans === 1);
	assert.equal(attempts, 2);
	assert.deepEqual(delays, [1_500]);
	assert.equal(exporter.retryAttempts, 1);
	assert.equal(exporter.exportErrors, 0);
});

test('SpanExporter retries known network disconnects with capped exponential jitter', async () => {
	const delays = [];
	let attempts = 0;
	const exporter = new SpanExporter(
		{ url: 'http://x', headers: {} },
		async () => {
			attempts++;
			if (attempts < 3) throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
		},
		{},
		undefined,
		undefined,
		undefined,
		{
			maxAttempts: 3,
			initialBackoffMs: 100,
			maxBackoffMs: 150,
			jitterRatio: 0,
			sleep: async (milliseconds) => delays.push(milliseconds),
		},
	);
	exporter.add(span());
	await waitFor(() => exporter.exportedSpans === 1);
	assert.equal(attempts, 3);
	assert.deepEqual(delays, [100, 150]);
	assert.equal(exporter.retryAttempts, 2);
});

test('SpanExporter applies jitter without exceeding the configured backoff cap', async () => {
	const delays = [];
	let attempts = 0;
	const exporter = new SpanExporter(
		{ url: 'http://x', headers: {} },
		async () => {
			attempts++;
			if (attempts === 1) throw Object.assign(new Error('busy'), { statusCode: 429 });
		},
		{},
		undefined,
		undefined,
		undefined,
		{
			initialBackoffMs: 100,
			maxBackoffMs: 120,
			jitterRatio: 0.5,
			random: () => 1,
			sleep: async (milliseconds) => delays.push(milliseconds),
		},
	);
	exporter.add(span());
	await waitFor(() => exporter.exportedSpans === 1);
	assert.deepEqual(delays, [120]);
});

test('SpanExporter does not retry non-transient HTTP failures', async () => {
	for (const statusCode of [400, 401, 409, 500, 501]) {
		let attempts = 0;
		const exporter = new SpanExporter(
			{ url: 'http://x', headers: {}, backend: 'custom' },
			async () => {
				attempts++;
				throw Object.assign(new Error(`HTTP ${statusCode}`), { statusCode });
			},
			{},
			undefined,
			undefined,
			undefined,
			{ maxAttempts: 5, sleep: async () => assert.fail('must not sleep') },
		);
		exporter.add(span());
		await waitFor(() => exporter.exportErrors === 1);
		assert.equal(attempts, 1, `HTTP ${statusCode}`);
	}
});

test('SpanExporter parses OTLP partial success and never retries rejected spans', async () => {
	let attempts = 0;
	const errors = [];
	const secret = 'partial-success-secret';
	const exporter = new SpanExporter(
		{ url: 'http://x', headers: {} },
		async () => {
			attempts++;
			return {
				partialSuccess: { rejectedSpans: '1', errorMessage: `invalid attribute ${secret}` },
			};
		},
		{},
		(message) => errors.push(message),
	);
	exporter.add(span('s0'));
	exporter.add(span('s1'));
	exporter.add(span('s2'));
	assert.equal(await exporter.forceFlush(1_000), true);
	assert.equal(attempts, 1);
	assert.equal(exporter.exportedSpans, 2);
	assert.equal(exporter.rejectedSpans, 1);
	assert.equal(exporter.partialSuccessBatches, 1);
	assert.equal(exporter.exportErrors, 1);
	const visible = JSON.stringify({ errors, diagnostics: exporter.getDiagnostics() });
	assert.doesNotMatch(visible, new RegExp(secret));
	assert.deepEqual(errors, ['OTLP export partially accepted: 1 span(s) rejected by collector']);
	assert.equal(exporter.getDiagnostics().lastErrorCategory, 'partial_success');
});

test('SpanExporter accepts snake_case partial success from a string response body', async () => {
	const exporter = new SpanExporter(
		{ url: 'http://x', headers: {} },
		async () => ({
			body: JSON.stringify({ partial_success: { rejected_spans: 1, error_message: 'nope' } }),
		}),
		{},
	);
	exporter.add(span('s0'));
	exporter.add(span('s1'));
	assert.equal(await exporter.forceFlush(1_000), true);
	assert.equal(exporter.exportedSpans, 1);
	assert.equal(exporter.rejectedSpans, 1);
});

test('onBatchFailed receives n8n HTTP status shapes; 409 root suppression is Opik-only', async () => {
	const shapes = [
		// n8n NodeApiError exposes httpCode as a STRING
		[Object.assign(new Error('conflict'), { httpCode: '409' }), 409],
		[Object.assign(new Error('conflict'), { statusCode: 409 }), 409],
		[Object.assign(new Error('conflict'), { response: { status: 409 } }), 409],
		// axios-style nesting under cause
		[Object.assign(new Error('conflict'), { cause: { response: { status: 409 } } }), 409],
		[new Error('no status anywhere'), undefined],
	];
	for (const [error, expected] of shapes) {
		const received = [];
		const exporter = new SpanExporter(
			{ url: 'http://x', headers: {}, backend: expected === 409 ? 'opik' : 'custom' },
			async () => {
				throw error;
			},
			{},
			undefined,
			(spans, statusCode) => received.push([spans.length, statusCode]),
		);
		exporter.add(span());
		assert.equal(await exporter.forceFlush(1_000), true);
		assert.deepEqual(received, [[1, expected]], `error shape: ${JSON.stringify(error)}`);
	}

	const customReceived = [];
	const custom = new SpanExporter(
		{ url: 'http://x', headers: {}, backend: 'custom' },
		async () => {
			throw Object.assign(new Error('conflict'), { statusCode: 409 });
		},
		{},
		undefined,
		(spans, statusCode) => customReceived.push([spans.length, statusCode]),
	);
	custom.add(span());
	assert.equal(await custom.forceFlush(1_000), true);
	assert.deepEqual(
		customReceived,
		[[1, undefined]],
		'custom backends must not suppress root retry',
	);
	assert.equal(custom.getDiagnostics().lastStatusCode, 409, 'diagnostics preserve the real status');
});

test('SpanExporter bounds its queue, drops oldest spans, and reports the reason', async () => {
	const exportedNames = [];
	const drops = [];
	const exporter = new SpanExporter(
		{ url: 'http://x', headers: {} },
		async (url, headers, body) => {
			exportedNames.push(
				...body.resourceSpans[0].scopeSpans[0].spans.map((exported) => exported.name),
			);
		},
		{},
		undefined,
		undefined,
		(totalDropped) => drops.push(totalDropped),
		{ maxQueueSpans: 3, maxBatchSpans: 3 },
	);
	for (let index = 0; index < 5; index++) exporter.add(span(`s${index}`));
	assert.equal(await exporter.forceFlush(1_000), true);
	assert.deepEqual(exportedNames, ['s2', 's3', 's4']);
	assert.equal(exporter.droppedSpans, 2);
	assert.deepEqual(drops, [1, 2]);
	assert.equal(exporter.getDiagnostics().lastDropReason, 'queue_spans');
});

test('SpanExporter also bounds queued serialized bytes and keeps the newest spans', async () => {
	const exportedNames = [];
	const first = span(`s0-${'x'.repeat(300)}`);
	const second = span(`s1-${'x'.repeat(300)}`);
	const third = span(`s2-${'x'.repeat(300)}`);
	const maxQueueBytes = Buffer.byteLength(JSON.stringify({ ...first, flags: 1 })) * 2 + 1;
	const exporter = new SpanExporter(
		{ url: 'http://x', headers: {} },
		async (url, headers, body) => {
			exportedNames.push(
				...body.resourceSpans[0].scopeSpans[0].spans.map((exported) => exported.name),
			);
		},
		{},
		undefined,
		undefined,
		undefined,
		{ maxQueueSpans: 10, maxQueueBytes, maxBatchBytes: maxQueueBytes },
	);
	exporter.add(first);
	exporter.add(second);
	exporter.add(third);
	assert.equal(await exporter.forceFlush(1_000), true);
	assert.deepEqual(exportedNames, [second.name, third.name]);
	assert.equal(exporter.droppedSpans, 1);
	assert.equal(exporter.getDiagnostics().lastDropReason, 'queue_bytes');
});

test('SpanExporter drops a span that cannot fit the byte-bounded batch', async () => {
	let calls = 0;
	const exporter = new SpanExporter(
		{ url: 'http://x', headers: {} },
		async () => calls++,
		{},
		undefined,
		undefined,
		undefined,
		{ maxBatchBytes: 500, maxQueueBytes: 2_000 },
	);
	exporter.add(span('x'.repeat(2_000)));
	assert.equal(await exporter.forceFlush(1_000), true);
	assert.equal(calls, 0);
	assert.equal(exporter.droppedSpans, 1);
	assert.equal(exporter.getDiagnostics().lastDropReason, 'span_too_large');
});

test('package-level request concurrency never exceeds four exporters', async () => {
	let active = 0;
	let maxActive = 0;
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	const exporters = Array.from(
		{ length: 6 },
		() =>
			new SpanExporter(
				{ url: 'http://x', headers: {} },
				async () => {
					active++;
					maxActive = Math.max(maxActive, active);
					await gate;
					active--;
				},
				{},
			),
	);
	for (const exporter of exporters) exporter.add(span());
	await waitFor(() => active === 4, 'four requests did not enter the global limiter');
	assert.equal(maxActive, 4);
	release();
	await waitFor(() => exporters.every((exporter) => exporter.exportedSpans === 1));
	assert.equal(maxActive, 4);
});

test('forceFlush is bounded; close rejects later adds without throwing', async () => {
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	const exporter = new SpanExporter({ url: 'http://x', headers: {} }, async () => await gate, {});
	exporter.add(span('pending'));
	await waitFor(() => exporter.getDiagnostics().inFlight);
	assert.equal(await exporter.forceFlush(1), false);
	assert.equal(exporter.flushTimeouts, 1);
	release();
	assert.equal(await exporter.close(1_000), true);
	assert.doesNotThrow(() => exporter.add(span('too-late')));
	assert.equal(exporter.droppedSpans, 1);
	assert.equal(exporter.getDiagnostics().lastDropReason, 'exporter_closed');
});
