import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	completionTextFrom,
	genAiSystemFrom,
	modelNameFrom,
	tokenUsageFrom,
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
