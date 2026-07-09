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

test('attachHandler is idempotent for arrays: re-attaching the same handler does not double it', () => {
	const handler = { name: 'mine' };
	const model = { callbacks: [handler] };
	assert.equal(attachHandler(model, handler), true);
	assert.equal(model.callbacks.length, 1, 'the same handler is never pushed twice');
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
	// Backend-native grouping keys fan out from Session ID / User ID:
	// Opik Threads (thread_id + semconv, verified in spike/verify-thread-mapping.mjs)
	// and Langfuse sessions/users (langfuse.* per their OTel docs).
	assert.equal(attrs['gen_ai.conversation.id'], 'sess-1');
	assert.equal(attrs['thread_id'], 'sess-1');
	assert.equal(attrs['langfuse.session.id'], 'sess-1');
	assert.equal(attrs['langfuse.user.id'], 'user-1');
	assert.equal(attrs['gen_ai.request.model'], 'gpt-4o-mini');
});

test('empty Session ID / User ID emit NO session, thread, or user attributes', async () => {
	const httpCalls = [];
	const ctx = fakeCtx(httpCalls, [], 'exec-no-session');
	const model = { callbacks: [] };
	wrapModelWithTracing(ctx, model, { ...OPTIONS, sessionId: '', userId: '' }, CREDENTIAL);
	const handler = model.callbacks[0];
	handler.handleChatModelStart({ id: ['x', 'openai', 'ChatOpenAI'] }, [[]], 'run-1');
	handler.handleLLMEnd({}, 'run-1');
	await flushMicrotasks();
	await flushMicrotasks();
	const allSpans = httpCalls.flatMap((c) => c.body.resourceSpans[0].scopeSpans[0].spans);
	assert.ok(allSpans.length >= 1);
	for (const span of allSpans) {
		const keys = span.attributes.map((a) => a.key);
		for (const absent of [
			'session.id',
			'gen_ai.conversation.id',
			'thread_id',
			'langfuse.session.id',
			'user.id',
			'langfuse.user.id',
		]) {
			assert.ok(!keys.includes(absent), `${absent} must be absent when unset (span ${span.name})`);
		}
	}
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

test('a 409 on the root batch does NOT re-emit: the backend already has the root', async () => {
	const httpCalls = [];
	let callCount = 0;
	const ctx = fakeCtx(httpCalls, [], 'exec-root-409');
	// The solo root batch "fails" with a 409 — Opik answering "Trace already
	// exists", e.g. after a client-side timeout on a POST the server ingested.
	ctx.helpers.httpRequest = async (options) => {
		callCount++;
		httpCalls.push(options);
		if (callCount === 1) {
			// n8n NodeApiError shape: httpCode is a string
			throw Object.assign(new Error('Conflict'), { httpCode: '409' });
		}
	};

	const { model } = wrapModelWithTracing(ctx, { callbacks: [] }, OPTIONS, CREDENTIAL);
	const handler = model.callbacks[0];

	handler.handleChatModelStart({ id: ['x', 'openai', 'ChatOpenAI'] }, [[]], 'run-1');
	handler.handleLLMEnd({}, 'run-1');
	await flushMicrotasks();
	await flushMicrotasks();
	await flushMicrotasks();

	handler.handleChatModelStart({ id: ['x', 'openai', 'ChatOpenAI'] }, [[]], 'run-2');
	handler.handleLLMEnd({}, 'run-2');
	await flushMicrotasks();
	await flushMicrotasks();
	await flushMicrotasks();

	const bodies = httpCalls.map((c) => c.body.resourceSpans[0].scopeSpans[0].spans);
	assert.equal(bodies.length, 3, 'three POSTs: 409ed root, llm-1, llm-2 — NO re-emitted root batch');
	const rootSpanId = bodies[0][0].spanId;
	const laterSpanIds = bodies.slice(1).flat().map((s) => s.spanId);
	assert.ok(!laterSpanIds.includes(rootSpanId), 'no later batch carries a re-emitted root');
});

test('non-numeric Max Payload Size falls back to the 32 KB default budget instead of truncating everything', async () => {
	const httpCalls = [];
	const ctx = fakeCtx(httpCalls, [], 'exec-nan-budget');
	const model = { callbacks: [] };
	wrapModelWithTracing(
		ctx,
		model,
		{ ...OPTIONS, capturePrompts: true, maxPayloadSizeKb: 'lots' },
		CREDENTIAL,
	);
	const handler = model.callbacks[0];
	handler.handleChatModelStart(
		{ id: ['x', 'openai', 'ChatOpenAI'] },
		[[{ content: 'short prompt', _getType: () => 'human' }]],
		'run-1',
	);
	handler.handleLLMEnd({ generations: [[{ text: 'short answer' }]] }, 'run-1');
	await flushMicrotasks();
	await flushMicrotasks();
	const spans = httpCalls.flatMap((c) => c.body.resourceSpans[0].scopeSpans[0].spans);
	const llm = spans.find((s) => s.name.startsWith('llm:'));
	const attrs = Object.fromEntries(llm.attributes.map((a) => [a.key, Object.values(a.value)[0]]));
	assert.ok(String(attrs['gen_ai.prompt']).includes('short prompt'), 'prompt captured under the default budget');
	assert.ok(!String(attrs['gen_ai.prompt']).includes('[truncated]'), 'a NaN budget must not truncate everything');
	assert.equal(attrs['gen_ai.completion'], 'short answer', 'completion untouched too');
});

test('single-closeRun execution: closeFunction retries the failed root at execution end (and still evicts)', async () => {
	const httpCalls = [];
	let callCount = 0;
	const ctx = fakeCtx(httpCalls, [], 'exec-root-retry-at-close');
	// Fail ONLY the solo root batch; the child batch and the retry succeed.
	ctx.helpers.httpRequest = async (options) => {
		callCount++;
		httpCalls.push(options);
		if (callCount === 1) throw new Error('backend down for the root batch');
	};

	const modelA = { callbacks: [] };
	const { model, closeFunction } = wrapModelWithTracing(ctx, modelA, OPTIONS, CREDENTIAL);
	const handler = model.callbacks[0];

	// Exactly ONE LLM call: no later closeRun ever re-triggers the root emit,
	// so without the execution-end retry the trace stays orphaned forever.
	handler.handleChatModelStart({ id: ['x', 'openai', 'ChatOpenAI'] }, [[]], 'run-only');
	handler.handleLLMEnd({}, 'run-only');
	await flushMicrotasks();
	await flushMicrotasks();
	await flushMicrotasks();

	const bodiesBeforeClose = httpCalls.map((c) => c.body.resourceSpans[0].scopeSpans[0].spans);
	assert.equal(bodiesBeforeClose.length, 2, 'before closeFunction: only failed root + child were POSTed');

	await closeFunction();
	await flushMicrotasks();
	await flushMicrotasks();

	const bodies = httpCalls.map((c) => c.body.resourceSpans[0].scopeSpans[0].spans);
	assert.equal(bodies.length, 3, 'three POSTs: failed root, child, root retried at execution end');
	const [failedRoot] = bodies[0];
	const [child] = bodies[1];
	const [retriedRoot] = bodies[2];
	assert.equal(retriedRoot.spanId, failedRoot.spanId, 'execution-end retry re-emits the SAME root spanId');
	assert.equal(retriedRoot.parentSpanId, undefined, 'the retried root is still parentless');
	assert.equal(child.parentSpanId, retriedRoot.spanId, "child's parentSpanId matches the root the backend finally got");

	// closeFunction still evicts the registry entry: same executionId now
	// builds a FRESH pipeline.
	const modelB = { callbacks: [] };
	wrapModelWithTracing(fakeCtx(httpCalls, [], 'exec-root-retry-at-close'), modelB, OPTIONS, CREDENTIAL);
	assert.notEqual(modelB.callbacks[0], handler, 'registry entry was deleted by closeFunction');
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
