import assert from 'node:assert/strict';
import test from 'node:test';

import {
	correlateNativeNodeSpan,
	executionObservabilityContextFrom,
} from '../dist/nodes/TraceExporter/shared/executionContext.js';

function context({ mode = 'manual', executionContext } = {}) {
	return {
		getMode: () => mode,
		getExecutionContext: () => executionContext,
	};
}

test('execution context exposes mode and parent without copying sensitive fields', () => {
	const result = executionObservabilityContextFrom(
		context({
			mode: 'webhook',
			executionContext: {
				parentExecutionId: 'parent-42',
				credentials: 'encrypted-secret',
				redaction: { version: 1, policy: 'none' },
			},
		}),
	);

	assert.deepEqual(result, {
		mode: 'webhook',
		parentExecutionId: 'parent-42',
		contentCaptureBlocked: false,
	});
	assert.equal('credentials' in result, false);
});

test('v1 and v2 n8n redaction snapshots form a hard content-capture ceiling', () => {
	assert.equal(
		executionObservabilityContextFrom(
			context({
				mode: 'webhook',
				executionContext: { redaction: { version: 1, policy: 'non-manual' } },
			}),
		).contentCaptureBlocked,
		true,
	);
	assert.equal(
		executionObservabilityContextFrom(
			context({
				mode: 'manual',
				executionContext: { redaction: { version: 1, policy: 'non-manual' } },
			}),
		).contentCaptureBlocked,
		false,
	);
	assert.equal(
		executionObservabilityContextFrom(
			context({
				mode: 'manual',
				executionContext: {
					redaction: { version: 2, production: false, manual: true },
				},
			}),
		).contentCaptureBlocked,
		true,
	);
});

test('content capture fails closed when execution policy context is unavailable', () => {
	assert.deepEqual(executionObservabilityContextFrom({}), { contentCaptureBlocked: true });
	assert.equal(
		executionObservabilityContextFrom(context({ executionContext: undefined }))
			.contentCaptureBlocked,
		true,
	);
	assert.equal(
		executionObservabilityContextFrom(context({ executionContext: {} })).contentCaptureBlocked,
		true,
	);
	assert.equal(
		executionObservabilityContextFrom(
			context({ executionContext: { redaction: { version: 3, policy: 'none' } } }),
		).contentCaptureBlocked,
		true,
	);
	assert.deepEqual(
		executionObservabilityContextFrom({
			getMode: () => {
				throw new Error('context unavailable');
			},
		}),
		{ contentCaptureBlocked: true },
	);
});

test('native correlation preserves existing tracing metadata', () => {
	let received;
	const ctx = {
		getExecuteData: () => ({
			metadata: {
				tracing: { agent_name: 'Support Agent', retry_count: 1, cache_hit: true, ignored: {} },
			},
		}),
		setMetadata: (metadata) => {
			received = metadata;
		},
	};

	assert.equal(
		correlateNativeNodeSpan(ctx, {
			tracing: 'attached',
			sampling: 'sampled',
			traceId: '0123456789abcdef0123456789abcdef',
			rootSpanId: '0123456789abcdef',
			exportStatus: 'queued',
		}),
		true,
	);
	assert.deepEqual(received, {
		tracing: {
			agent_name: 'Support Agent',
			retry_count: 1,
			cache_hit: true,
			ai_observability_trace_id: '0123456789abcdef0123456789abcdef',
			ai_observability_root_span_id: '0123456789abcdef',
		},
	});
});

test('native correlation is a safe no-op when unsupported or unsampled', () => {
	assert.equal(
		correlateNativeNodeSpan(
			{},
			{
				tracing: 'attached',
				sampling: 'sampled',
				traceId: '0123456789abcdef0123456789abcdef',
				rootSpanId: '0123456789abcdef',
			},
		),
		false,
	);
	assert.equal(
		correlateNativeNodeSpan(
			{
				getExecuteData: () => {
					throw new Error('not available');
				},
				setMetadata: () => {
					throw new Error('must stay swallowed');
				},
			},
			{
				tracing: 'attached',
				sampling: 'notSampled',
				exportStatus: 'notSampled',
			},
		),
		false,
	);
});
