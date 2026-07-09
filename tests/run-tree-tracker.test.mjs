import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RunTreeTracker } from '../dist/nodes/TraceExporter/shared/runTreeTracker.js';

const baseConfig = {
	capturePrompts: false,
	captureToolIO: false,
	maxPayloadBytes: 1024,
	samplingRatePercent: 100,
	baseAttributes: { 'n8n.workflow.id': 'wf-1' },
	now: () => 1000,
};

function attrMap(span) {
	return Object.fromEntries(span.attributes.map((a) => [a.key, Object.values(a.value)[0]]));
}

const OPENAI_SERIALIZED = { id: ['langchain', 'chat_models', 'openai', 'ChatOpenAI'], kwargs: { model: 'gpt-4o-mini' } };
const OPENAI_RESULT = { generations: [[{ text: 'four' }]], llmOutput: { tokenUsage: { promptTokens: 11, completionTokens: 2 } } };

test('LLM start/end emits one CLIENT span with GenAI + base attributes', () => {
	const spans = [];
	const tracker = new RunTreeTracker(baseConfig, (s) => spans.push(s));
	const handler = tracker.createHandler();
	handler.handleChatModelStart(OPENAI_SERIALIZED, [[{ content: 'hi' }]], 'run-1', 'agent-run');
	handler.handleLLMEnd(OPENAI_RESULT, 'run-1');
	assert.equal(spans.length, 1);
	const attrs = attrMap(spans[0]);
	assert.equal(spans[0].kind, 3);
	assert.equal(spans[0].name, 'llm:gpt-4o-mini');
	assert.equal(attrs['gen_ai.system'], 'openai');
	assert.equal(attrs['gen_ai.request.model'], 'gpt-4o-mini');
	assert.equal(attrs['gen_ai.usage.input_tokens'], '11');
	assert.equal(attrs['gen_ai.usage.output_tokens'], '2');
	assert.equal(attrs['n8n.workflow.id'], 'wf-1');
	assert.equal(attrs['gen_ai.prompt'], undefined, 'prompts must not be captured by default');
	assert.equal(attrs['gen_ai.completion'], undefined, 'completions must not be captured by default');
});

test('two LLM runs under the same unseen parent share a traceId, no parentSpanId', () => {
	const spans = [];
	const tracker = new RunTreeTracker(baseConfig, (s) => spans.push(s));
	const handler = tracker.createHandler();
	handler.handleChatModelStart(OPENAI_SERIALIZED, [[]], 'run-1', 'agent-run');
	handler.handleLLMEnd(OPENAI_RESULT, 'run-1');
	handler.handleChatModelStart(OPENAI_SERIALIZED, [[]], 'run-2', 'agent-run');
	handler.handleLLMEnd(OPENAI_RESULT, 'run-2');
	assert.equal(spans.length, 2);
	assert.equal(spans[0].traceId, spans[1].traceId);
	assert.notEqual(spans[0].spanId, spans[1].spanId);
	assert.equal(spans[0].parentSpanId, undefined);
});

test('a run under an observed parent gets real parentage', () => {
	const spans = [];
	const tracker = new RunTreeTracker(baseConfig, (s) => spans.push(s));
	const handler = tracker.createHandler();
	handler.handleChainStart({ id: ['langchain', 'agents', 'AgentExecutor'] }, {}, 'chain-1', undefined);
	handler.handleChatModelStart(OPENAI_SERIALIZED, [[]], 'run-1', 'chain-1');
	handler.handleLLMEnd(OPENAI_RESULT, 'run-1');
	handler.handleChainEnd({}, 'chain-1');
	assert.equal(spans.length, 2);
	const [llmSpan, chainSpan] = spans;
	assert.equal(llmSpan.traceId, chainSpan.traceId);
	assert.equal(llmSpan.parentSpanId, chainSpan.spanId);
});

test('capturePrompts=true captures truncated prompt and completion', () => {
	const spans = [];
	const tracker = new RunTreeTracker(
		{ ...baseConfig, capturePrompts: true, maxPayloadBytes: 10 },
		(s) => spans.push(s),
	);
	const handler = tracker.createHandler();
	handler.handleLLMStart(OPENAI_SERIALIZED, ['a very long prompt that exceeds ten bytes'], 'run-1');
	handler.handleLLMEnd(OPENAI_RESULT, 'run-1');
	const attrs = attrMap(spans[0]);
	assert.equal(attrs['gen_ai.prompt'], 'a very lon…[truncated]');
	assert.equal(attrs['gen_ai.completion'], 'four');
});

test('LLM error closes the span with ERROR status', () => {
	const spans = [];
	const tracker = new RunTreeTracker(baseConfig, (s) => spans.push(s));
	const handler = tracker.createHandler();
	handler.handleChatModelStart(OPENAI_SERIALIZED, [[]], 'run-1');
	handler.handleLLMError(new Error('boom'), 'run-1');
	assert.equal(spans.length, 1);
	assert.equal(spans[0].status.code, 2);
	assert.match(spans[0].status.message, /boom/);
});

test('tool start/end emits a span; input/output only with captureToolIO', () => {
	const spans = [];
	const tracker = new RunTreeTracker({ ...baseConfig, captureToolIO: true }, (s) => spans.push(s));
	const handler = tracker.createHandler();
	handler.handleToolStart({ id: ['langchain', 'tools', 'Calculator'] }, '37*91', 'tool-1', 'agent-run');
	handler.handleToolEnd('3367', 'tool-1');
	assert.equal(spans.length, 1);
	const attrs = attrMap(spans[0]);
	assert.equal(spans[0].name, 'tool:Calculator');
	assert.equal(attrs['tool.input'], '37*91');
	assert.equal(attrs['tool.output'], '3367');
});

test('samplingRatePercent=0 suppresses emission but still records events', () => {
	const spans = [];
	const tracker = new RunTreeTracker({ ...baseConfig, samplingRatePercent: 0 }, (s) => spans.push(s));
	const handler = tracker.createHandler();
	handler.handleChatModelStart(OPENAI_SERIALIZED, [[]], 'run-1', 'agent-run');
	handler.handleLLMEnd(OPENAI_RESULT, 'run-1');
	assert.equal(spans.length, 0);
	assert.equal(tracker.events.length, 2);
});

test('every hook records an event and never throws, even on garbage input', () => {
	const tracker = new RunTreeTracker(baseConfig, () => {
		throw new Error('emit exploded');
	});
	const handler = tracker.createHandler();
	handler.handleChatModelStart(null, null, 'run-1');
	handler.handleLLMEnd(null, 'run-1');
	handler.handleLLMEnd(null, 'never-started');
	handler.handleAgentAction({ tool: 'calc' }, 'a-1', 'agent-run');
	assert.equal(tracker.events.length, 4);
	assert.ok(tracker.handlerErrors >= 1, 'emit explosion must be swallowed and counted');
});

test('onEvent callback receives each event (live-run logging path)', () => {
	const seen = [];
	const tracker = new RunTreeTracker({ ...baseConfig, onEvent: (e) => seen.push(e.hook) }, () => {});
	const handler = tracker.createHandler();
	handler.handleToolStart({ id: ['Calculator'] }, 'x', 't-1');
	handler.handleToolEnd('y', 't-1');
	assert.deepEqual(seen, ['handleToolStart', 'handleToolEnd']);
});
