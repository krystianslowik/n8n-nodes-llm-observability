import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createExecutionStateHandler } from '../dist/nodes/TraceExporter/shared/n8nExecutionState.js';

function fakeCtx() {
	const inputCalls = [];
	const outputCalls = [];
	return {
		inputCalls,
		outputCalls,
		ctx: {
			addInputData: (connectionType, data) => {
				const index = inputCalls.length + 4;
				inputCalls.push([connectionType, data, index]);
				return { index };
			},
			addOutputData: (...args) => outputCalls.push(args),
			getNode: () => ({ name: 'Trace Exporter', type: 'traceExporter' }),
		},
	};
}

const LLM = {
	id: ['langchain', 'chat_models', 'openai', 'ChatOpenAI'],
	kwargs: { model: 'gpt-4o-mini' },
};

test('execution-state handler pairs addInputData/addOutputData and keeps content private', () => {
	const { ctx, inputCalls, outputCalls } = fakeCtx();
	const handler = createExecutionStateHandler(ctx);
	assert.equal(handler.awaitHandlers, true);
	assert.equal(
		handler.handleChatModelStart,
		undefined,
		'LangChain must use its chat-to-LLMStart fallback, matching n8n core tracing',
	);

	handler.handleLLMStart(LLM, ['private prompt'], 'run-1');
	handler.handleLLMStart(LLM, ['duplicate callback'], 'run-1');

	assert.equal(inputCalls.length, 1, 'one n8n run is opened per LangChain runId');
	assert.equal(inputCalls[0][0], 'ai_languageModel');
	assert.deepEqual(inputCalls[0][1], [[{ json: { provider: 'openai', model: 'gpt-4o-mini' } }]]);
	assert.ok(
		!JSON.stringify(inputCalls).includes('private prompt'),
		'prompt text is not duplicated into UI state',
	);

	const output = {
		generations: [
			[{ text: 'private completion', message: { tool_calls: [{ name: 'secret-tool' }] } }],
		],
		llmOutput: { tokenUsage: { promptTokens: 12, completionTokens: 3 } },
	};
	const before = JSON.stringify(output);
	handler.handleLLMEnd(output, 'run-1');

	assert.equal(
		JSON.stringify(output),
		before,
		'execution reporting never mutates the shared provider result',
	);
	assert.equal(outputCalls.length, 1);
	assert.equal(outputCalls[0][0], 'ai_languageModel');
	assert.equal(outputCalls[0][1], 4, 'completion closes the exact index returned at start');
	assert.deepEqual(outputCalls[0][2], [
		[
			{
				json: {
					provider: 'openai',
					model: 'gpt-4o-mini',
					inputTokens: 12,
					outputTokens: 3,
				},
			},
		],
	]);
	assert.ok(!JSON.stringify(outputCalls).includes('private completion'));
});

test('execution-state handler maps concurrent runIds independently and reports model errors', () => {
	const { ctx, inputCalls, outputCalls } = fakeCtx();
	const handler = createExecutionStateHandler(ctx);

	handler.handleLLMStart(LLM, [], 'run-a');
	handler.handleLLMStart(
		{ id: ['langchain', 'chat_models', 'anthropic', 'ChatAnthropic'], kwargs: { model: 'claude' } },
		[],
		'run-b',
	);
	handler.handleLLMEnd({}, 'run-b');
	handler.handleLLMError(new Error('provider failed'), 'run-a');

	assert.equal(inputCalls.length, 2);
	assert.equal(outputCalls.length, 2);
	assert.equal(outputCalls[0][1], 5, 'run-b closes its own later index first');
	assert.equal(outputCalls[1][1], 4, 'run-a still closes its original index');
	assert.ok(outputCalls[1][2] instanceof Error);
	assert.match(outputCalls[1][2].message, /provider failed/);

	handler.handleLLMEnd({}, 'run-a');
	handler.handleLLMEnd({}, 'never-started');
	assert.equal(outputCalls.length, 2, 'closed and unknown runIds cannot create phantom UI runs');
});

test('execution-state reporting is best-effort and never throws when n8n bookkeeping fails', () => {
	const handler = createExecutionStateHandler({
		addInputData: () => {
			throw new Error('run data unavailable');
		},
		addOutputData: () => {
			throw new Error('run data unavailable');
		},
		getNode: () => ({ name: 'Trace Exporter' }),
	});

	assert.doesNotThrow(() => handler.handleLLMStart(LLM, [], 'run-1'));
	assert.doesNotThrow(() => handler.handleLLMEnd({}, 'run-1'));
	assert.doesNotThrow(() => handler.handleLLMError(new Error('model failed'), 'run-1'));
});

test('execution-state data exposes trace and root span IDs for backend correlation', () => {
	const { ctx, inputCalls, outputCalls } = fakeCtx();
	const traceContext = {
		tracing: 'attached',
		sampling: 'sampled',
		exportStatus: 'queued',
		traceId: 'a'.repeat(32),
		rootSpanId: 'b'.repeat(16),
	};
	const handler = createExecutionStateHandler(ctx, () => traceContext);

	handler.handleLLMStart(LLM, [], 'run-1');
	handler.handleLLMEnd({}, 'run-1');

	assert.equal(inputCalls[0][1][0][0].json.traceId, traceContext.traceId);
	assert.equal(inputCalls[0][1][0][0].json.rootSpanId, traceContext.rootSpanId);
	assert.equal(outputCalls[0][2][0][0].json.traceId, traceContext.traceId);
	assert.equal(outputCalls[0][2][0][0].json.rootSpanId, traceContext.rootSpanId);
	assert.equal(outputCalls[0][2][0][0].json.sampling, 'sampled');
	assert.equal(outputCalls[0][2][0][0].json.exportStatus, 'queued');
});

test('execution-state data reports unsampled runs without correlation IDs', () => {
	const { ctx, inputCalls, outputCalls } = fakeCtx();
	const handler = createExecutionStateHandler(ctx, () => ({
		tracing: 'attached',
		sampling: 'notSampled',
		exportStatus: 'notSampled',
	}));

	handler.handleLLMStart(LLM, [], 'run-1');
	handler.handleLLMEnd({}, 'run-1');

	for (const json of [inputCalls[0][1][0][0].json, outputCalls[0][2][0][0].json]) {
		assert.equal(json.tracing, 'attached');
		assert.equal(json.sampling, 'notSampled');
		assert.equal(json.exportStatus, 'notSampled');
		assert.equal('traceId' in json, false);
		assert.equal('rootSpanId' in json, false);
	}
});
