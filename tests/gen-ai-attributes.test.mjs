import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	completionTextFrom,
	genAiSystemFrom,
	modelNameFrom,
	tokenUsageFrom,
	toolCallsFrom,
} from '../dist/nodes/TraceExporter/shared/genAiAttributes.js';

test('genAiSystemFrom reads the provider segment of the serialized id', () => {
	assert.equal(genAiSystemFrom({ id: ['langchain', 'chat_models', 'openai', 'ChatOpenAI'] }), 'openai');
	assert.equal(genAiSystemFrom({ id: ['langchain', 'chat_models', 'anthropic', 'ChatAnthropic'] }), 'anthropic');
	assert.equal(genAiSystemFrom({ id: ['OnlyOne'] }), 'unknown');
	assert.equal(genAiSystemFrom(undefined), 'unknown');
});

test('modelNameFrom prefers invocation params, then kwargs, then class name', () => {
	assert.equal(
		modelNameFrom({ kwargs: { model: 'kwargs-model' } }, { invocation_params: { model: 'invoke-model' } }),
		'invoke-model',
	);
	assert.equal(modelNameFrom({ kwargs: { model: 'kwargs-model' } }, {}), 'kwargs-model');
	assert.equal(modelNameFrom({ kwargs: { model_name: 'kwargs-model-name' } }, undefined), 'kwargs-model-name');
	assert.equal(modelNameFrom({ id: ['langchain', 'chat_models', 'openai', 'ChatOpenAI'] }, undefined), 'ChatOpenAI');
	assert.equal(modelNameFrom(undefined, undefined), undefined);
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
		tokenUsageFrom({ generations: [[{ message: { usage_metadata: { input_tokens: 5, output_tokens: 1 } } }]] }),
		{ inputTokens: 5, outputTokens: 1 },
	);
	assert.deepEqual(tokenUsageFrom({}), {});
});

test('completionTextFrom returns first generation text when present', () => {
	assert.equal(completionTextFrom({ generations: [[{ text: 'hello' }]] }), 'hello');
	assert.equal(completionTextFrom({}), undefined);
});

test('toolCallsFrom reads LangChain-normalized message.tool_calls including id', () => {
	assert.deepEqual(
		toolCallsFrom({
			generations: [[{ message: { tool_calls: [{ id: 'tc1', name: 'calculator', args: { input: '37*91' } }] } }]],
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
									{ id: 'call_1', type: 'function', function: { name: 'calculator', arguments: '{"input":"37*91"}' } },
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
								tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'calculator', arguments: '{not json' } }],
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
							additional_kwargs: { tool_calls: [{ id: 'call_3', function: { name: 'raw', arguments: '{}' } }] },
						},
					},
				],
			],
		}),
		[{ id: 'tc1', name: 'normalized', args: {} }],
	);
});
