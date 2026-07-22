import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	completionTextFrom,
	completionValueFrom,
	genAiSystemFrom,
	modelNameFrom,
	requestDetailsFrom,
	responseDetailsFrom,
	tokenUsageFrom,
	toolCallsFrom,
} from '../dist/nodes/TraceExporter/shared/genAiAttributes.js';

test('genAiSystemFrom reads the provider segment of the serialized id', () => {
	assert.equal(
		genAiSystemFrom({ id: ['langchain', 'chat_models', 'openai', 'ChatOpenAI'] }),
		'openai',
	);
	assert.equal(
		genAiSystemFrom({ id: ['langchain', 'chat_models', 'anthropic', 'ChatAnthropic'] }),
		'anthropic',
	);
	assert.equal(genAiSystemFrom({ id: ['OnlyOne'] }), 'unknown');
	assert.equal(genAiSystemFrom(undefined), 'unknown');
});

test('modelNameFrom uses explicit model fields and never substitutes the provider class', () => {
	assert.equal(
		modelNameFrom(
			{ kwargs: { model: 'kwargs-model' } },
			{ invocation_params: { model: 'invoke-model' } },
		),
		'invoke-model',
	);
	assert.equal(modelNameFrom({ kwargs: { model: 'kwargs-model' } }, {}), 'kwargs-model');
	assert.equal(
		modelNameFrom({ kwargs: { model_name: 'kwargs-model-name' } }, undefined),
		'kwargs-model-name',
	);
	assert.equal(
		modelNameFrom({ id: ['langchain', 'chat_models', 'openai', 'ChatOpenAI'] }, undefined),
		undefined,
	);
	assert.equal(modelNameFrom(undefined, undefined), undefined);
});

test('genAiSystemFrom normalizes known provider package/class identifiers', () => {
	assert.equal(
		genAiSystemFrom({ id: ['langchain', 'chat_models', 'google_genai', 'ChatGoogleGenerativeAI'] }),
		'gcp.gemini',
	);
	assert.equal(
		genAiSystemFrom({ id: ['langchain', 'chat_models', 'google_vertexai', 'ChatVertexAI'] }),
		'gcp.vertex_ai',
	);
	assert.equal(genAiSystemFrom({ id: ['ChatOpenAI'] }), 'openai');
});

test('requestDetailsFrom extracts only explicit high-value request controls', () => {
	assert.deepEqual(
		requestDetailsFrom(undefined, {
			invocation_params: {
				n: 3,
				seed: 42,
				top_k: 20,
				streaming: true,
				reasoning_effort: 'high',
				response_format: { type: 'json_schema' },
			},
		}),
		{
			choiceCount: 3,
			seed: 42,
			topK: 20,
			stream: true,
			reasoningLevel: 'high',
			outputType: 'json',
		},
	);
});

test('tokenUsageFrom reads OpenAI-style llmOutput.tokenUsage', () => {
	assert.deepEqual(
		tokenUsageFrom({ llmOutput: { tokenUsage: { promptTokens: 10, completionTokens: 3 } } }),
		{ inputTokens: 10, outputTokens: 3 },
	);
});

test('tokenUsageFrom reads Anthropic-style llmOutput.usage', () => {
	assert.deepEqual(
		tokenUsageFrom({ llmOutput: { usage: { input_tokens: 8, output_tokens: 2 } } }),
		{ inputTokens: 8, outputTokens: 2 },
	);
});

test('tokenUsageFrom falls back to generation message usage_metadata', () => {
	assert.deepEqual(
		tokenUsageFrom({
			generations: [[{ message: { usage_metadata: { input_tokens: 5, output_tokens: 1 } } }]],
		}),
		{ inputTokens: 5, outputTokens: 1 },
	);
	assert.deepEqual(tokenUsageFrom({}), {});
});

test('completionTextFrom returns first generation text when present', () => {
	assert.equal(completionTextFrom({ generations: [[{ text: 'hello' }]] }), 'hello');
	assert.equal(completionTextFrom({}), undefined);
});

test('completionValueFrom retains structured terminal answers', () => {
	const answer = { answer: 42 };
	assert.deepEqual(completionValueFrom({ generations: [[{ text: answer }]] }), answer);
	assert.equal(completionTextFrom({ generations: [[{ text: answer }]] }), undefined);
});

test('toolCallsFrom reads LangChain-normalized message.tool_calls including id', () => {
	assert.deepEqual(
		toolCallsFrom({
			generations: [
				[
					{
						message: { tool_calls: [{ id: 'tc1', name: 'calculator', args: { input: '37*91' } }] },
					},
				],
			],
		}),
		[{ id: 'tc1', name: 'calculator', args: { input: '37*91' } }],
	);
	assert.deepEqual(toolCallsFrom({}), []);
	assert.deepEqual(toolCallsFrom({ generations: [[{ message: {} }]] }), []);
});

test('toolCallsFrom falls back to the raw OpenAI additional_kwargs shape, parsing arguments JSON', () => {
	assert.deepEqual(
		toolCallsFrom({
			generations: [
				[
					{
						message: {
							additional_kwargs: {
								tool_calls: [
									{
										id: 'call_1',
										type: 'function',
										function: { name: 'calculator', arguments: '{"input":"37*91"}' },
									},
								],
							},
						},
					},
				],
			],
		}),
		[{ id: 'call_1', name: 'calculator', args: { input: '37*91' } }],
	);
});

test('toolCallsFrom keeps malformed additional_kwargs arguments as the raw string, never throws', () => {
	assert.deepEqual(
		toolCallsFrom({
			generations: [
				[
					{
						message: {
							additional_kwargs: {
								tool_calls: [
									{
										id: 'call_2',
										type: 'function',
										function: { name: 'calculator', arguments: '{not json' },
									},
								],
							},
						},
					},
				],
			],
		}),
		[{ id: 'call_2', name: 'calculator', args: '{not json' }],
	);
	// normalized shape wins when both are present
	assert.deepEqual(
		toolCallsFrom({
			generations: [
				[
					{
						message: {
							tool_calls: [{ id: 'tc1', name: 'normalized', args: {} }],
							additional_kwargs: {
								tool_calls: [{ id: 'call_3', function: { name: 'raw', arguments: '{}' } }],
							},
						},
					},
				],
			],
		}),
		[{ id: 'tc1', name: 'normalized', args: {} }],
	);
});

test('tokenUsageFrom falls back to llmOutput.estimatedTokenUsage (openai Responses-API path)', () => {
	const usage = tokenUsageFrom({
		generations: [[{ text: 'hi' }]],
		llmOutput: {
			id: 'resp_1',
			estimatedTokenUsage: { promptTokens: 42, completionTokens: 7, totalTokens: 49 },
		},
	});
	assert.deepEqual(usage, { inputTokens: 42, outputTokens: 7 });
});

test('tokenUsageFrom prefers exact message usage_metadata over estimatedTokenUsage', () => {
	const usage = tokenUsageFrom({
		generations: [
			[{ text: 'hi', message: { usage_metadata: { input_tokens: 10, output_tokens: 2 } } }],
		],
		llmOutput: { estimatedTokenUsage: { promptTokens: 99, completionTokens: 99 } },
	});
	assert.deepEqual(usage, { inputTokens: 10, outputTokens: 2 });
});

test('responseDetailsFrom extracts response id, resolved model, and finish reason', () => {
	assert.deepEqual(
		responseDetailsFrom({
			generations: [
				[
					{
						generationInfo: { finish_reason: 'stop' },
						message: { id: 'msg-1', response_metadata: { model_name: 'gpt-4.1-2026' } },
					},
				],
			],
		}),
		{ id: 'msg-1', model: 'gpt-4.1-2026', finishReasons: ['stop'] },
	);
});

test('tokenUsageFrom preserves cache/reasoning breakdowns and normalizes Anthropic totals', () => {
	assert.deepEqual(
		tokenUsageFrom({
			llmOutput: {
				usage: {
					input_tokens: 8,
					output_tokens: 4,
					cache_read_input_tokens: 5,
					cache_creation_input_tokens: 2,
					output_token_details: { reasoning: 3 },
				},
			},
		}),
		{
			inputTokens: 15,
			outputTokens: 4,
			cacheReadInputTokens: 5,
			cacheCreationInputTokens: 2,
			reasoningOutputTokens: 3,
		},
	);
});

test('response and tool extraction covers every batch candidate with one global cap', () => {
	const output = {
		generations: [
			[
				{
					text: 'a',
					generationInfo: { finish_reason: 'stop' },
					message: { tool_calls: [{ id: 'a', name: 'one', args: {} }] },
				},
				{
					text: 'b',
					generationInfo: { finish_reason: 'length' },
					message: { tool_calls: [{ id: 'b', name: 'two', args: {} }] },
				},
			],
		],
	};
	assert.deepEqual(responseDetailsFrom(output).finishReasons, ['stop', 'length']);
	assert.deepEqual(
		toolCallsFrom(output).map((call) => call.id),
		['a', 'b'],
	);
});

test('toolCallsFrom slices a hostile oversized source before iterating or allocating', () => {
	const calls = [];
	calls.length = 1_000_000;
	for (let index = 0; index < 100; index++) {
		calls[index] = { id: `call-${index}`, name: 'tool', args: {} };
	}
	Object.defineProperty(calls, 100, {
		get() {
			throw new Error('extractor read beyond its cap');
		},
	});
	const startedAt = Date.now();
	const extracted = toolCallsFrom({ generations: [[{ message: { tool_calls: calls } }]] });
	assert.equal(extracted.length, 100);
	assert.equal(extracted[99].id, 'call-99');
	assert.ok(Date.now() - startedAt < 250, 'runtime is independent of the million-entry length');
});

test('result extractors cap hostile generation arrays before traversal', () => {
	const generations = [];
	generations.length = 1_000_000;
	generations[0] = { text: { answer: 42 }, generationInfo: { finish_reason: 'stop' } };
	Object.defineProperty(generations, 100, {
		get() {
			throw new Error('extractor read beyond the per-batch cap');
		},
	});
	const batches = [];
	batches.length = 1_000_000;
	batches[0] = generations;
	Object.defineProperty(batches, 100, {
		get() {
			throw new Error('extractor read beyond the batch cap');
		},
	});

	const output = { generations: batches };
	const startedAt = Date.now();
	assert.deepEqual(completionValueFrom(output), { answer: 42 });
	assert.deepEqual(responseDetailsFrom(output), { finishReasons: ['stop'] });
	assert.deepEqual(tokenUsageFrom(output), {});
	assert.deepEqual(toolCallsFrom(output), []);
	assert.ok(Date.now() - startedAt < 250, 'runtime is independent of hostile array length');
});
