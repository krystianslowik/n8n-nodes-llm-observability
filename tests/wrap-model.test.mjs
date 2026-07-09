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
	assert.equal(returned.model, model);
	assert.equal(typeof returned.closeFunction, 'function', 'registry-backed wrap returns a closeFunction');
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
	assert.equal(returned.model, model);
	assert.equal(returned.closeFunction, undefined, 'failure path returns no closeFunction');
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

test('root re-emits with the SAME spanId after its export batch fails, so late-arriving children stay valid', async () => {
	const httpCalls = [];
	let callCount = 0;
	const ctx = fakeCtx(httpCalls, [], 'exec-root-retry');
	// The synthetic root always ships as its own solo batch first; fail only
	// that first POST, then let every later batch succeed.
	ctx.helpers.httpRequest = async (options) => {
		callCount++;
		httpCalls.push(options);
		if (callCount === 1) throw new Error('backend down for the root batch');
	};

	const { model } = wrapModelWithTracing(ctx, { callbacks: [] }, OPTIONS, CREDENTIAL);
	const handler = model.callbacks[0];

	handler.handleChatModelStart({ id: ['x', 'openai', 'ChatOpenAI'] }, [[]], 'run-1');
	handler.handleLLMEnd({}, 'run-1');
	await flushMicrotasks();
	await flushMicrotasks();
	await flushMicrotasks();

	// A second LLM span's closeRun is what re-triggers emitSharedRootIfNeeded.
	handler.handleChatModelStart({ id: ['x', 'openai', 'ChatOpenAI'] }, [[]], 'run-2');
	handler.handleLLMEnd({}, 'run-2');
	await flushMicrotasks();
	await flushMicrotasks();
	await flushMicrotasks();

	const bodies = httpCalls.map((c) => c.body.resourceSpans[0].scopeSpans[0].spans);
	assert.equal(bodies.length, 4, 'four POSTs: failed root, llm-1, re-emitted root, llm-2');

	const [failedRoot] = bodies[0];
	const [llm1] = bodies[1];
	const [reEmittedRoot] = bodies[2];
	const [llm2] = bodies[3];

	assert.equal(failedRoot.parentSpanId, undefined, 'the root span itself has no parent');
	assert.equal(reEmittedRoot.spanId, failedRoot.spanId, 'retry re-emits the SAME root spanId');
	assert.equal(reEmittedRoot.traceId, failedRoot.traceId);
	assert.equal(llm1.parentSpanId, reEmittedRoot.spanId, 'llm-1 already referenced the (retried) root spanId');
	assert.equal(llm2.parentSpanId, reEmittedRoot.spanId, 'llm-2 parented to the same root spanId');
	// Final state: the backend actually received the root (batch 3 succeeded)
	// with the exact spanId both children point to as their parent.
});

test("closeFunction evicts the execution's pipeline: a later wrap call gets a FRESH handler", async () => {
	const httpCalls = [];
	const modelA = { callbacks: [] };
	const { closeFunction } = wrapModelWithTracing(fakeCtx(httpCalls, [], 'exec-close'), modelA, OPTIONS, CREDENTIAL);
	assert.equal(typeof closeFunction, 'function');
	const handlerA = modelA.callbacks[0];

	await closeFunction();

	const modelB = { callbacks: [] };
	wrapModelWithTracing(fakeCtx(httpCalls, [], 'exec-close'), modelB, OPTIONS, CREDENTIAL);
	const handlerB = modelB.callbacks[0];

	assert.notEqual(handlerB, handlerA, 'evicted execution gets a brand-new handler, not the stale one');
});

test('closeFunction is idempotent: calling it more than once never throws', async () => {
	const model = { callbacks: [] };
	const { closeFunction } = wrapModelWithTracing(fakeCtx([], [], 'exec-close-2'), model, OPTIONS, CREDENTIAL);
	await closeFunction();
	await assert.doesNotReject(closeFunction());
});

test('MAX_PIPELINES FIFO eviction is the backstop: re-wrapping the first of 201 executions gets a NEW handler', () => {
	const httpCalls = [];
	const firstExecId = 'exec-evict-0';
	const firstModel = { callbacks: [] };
	wrapModelWithTracing(fakeCtx(httpCalls, [], firstExecId), firstModel, OPTIONS, CREDENTIAL);
	const firstHandler = firstModel.callbacks[0];

	// MAX_PIPELINES is 200; 200 more distinct executions push the registry
	// past capacity and evict the oldest entry (the one above).
	for (let i = 1; i <= 200; i++) {
		const model = { callbacks: [] };
		wrapModelWithTracing(fakeCtx(httpCalls, [], `exec-evict-${i}`), model, OPTIONS, CREDENTIAL);
	}

	const rewrappedModel = { callbacks: [] };
	wrapModelWithTracing(fakeCtx(httpCalls, [], firstExecId), rewrappedModel, OPTIONS, CREDENTIAL);
	const rewrappedHandler = rewrappedModel.callbacks[0];

	assert.notEqual(
		rewrappedHandler,
		firstHandler,
		'the first execution was FIFO-evicted once MAX_PIPELINES was exceeded',
	);
});
