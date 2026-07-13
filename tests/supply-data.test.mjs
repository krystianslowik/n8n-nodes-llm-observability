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
function fakeCtx({
	model,
	httpCalls = [],
	executionId = 'exec-supply-data-1',
	supplyAsArray = true,
	typeVersion = 1,
	parameters = {},
} = {}) {
	return {
		getInputConnectionData: async () => (supplyAsArray ? [model] : model),
		getNodeParameter: (name, _itemIndex, fallback) => {
			if (name in parameters) return parameters[name];
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
		getNode: () => ({ name: 'AI Trace Exporter', typeVersion }),
	};
}

test('supplyData unwraps the array from getInputConnectionData and returns the model itself', async () => {
	const model = { callbacks: [] };
	const httpCalls = [];
	const ctx = fakeCtx({ model, httpCalls, executionId: 'exec-supply-data-unwrap' });

	const result = await new TraceExporter().supplyData.call(ctx, 0);

	// THE regression test: response must be the unwrapped model, not the
	// array getInputConnectionData handed back.
	assert.equal(
		result.response,
		model,
		'response must be the unwrapped model, not the supplied array',
	);
	assert.equal(model.callbacks.length, 2, 'OTLP and n8n execution-state handlers are attached');
	assert.deepEqual(
		model.callbacks.map((callback) => callback.name),
		['n8nTraceExporterOtel', 'n8nTraceExporterExecutionState'],
		'the non-mutating UI handler stays behind OTLP capture but ahead of the supplied model callbacks',
	);
	assert.equal(
		typeof result.closeFunction,
		'function',
		'supplyData wires up the eviction closeFunction',
	);

	const handler = model.callbacks[0];
	handler.handleChatModelStart(
		{ id: ['langchain', 'chat_models', 'openai', 'ChatOpenAI'], kwargs: { model: 'gpt-4o-mini' } },
		[[{ content: 'hi' }]],
		'run-1',
	);
	handler.handleLLMEnd(
		{ llmOutput: { tokenUsage: { promptTokens: 3, completionTokens: 1 } } },
		'run-1',
	);
	await flushMicrotasks();
	await flushMicrotasks();

	assert.ok(httpCalls.length > 0, 'firing the attached handler produces at least one POST');
	for (const call of httpCalls) {
		assert.equal(call.method, 'POST');
		assert.equal(call.url, 'http://opik.local/api/v1/private/otel/v1/traces');
	}
	const spans = httpCalls.flatMap((c) => c.body.resourceSpans[0].scopeSpans[0].spans);
	assert.ok(
		spans.some((s) => s.name === 'chat gpt-4o-mini'),
		'the llm span from handleChatModelStart/handleLLMEnd made it into a POST body',
	);
});

test('supplyData also accepts the model directly (maxConnections: 1 shape on current n8n)', async () => {
	const model = { callbacks: [] };
	const ctx = fakeCtx({ model, executionId: 'exec-supply-data-direct', supplyAsArray: false });

	const result = await new TraceExporter().supplyData.call(ctx, 0);

	assert.equal(result.response, model, 'a directly-supplied model passes through unwrapped');
	assert.equal(model.callbacks.length, 2, 'OTLP and n8n execution-state handlers are attached');
});

test('reusing a model replaces the stale UI handler and keeps OTLP first', async () => {
	const model = { callbacks: [] };
	await new TraceExporter().supplyData.call(
		fakeCtx({ model, executionId: 'exec-supply-data-reuse' }),
		0,
	);
	const firstUiHandler = model.callbacks[1];
	await new TraceExporter().supplyData.call(
		fakeCtx({ model, executionId: 'exec-supply-data-reuse' }),
		0,
	);
	assert.equal(model.callbacks.length, 2, 'no stale callback accumulates');
	assert.equal(model.callbacks[0].name, 'n8nTraceExporterOtel');
	assert.equal(model.callbacks[1].name, 'n8nTraceExporterExecutionState');
	assert.notEqual(
		model.callbacks[1],
		firstUiHandler,
		'the current step context replaces the old one',
	);
});

test('supplyData execution-state handler receives the OTLP trace IDs after the model starts', async () => {
	const model = { callbacks: [] };
	const ctx = fakeCtx({ model, executionId: 'exec-supply-data-trace-id' });
	const inputs = [];
	const outputs = [];
	ctx.addInputData = (_connectionType, data) => {
		inputs.push(data);
		return { index: 0 };
	};
	ctx.addOutputData = (...args) => outputs.push(args);

	await new TraceExporter().supplyData.call(ctx, 0);
	const [otel, executionState] = model.callbacks;
	const llm = {
		id: ['langchain', 'chat_models', 'openai', 'ChatOpenAI'],
		kwargs: { model: 'gpt-4o-mini' },
	};
	// LangChain's chat fallback invokes the OTLP chat hook first, then the
	// execution-state handler's LLM hook in callback order.
	otel.handleChatModelStart(llm, [[]], 'run-1');
	executionState.handleLLMStart(llm, [], 'run-1');
	otel.handleLLMEnd({}, 'run-1');
	executionState.handleLLMEnd({}, 'run-1');

	const inputJson = inputs[0][0][0].json;
	const outputJson = outputs[0][2][0][0].json;
	assert.match(inputJson.traceId, /^[0-9a-f]{32}$/);
	assert.match(inputJson.rootSpanId, /^[0-9a-f]{16}$/);
	assert.equal(outputJson.traceId, inputJson.traceId);
	assert.equal(outputJson.rootSpanId, inputJson.rootSpanId);
});

test('description declares one required model input and one traced model output', () => {
	const { description } = new TraceExporter();
	assert.deepEqual(description.inputs, [
		{
			type: 'ai_languageModel',
			displayName: 'Chat Model',
			required: true,
			maxConnections: 1,
		},
	]);
	assert.deepEqual(description.outputs, [
		{
			type: 'ai_languageModel',
			displayName: 'Traced Chat Model',
		},
	]);
	assert.equal(description.requiredInputs, 1);
});

test('description exposes observability search aliases without claiming tool support', () => {
	const { description } = new TraceExporter();
	assert.deepEqual(description.version, [1, 1.1]);
	assert.equal(description.usableAsTool, undefined);
	assert.equal(
		description.properties.find((property) => property.name === 'metadata').validateType,
		'object',
	);
	for (const alias of ['LLM observability', 'OpenTelemetry', 'OTLP', 'Opik', 'Langfuse']) {
		assert.ok(description.codex.alias.includes(alias), `missing picker alias: ${alias}`);
	}
});

test('node version 1.1 reads visible capture and grouped advanced settings', async () => {
	const model = { callbacks: [] };
	const httpCalls = [];
	const ctx = fakeCtx({
		model,
		httpCalls,
		executionId: 'exec-supply-data-v1-1',
		typeVersion: 1.1,
		parameters: {
			capturePrompts: true,
			captureToolIO: false,
			privacyOptions: { maxPayloadSizeKb: 8, redactionPatterns: [] },
			traceAttributes: {
				environment: 'staging',
				release: '1.1.0',
				serviceName: 'support-agent',
				tags: ['ux-test'],
			},
			exportOptions: { samplingRatePercent: 100 },
		},
	});

	await new TraceExporter().supplyData.call(ctx, 0);
	const handler = model.callbacks[0];
	handler.handleChatModelStart(
		{ id: ['langchain', 'chat_models', 'openai', 'ChatOpenAI'], kwargs: { model: 'gpt-4o-mini' } },
		[[{ content: 'visible prompt' }]],
		'run-v1-1',
	);
	handler.handleLLMEnd({}, 'run-v1-1');
	await flushMicrotasks();
	await flushMicrotasks();

	const resourceSpans = httpCalls.flatMap((call) => call.body.resourceSpans);
	assert.ok(resourceSpans.length > 0);
	const resourceAttributes = Object.fromEntries(
		resourceSpans[0].resource.attributes.map(({ key, value }) => [
			key,
			value.stringValue ?? value.intValue ?? value.doubleValue ?? value.boolValue,
		]),
	);
	assert.equal(resourceAttributes['service.name'], 'support-agent');
	assert.equal(resourceAttributes['service.version'], '1.1.0');
	const spans = resourceSpans.flatMap((group) => group.scopeSpans.flatMap((scope) => scope.spans));
	const llmSpan = spans.find((span) => span.name === 'chat gpt-4o-mini');
	const spanAttributes = Object.fromEntries(
		llmSpan.attributes.map(({ key, value }) => [
			key,
			value.stringValue ?? value.intValue ?? value.doubleValue ?? value.boolValue,
		]),
	);
	assert.match(String(spanAttributes['gen_ai.input.messages']), /visible prompt/);
	assert.equal(spanAttributes['deployment.environment.name'], 'staging');
});

test('node version 1 keeps legacy nested capture settings', async () => {
	const model = { callbacks: [] };
	const httpCalls = [];
	const ctx = fakeCtx({
		model,
		httpCalls,
		executionId: 'exec-supply-data-v1-legacy',
		typeVersion: 1,
		parameters: {
			options: { capturePrompts: true, captureToolIO: false },
		},
	});

	await new TraceExporter().supplyData.call(ctx, 0);
	const handler = model.callbacks[0];
	handler.handleChatModelStart(
		{ id: ['langchain', 'chat_models', 'openai', 'ChatOpenAI'], kwargs: { model: 'gpt-4o-mini' } },
		[[{ content: 'legacy visible prompt' }]],
		'run-v1-legacy',
	);
	handler.handleLLMEnd({}, 'run-v1-legacy');
	await flushMicrotasks();
	await flushMicrotasks();

	const spans = httpCalls.flatMap((call) =>
		call.body.resourceSpans.flatMap((resource) =>
			resource.scopeSpans.flatMap((scope) => scope.spans),
		),
	);
	const llmSpan = spans.find((span) => span.name === 'chat gpt-4o-mini');
	const attributes = Object.fromEntries(
		llmSpan.attributes.map(({ key, value }) => [key, value.stringValue]),
	);
	assert.match(String(attributes['gen_ai.input.messages']), /legacy visible prompt/);
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
	handler.handleLLMEnd(
		{ llmOutput: { tokenUsage: { promptTokens: 3, completionTokens: 1 } } },
		'run-1',
	);
	await flushMicrotasks();
	await flushMicrotasks();

	assert.ok(httpCalls.length > 0, 'at least one export POST fired');
	for (const call of httpCalls) {
		assert.equal(call.timeout, 10000, 'every export POST sets the 10s timeout');
	}
});
