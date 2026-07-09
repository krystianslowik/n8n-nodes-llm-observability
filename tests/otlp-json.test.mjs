import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	buildExportRequest,
	generateSpanId,
	generateTraceId,
	msToNanos,
	toOtlpAttributes,
	SPAN_KIND_CLIENT,
	STATUS_OK,
} from '../dist/nodes/TraceExporter/shared/otlpJson.js';

test('generateTraceId returns 32 lowercase hex chars, unique per call', () => {
	const a = generateTraceId();
	const b = generateTraceId();
	assert.match(a, /^[0-9a-f]{32}$/);
	assert.notEqual(a, b);
});

test('generateSpanId returns 16 lowercase hex chars', () => {
	assert.match(generateSpanId(), /^[0-9a-f]{16}$/);
});

test('msToNanos converts epoch millis to a nanosecond string without float drift', () => {
	assert.equal(msToNanos(1767225600123), '1767225600123000000');
});

test('toOtlpAttributes wraps values in OTLP envelopes and skips undefined', () => {
	const attrs = toOtlpAttributes({
		'gen_ai.system': 'openai',
		'gen_ai.usage.input_tokens': 42,
		'llm.is_streaming': false,
		'gen_ai.temperature': 0.7,
		skipped: undefined,
	});
	assert.deepEqual(attrs, [
		{ key: 'gen_ai.system', value: { stringValue: 'openai' } },
		{ key: 'gen_ai.usage.input_tokens', value: { intValue: '42' } },
		{ key: 'llm.is_streaming', value: { boolValue: false } },
		{ key: 'gen_ai.temperature', value: { doubleValue: 0.7 } },
	]);
});

test('buildExportRequest produces the OTLP ExportTraceServiceRequest shape', () => {
	const span = {
		traceId: 'a'.repeat(32),
		spanId: 'b'.repeat(16),
		name: 'llm:gpt-4o',
		kind: SPAN_KIND_CLIENT,
		startTimeUnixNano: '1000000',
		endTimeUnixNano: '2000000',
		attributes: toOtlpAttributes({ 'gen_ai.system': 'openai' }),
		status: { code: STATUS_OK },
	};
	const body = buildExportRequest({ 'service.name': 'n8n-trace-exporter' }, [span]);
	assert.deepEqual(body, {
		resourceSpans: [
			{
				resource: {
					attributes: [{ key: 'service.name', value: { stringValue: 'n8n-trace-exporter' } }],
				},
				scopeSpans: [
					{
						scope: { name: 'n8n-nodes-llm-observability', version: '0.1.0' },
						spans: [span],
					},
				],
			},
		],
	});
});
