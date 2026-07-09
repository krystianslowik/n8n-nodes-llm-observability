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

// NOTE: wrapModelWithTracing keeps a module-level pipeline registry keyed on
// (executionId, node name), so every test must use a UNIQUE execution id to
// stay isolated from the others.
function fakeCtx(httpCalls, logs = [], executionId = 'exec-7') {
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
		getExecutionId: () => executionId,
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
	const ctx = fakeCtx(httpCalls, [], 'exec-e2e');
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
	await flushMicrotasks();

	// synthetic root flushes first, then the llm span (Opik 409 semantics)
	const allSpans = httpCalls.flatMap((c) => c.body.resourceSpans[0].scopeSpans[0].spans);
	assert.equal(allSpans.length, 2);
	assert.equal(httpCalls[0].method, 'POST');
	assert.equal(httpCalls[0].url, 'http://opik.local/api/v1/private/otel/v1/traces');
	const [rootSpan, exportedSpan] = allSpans;
	assert.equal(rootSpan.name, 'spike', 'root named after the Trace Name option');
	assert.equal(exportedSpan.parentSpanId, rootSpan.spanId);
	assert.equal(exportedSpan.traceId, rootSpan.traceId);
	const attrs = Object.fromEntries(exportedSpan.attributes.map((a) => [a.key, Object.values(a.value)[0]]));
	assert.equal(attrs['n8n.workflow.id'], 'wf-9');
	assert.equal(attrs['n8n.execution.id'], 'exec-e2e');
	assert.equal(attrs['session.id'], 'sess-1');
	assert.equal(attrs['user.id'], 'user-1');
	assert.equal(attrs['gen_ai.request.model'], 'gpt-4o-mini');
});

test('export failure is swallowed: no unhandled rejection, warning logged', async () => {
	const logs = [];
	const ctx = fakeCtx([], logs, 'exec-fail');
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

test('one execution shares one pipeline: spans from separate wrap calls share a traceId', async () => {
	const httpCalls = [];
	const modelA = { callbacks: [] };
	const modelB = { callbacks: [] };
	wrapModelWithTracing(fakeCtx(httpCalls, [], 'exec-shared'), modelA, OPTIONS, CREDENTIAL);
	wrapModelWithTracing(fakeCtx(httpCalls, [], 'exec-shared'), modelB, OPTIONS, CREDENTIAL);
	assert.equal(modelA.callbacks[0], modelB.callbacks[0], 'same handler reused for one execution');
	modelA.callbacks[0].handleChatModelStart({ id: ['x', 'openai', 'ChatOpenAI'] }, [[]], 'run-a');
	modelA.callbacks[0].handleLLMEnd({}, 'run-a');
	modelB.callbacks[0].handleChatModelStart({ id: ['x', 'openai', 'ChatOpenAI'] }, [[]], 'run-b');
	modelB.callbacks[0].handleLLMEnd({}, 'run-b');
	await flushMicrotasks();
	await flushMicrotasks();
	const spans = httpCalls.flatMap((c) => c.body.resourceSpans[0].scopeSpans[0].spans);
	// synthetic root + 2 llm spans, all in one trace
	assert.equal(spans.length, 3);
	assert.ok(spans.every((s) => s.traceId === spans[0].traceId), 'one execution -> one trace');
	const [root, llm1, llm2] = spans;
	assert.equal(llm1.parentSpanId, root.spanId);
	assert.equal(llm2.parentSpanId, root.spanId);
	assert.notEqual(llm1.spanId, llm2.spanId);
});

test('different executions get different pipelines and traces', async () => {
	const httpCalls = [];
	const modelA = { callbacks: [] };
	const modelB = { callbacks: [] };
	wrapModelWithTracing(fakeCtx(httpCalls, [], 'exec-one'), modelA, OPTIONS, CREDENTIAL);
	wrapModelWithTracing(fakeCtx(httpCalls, [], 'exec-two'), modelB, OPTIONS, CREDENTIAL);
	assert.notEqual(modelA.callbacks[0], modelB.callbacks[0]);
	modelA.callbacks[0].handleChatModelStart({ id: ['x', 'openai', 'ChatOpenAI'] }, [[]], 'run-a');
	modelA.callbacks[0].handleLLMEnd({}, 'run-a');
	modelB.callbacks[0].handleChatModelStart({ id: ['x', 'openai', 'ChatOpenAI'] }, [[]], 'run-b');
	modelB.callbacks[0].handleLLMEnd({}, 'run-b');
	await flushMicrotasks();
	await flushMicrotasks();
	const spans = httpCalls.flatMap((c) => c.body.resourceSpans[0].scopeSpans[0].spans);
	// each execution: synthetic root + 1 llm span
	assert.equal(spans.length, 4);
	const traceIds = new Set(spans.map((s) => s.traceId));
	assert.equal(traceIds.size, 2);
});
