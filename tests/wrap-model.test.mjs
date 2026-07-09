import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachHandler, wrapModelWithTracing } from '../dist/nodes/TraceExporter/shared/wrapModelWithTracing.js';

const OPTIONS = {
	traceName: 'spike',
	sessionId: 'sess-1',
	userId: 'user-1',
	metadata: '{"env":"test"}',
	capturePrompts: false,
	captureToolIO: false,
	maxPayloadSizeKb: 32,
	samplingRatePercent: 100,
	redactionPatterns: [],
};

const CREDENTIAL = { endpointUrl: 'http://opik.local/api/v1/private/otel', authType: 'customHeaders' };

function fakeCtx(httpCalls, logs = []) {
	return {
		helpers: {
			httpRequest: async (options) => {
				httpCalls.push(options);
			},
		},
		logger: {
			info: (m) => logs.push(['info', m]),
			warn: (m) => logs.push(['warn', m]),
			error: (m) => logs.push(['error', m]),
			debug: (m) => logs.push(['debug', m]),
		},
		getWorkflow: () => ({ id: 'wf-9', name: 'Spike WF', active: false }),
		getExecutionId: () => 'exec-7',
		getNode: () => ({ name: 'Trace Exporter' }),
	};
}

const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

test('attachHandler appends to an existing callbacks array without clobbering', () => {
	const existing = { name: 'n8nLlmTracing' };
	const model = { callbacks: [existing] };
	assert.equal(attachHandler(model, { name: 'mine' }), true);
	assert.equal(model.callbacks.length, 2);
	assert.equal(model.callbacks[0], existing);
});

test('attachHandler creates the array when callbacks is undefined', () => {
	const model = {};
	assert.equal(attachHandler(model, { name: 'mine' }), true);
	assert.equal(model.callbacks.length, 1);
});

test('attachHandler uses addHandler(handler, true) on a CallbackManager-like object', () => {
	const added = [];
	const model = { callbacks: { addHandler: (h, inherit) => added.push([h.name, inherit]) } };
	assert.equal(attachHandler(model, { name: 'mine' }), true);
	assert.deepEqual(added, [['mine', true]]);
});

test('attachHandler returns false for non-objects', () => {
	assert.equal(attachHandler(null, { name: 'mine' }), false);
	assert.equal(attachHandler('model', { name: 'mine' }), false);
});

test('wrapModelWithTracing returns the same instance and exports a span end-to-end', async () => {
	const httpCalls = [];
	const ctx = fakeCtx(httpCalls);
	const model = { callbacks: [] };
	const returned = wrapModelWithTracing(ctx, model, OPTIONS, CREDENTIAL);
	assert.equal(returned, model);
	assert.equal(model.callbacks.length, 1);

	const handler = model.callbacks[0];
	handler.handleChatModelStart(
		{ id: ['langchain', 'chat_models', 'openai', 'ChatOpenAI'], kwargs: { model: 'gpt-4o-mini' } },
		[[]],
		'run-1',
		'agent-run',
	);
	handler.handleLLMEnd({ llmOutput: { tokenUsage: { promptTokens: 4, completionTokens: 2 } } }, 'run-1');
	await flushMicrotasks();

	assert.equal(httpCalls.length, 1);
	assert.equal(httpCalls[0].method, 'POST');
	assert.equal(httpCalls[0].url, 'http://opik.local/api/v1/private/otel/v1/traces');
	const exportedSpan = httpCalls[0].body.resourceSpans[0].scopeSpans[0].spans[0];
	const attrs = Object.fromEntries(exportedSpan.attributes.map((a) => [a.key, Object.values(a.value)[0]]));
	assert.equal(attrs['n8n.workflow.id'], 'wf-9');
	assert.equal(attrs['n8n.execution.id'], 'exec-7');
	assert.equal(attrs['session.id'], 'sess-1');
	assert.equal(attrs['user.id'], 'user-1');
	assert.equal(attrs['gen_ai.request.model'], 'gpt-4o-mini');
});

test('export failure is swallowed: no unhandled rejection, warning logged', async () => {
	const logs = [];
	const ctx = fakeCtx([], logs);
	ctx.helpers.httpRequest = async () => {
		throw new Error('opik down');
	};
	let unhandled = 0;
	const onUnhandled = () => unhandled++;
	process.on('unhandledRejection', onUnhandled);
	try {
		const model = { callbacks: [] };
		wrapModelWithTracing(ctx, model, OPTIONS, CREDENTIAL);
		const handler = model.callbacks[0];
		handler.handleChatModelStart({ id: ['x', 'y'] }, [[]], 'run-1');
		handler.handleLLMEnd({}, 'run-1');
		await flushMicrotasks();
		await flushMicrotasks();
		assert.equal(unhandled, 0);
		assert.ok(logs.some(([level, message]) => level === 'warn' && /opik down/.test(message)));
	} finally {
		process.off('unhandledRejection', onUnhandled);
	}
});

test('wrapModelWithTracing never throws — broken ctx still returns the model', () => {
	const model = { callbacks: [] };
	const broken = {};
	const returned = wrapModelWithTracing(broken, model, OPTIONS, CREDENTIAL);
	assert.equal(returned, model);
});
