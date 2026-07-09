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
		buildExportTarget({ endpointUrl: 'http://localhost:5173/api/v1/private/otel', authType: 'customHeaders' }).url,
		'http://localhost:5173/api/v1/private/otel/v1/traces',
	);
	assert.equal(
		buildExportTarget({ endpointUrl: 'http://x/otel/v1/traces/', authType: 'customHeaders' }).url,
		'http://x/otel/v1/traces',
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

test('SpanExporter posts an OTLP body per add and counts successes', async () => {
	const calls = [];
	const exporter = new SpanExporter(
		{ url: 'http://x/v1/traces', headers: { h: '1' } },
		async (url, headers, body) => {
			calls.push({ url, headers, body });
		},
		{ 'service.name': 'n8n-trace-exporter' },
	);
	exporter.add(span());
	await flushMicrotasks();
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, 'http://x/v1/traces');
	assert.equal(calls[0].body.resourceSpans[0].scopeSpans[0].spans.length, 1);
	assert.equal(exporter.exportedSpans, 1);
	assert.equal(exporter.exportErrors, 0);
});

test('SpanExporter swallows post failures, counts them, reports via onError, never rejects', async () => {
	const errors = [];
	let unhandled = 0;
	const onUnhandled = () => unhandled++;
	process.on('unhandledRejection', onUnhandled);
	try {
		const exporter = new SpanExporter(
			{ url: 'http://x', headers: {} },
			async () => {
				throw new Error('backend down');
			},
			{},
			(message) => errors.push(message),
		);
		exporter.add(span());
		await flushMicrotasks();
		await flushMicrotasks();
		assert.equal(exporter.exportErrors, 1);
		assert.equal(exporter.exportedSpans, 0);
		assert.equal(errors.length, 1);
		assert.match(errors[0], /backend down/);
		assert.equal(unhandled, 0);
	} finally {
		process.off('unhandledRejection', onUnhandled);
	}
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
		await flushMicrotasks();
		await flushMicrotasks();
		assert.equal(exporter.exportErrors, 1);
		assert.equal(exporter.exportedSpans, 0);
		assert.equal(unhandled, 0);
	} finally {
		process.off('unhandledRejection', onUnhandled);
	}
});

test('SpanExporter keeps draining after a failed batch, even with multiple queued spans', async () => {
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
	);
	// First span triggers the failing solo batch; two more queue up behind it
	// while that POST is in flight (add() is synchronous, the POST is not).
	exporter.add(span('s0'));
	exporter.add(span('s1'));
	exporter.add(span('s2'));
	await flushMicrotasks();
	await flushMicrotasks();
	await flushMicrotasks();
	assert.equal(exporter.exportErrors, 1, 'only the first batch failed');
	assert.equal(exporter.exportedSpans, 2, 's1 and s2 still made it out after the failure');
	const drainedNames = calls
		.slice(1)
		.flatMap((body) => body.resourceSpans[0].scopeSpans[0].spans.map((s) => s.name));
	assert.deepEqual(drainedNames, ['s1', 's2'], 'queued spans still get posted after a failed batch');
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
		);
		exporter.add(span('s0'));
		exporter.add(span('s1'));
		await flushMicrotasks();
		await flushMicrotasks();
		await flushMicrotasks();
		assert.equal(exporter.exportErrors, 1, 'error still counted despite onError throwing');
		assert.equal(exporter.exportedSpans, 1, 's1 still drained after the failed+throwing batch');
		assert.equal(unhandled, 0, 'a throwing onError must never produce an unhandled rejection');
	} finally {
		process.off('unhandledRejection', onUnhandled);
	}
});

test('SpanExporter bounds the queue and counts drops when posts never drain', async () => {
	let resolvePost;
	const gate = new Promise((resolve) => {
		resolvePost = resolve;
	});
	const exporter = new SpanExporter({ url: 'http://x', headers: {} }, () => gate, {});
	for (let i = 0; i < 250; i++) exporter.add(span(`s${i}`));
	assert.ok(exporter.droppedSpans > 0, 'overflow must drop and count');
	resolvePost();
	await flushMicrotasks();
});
