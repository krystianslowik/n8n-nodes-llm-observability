import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TraceExporter } from '../dist/nodes/TraceExporter/TraceExporter.node.js';

const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

const PARAM_DEFAULTS = {
	traceName: '',
	sessionId: '',
	userId: '',
	metadata: {},
	options: {},
};

/**
 * Builds a minimal fake ISupplyDataFunctions. `getInputConnectionData`
 * returns an ARRAY by default — with `maxConnections: 1` current n8n hands
 * back the model directly, but older versions (and bare-string input
 * configs) return an array of supplied models, and attaching callbacks to
 * the array traces nothing (measured live in the spike). `supplyData` keeps
 * a defensive unwrap to the first element; this file pins both shapes.
 */
function fakeCtx({ model, httpCalls = [], executionId = 'exec-supply-data-1', supplyAsArray = true } = {}) {
	return {
		getInputConnectionData: async () => (supplyAsArray ? [model] : model),
		getNodeParameter: (name, _itemIndex, fallback) => {
			if (name in PARAM_DEFAULTS) return PARAM_DEFAULTS[name];
			return fallback;
		},
		getCredentials: async () => ({
			endpointUrl: 'http://opik.local/api/v1/private/otel',
			authType: 'customHeaders',
		}),
		helpers: {
			httpRequest: async (options) => {
				httpCalls.push(options);
			},
		},
		logger: {
			info: () => {},
			warn: () => {},
			error: () => {},
			debug: () => {},
		},
		getWorkflow: () => ({ id: 'wf-supply', name: 'Supply Data WF', active: false }),
		getExecutionId: () => executionId,
		getNode: () => ({ name: 'Trace Exporter' }),
	};
}

test('supplyData unwraps the array from getInputConnectionData and returns the model itself', async () => {
	const model = { callbacks: [] };
	const httpCalls = [];
	const ctx = fakeCtx({ model, httpCalls, executionId: 'exec-supply-data-unwrap' });

	const result = await new TraceExporter().supplyData.call(ctx, 0);

	// THE regression test: response must be the unwrapped model, not the
	// array getInputConnectionData handed back.
	assert.equal(result.response, model, 'response must be the unwrapped model, not the supplied array');
	assert.equal(model.callbacks.length, 1, 'exactly one tracing handler attached to the model');
	assert.equal(typeof result.closeFunction, 'function', 'supplyData wires up the eviction closeFunction');

	const handler = model.callbacks[0];
	handler.handleChatModelStart(
		{ id: ['langchain', 'chat_models', 'openai', 'ChatOpenAI'], kwargs: { model: 'gpt-4o-mini' } },
		[[{ content: 'hi' }]],
		'run-1',
	);
	handler.handleLLMEnd({ llmOutput: { tokenUsage: { promptTokens: 3, completionTokens: 1 } } }, 'run-1');
	await flushMicrotasks();
	await flushMicrotasks();

	assert.ok(httpCalls.length > 0, 'firing the attached handler produces at least one POST');
	for (const call of httpCalls) {
		assert.equal(call.method, 'POST');
		assert.equal(call.url, 'http://opik.local/api/v1/private/otel/v1/traces');
	}
	const spans = httpCalls.flatMap((c) => c.body.resourceSpans[0].scopeSpans[0].spans);
	assert.ok(
		spans.some((s) => s.name === 'llm:gpt-4o-mini'),
		'the llm span from handleChatModelStart/handleLLMEnd made it into a POST body',
	);
});

test('supplyData also accepts the model directly (maxConnections: 1 shape on current n8n)', async () => {
	const model = { callbacks: [] };
	const ctx = fakeCtx({ model, executionId: 'exec-supply-data-direct', supplyAsArray: false });

	const result = await new TraceExporter().supplyData.call(ctx, 0);

	assert.equal(result.response, model, 'a directly-supplied model passes through unwrapped');
	assert.equal(model.callbacks.length, 1, 'exactly one tracing handler attached to the model');
});

test('description declares a single ai_languageModel input capped at one connection', () => {
	const { description } = new TraceExporter();
	assert.deepEqual(description.inputs, [{ type: 'ai_languageModel', maxConnections: 1 }]);
});

test('export POSTs carry a bounded timeout so a hung backend cannot pin the in-flight slot', async () => {
	const model = { callbacks: [] };
	const httpCalls = [];
	const ctx = fakeCtx({ model, httpCalls, executionId: 'exec-supply-data-timeout' });

	await new TraceExporter().supplyData.call(ctx, 0);
	const handler = model.callbacks[0];
	handler.handleChatModelStart(
		{ id: ['langchain', 'chat_models', 'openai', 'ChatOpenAI'], kwargs: { model: 'gpt-4o-mini' } },
		[[{ content: 'hi' }]],
		'run-1',
	);
	handler.handleLLMEnd({ llmOutput: { tokenUsage: { promptTokens: 3, completionTokens: 1 } } }, 'run-1');
	await flushMicrotasks();
	await flushMicrotasks();

	assert.ok(httpCalls.length > 0, 'at least one export POST fired');
	for (const call of httpCalls) {
		assert.equal(call.timeout, 10000, 'every export POST sets the 10s timeout');
	}
});
