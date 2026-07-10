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

const OPENAI_SERIALIZED = {
	id: ['langchain', 'chat_models', 'openai', 'ChatOpenAI'],
	kwargs: { model: 'gpt-4o-mini' },
};
const OPENAI_RESULT = {
	generations: [[{ text: 'four' }]],
	llmOutput: { tokenUsage: { promptTokens: 11, completionTokens: 2 } },
};

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
	assert.equal(
		attrs['gen_ai.input.messages'],
		undefined,
		'prompts must not be captured by default',
	);
	assert.equal(
		attrs['gen_ai.output.messages'],
		undefined,
		'completions must not be captured by default',
	);
	assert.ok(
		!('status' in spans[0]),
		'successful spans leave status UNSET (omitted) per OTel convention',
	);
});

test('successful chain/tool spans leave status UNSET; only errors carry a status', () => {
	const spans = [];
	const tracker = new RunTreeTracker(baseConfig, (s) => spans.push(s));
	const handler = tracker.createHandler();
	handler.handleChainStart(
		{ id: ['langchain', 'agents', 'AgentExecutor'] },
		{},
		'chain-1',
		undefined,
	);
	handler.handleToolStart({ id: ['langchain', 'tools', 'Calculator'] }, 'x', 'tool-1', 'chain-1');
	handler.handleToolEnd('y', 'tool-1');
	handler.handleChainEnd({}, 'chain-1');
	assert.equal(spans.length, 2);
	for (const span of spans) {
		assert.ok(!('status' in span), `${span.name}: success -> no status field`);
	}
	handler.handleToolStart({ id: ['langchain', 'tools', 'Calculator'] }, 'x', 'tool-2', undefined);
	handler.handleToolError(new Error('kaput'), 'tool-2');
	assert.equal(spans[2].status.code, 2, 'failures still carry ERROR');
	assert.match(spans[2].status.message, /kaput/);
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
	handler.handleChainStart(
		{ id: ['langchain', 'agents', 'AgentExecutor'] },
		{},
		'chain-1',
		undefined,
	);
	handler.handleChatModelStart(OPENAI_SERIALIZED, [[]], 'run-1', 'chain-1');
	handler.handleLLMEnd(OPENAI_RESULT, 'run-1');
	handler.handleChainEnd({}, 'chain-1');
	assert.equal(spans.length, 2);
	const [llmSpan, chainSpan] = spans;
	assert.equal(llmSpan.traceId, chainSpan.traceId);
	assert.equal(llmSpan.parentSpanId, chainSpan.spanId);
});

test('capturePrompts=true captures truncated input and structured output messages', () => {
	const spans = [];
	const tracker = new RunTreeTracker(
		{ ...baseConfig, capturePrompts: true, maxPayloadBytes: 128 },
		(s) => spans.push(s),
	);
	const handler = tracker.createHandler();
	handler.handleLLMStart(OPENAI_SERIALIZED, ['a'.repeat(200)], 'run-1');
	handler.handleLLMEnd(OPENAI_RESULT, 'run-1');
	const attrs = attrMap(spans[0]);
	assert.ok(String(attrs['gen_ai.input.messages']).endsWith('…[truncated]'));
	assert.ok(String(attrs['gen_ai.output.messages']).includes('four'));
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
	handler.handleToolStart(
		{ id: ['langchain', 'tools', 'Calculator'] },
		'37*91',
		'tool-1',
		'agent-run',
	);
	handler.handleToolEnd('3367', 'tool-1');
	assert.equal(spans.length, 1);
	const attrs = attrMap(spans[0]);
	assert.equal(spans[0].name, 'execute_tool Calculator');
	assert.equal(attrs['gen_ai.operation.name'], 'execute_tool');
	assert.equal(attrs['gen_ai.tool.call.arguments'], '37*91');
	assert.equal(attrs['gen_ai.tool.call.result'], '3367');
	assert.equal(
		attrs['lk.function_tool.name'],
		'Calculator',
		'Opik tool-span type compatibility marker',
	);
});

test('samplingRatePercent=0 suppresses emission but still records events', () => {
	const spans = [];
	const tracker = new RunTreeTracker({ ...baseConfig, samplingRatePercent: 0 }, (s) =>
		spans.push(s),
	);
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
	const tracker = new RunTreeTracker(
		{ ...baseConfig, onEvent: (e) => seen.push(e.hook) },
		() => {},
	);
	const handler = tracker.createHandler();
	handler.handleToolStart({ id: ['Calculator'] }, 'x', 't-1');
	handler.handleToolEnd('y', 't-1');
	assert.deepEqual(seen, ['handleToolStart', 'handleToolEnd']);
});

test('singleTrace groups parentless runs and distinct unseen parents into one trace', () => {
	const spans = [];
	const tracker = new RunTreeTracker({ ...baseConfig, singleTrace: true }, (s) => spans.push(s));
	const handler = tracker.createHandler();
	handler.handleChatModelStart(OPENAI_SERIALIZED, [[]], 'run-1', 'unseen-parent-A');
	handler.handleLLMEnd(OPENAI_RESULT, 'run-1');
	handler.handleChatModelStart(OPENAI_SERIALIZED, [[]], 'run-2', 'unseen-parent-B');
	handler.handleLLMEnd(OPENAI_RESULT, 'run-2');
	handler.handleChatModelStart(OPENAI_SERIALIZED, [[]], 'run-3', undefined);
	handler.handleLLMEnd(OPENAI_RESULT, 'run-3');
	// 3 LLM spans + 1 synthetic root. The root is found by parentage because
	// it is emitted after the first final model answer, not before child spans.
	assert.equal(spans.length, 4);
	assert.ok(spans.every((s) => s.traceId === spans[0].traceId));
	const root = spans.find((span) => span.parentSpanId === undefined);
	assert.equal(root.kind, 1, 'root is INTERNAL');
	assert.equal(root.parentSpanId, undefined);
	assert.ok(!('status' in root), 'successful root leaves status UNSET (omitted)');
	for (const llmSpan of spans.filter((span) => span.name.startsWith('llm:'))) {
		assert.equal(llmSpan.parentSpanId, root.spanId, 'llm spans parented under the synthetic root');
	}
});

test('chat messages serialize to the OTel role/parts schema, not [object Object]', () => {
	const spans = [];
	const tracker = new RunTreeTracker({ ...baseConfig, capturePrompts: true }, (s) => spans.push(s));
	const handler = tracker.createHandler();
	const message = { content: 'What is 37*91?', _getType: () => 'human' };
	handler.handleChatModelStart(OPENAI_SERIALIZED, [[message]], 'run-1');
	handler.handleLLMEnd(OPENAI_RESULT, 'run-1');
	const attrs = attrMap(spans[0]);
	assert.ok(String(attrs['gen_ai.input.messages']).includes('What is 37*91?'), 'content present');
	assert.ok(
		String(attrs['gen_ai.input.messages']).includes('"role":"user"'),
		'normalized role present',
	);
	assert.ok(
		String(attrs['gen_ai.input.messages']).includes('"parts"'),
		'OTel message parts present',
	);
	assert.ok(!String(attrs['gen_ai.input.messages']).includes('[object Object]'));
});

test('model-decided tool calls surface in gen_ai.output.messages when captureToolIO is on', () => {
	const spans = [];
	const tracker = new RunTreeTracker({ ...baseConfig, captureToolIO: true }, (s) => spans.push(s));
	const handler = tracker.createHandler();
	handler.handleChatModelStart(OPENAI_SERIALIZED, [[]], 'run-1');
	handler.handleLLMEnd(
		{
			generations: [
				[
					{
						message: { tool_calls: [{ name: 'calculator', args: { input: '37*91' }, id: 'tc1' }] },
					},
				],
			],
		},
		'run-1',
	);
	const attrs = attrMap(spans[0]);
	assert.ok(String(attrs['gen_ai.output.messages']).includes('calculator'));
	assert.ok(String(attrs['gen_ai.output.messages']).includes('37*91'));

	const spansOff = [];
	const trackerOff = new RunTreeTracker(baseConfig, (s) => spansOff.push(s));
	const handlerOff = trackerOff.createHandler();
	handlerOff.handleChatModelStart(OPENAI_SERIALIZED, [[]], 'run-1');
	handlerOff.handleLLMEnd(
		{ generations: [[{ message: { tool_calls: [{ name: 'calculator', args: {}, id: 'tc1' }] } }]] },
		'run-1',
	);
	assert.equal(attrMap(spansOff[0])['gen_ai.output.messages'], undefined, 'off by default');
});

/** Runs one prompt through capture+truncation, returns gen_ai.input.messages. */
function capturedPrompt(text, maxPayloadBytes) {
	const spans = [];
	const tracker = new RunTreeTracker(
		{ ...baseConfig, capturePrompts: true, maxPayloadBytes },
		(s) => spans.push(s),
	);
	const handler = tracker.createHandler();
	handler.handleLLMStart(OPENAI_SERIALIZED, [text], 'run-1');
	handler.handleLLMEnd(OPENAI_RESULT, 'run-1');
	return attrMap(spans[0])['gen_ai.input.messages'];
}

test('truncation budget is UTF-8 bytes: pure ASCII exactly at the limit passes untouched', () => {
	assert.equal(capturedPrompt('abcdefghij', 10), 'abcdefghij');
	// One over: the marker's 14 UTF-8 bytes are reserved INSIDE the budget,
	// so the content is cut deeper — the output never exceeds maxPayloadBytes.
	assert.equal(capturedPrompt('a'.repeat(25), 24), `${'a'.repeat(10)}…[truncated]`);
	assert.equal(new TextEncoder().encode(capturedPrompt('a'.repeat(25), 24)).length, 24);
	// A budget smaller than the marker itself floors at marker-only output.
	assert.equal(capturedPrompt('abcdefghijk', 10), '…[truncated]');
});

test('multi-byte payload that fits by UTF-16 length but exceeds the byte budget is truncated', () => {
	// 10 UTF-16 code units (would pass a code-unit check against 20) but
	// 30 UTF-8 bytes — content must fit 20-14=6 bytes: two 3-byte kanji.
	const prompt = capturedPrompt('日本語です日本語です', 20);
	assert.equal(prompt, '日本…[truncated]');
	assert.ok(new TextEncoder().encode(prompt).length <= 20, 'marker included, still within budget');
});

test('byte truncation landing mid-emoji backs off to a valid boundary (no lone surrogate)', () => {
	// Each 😀 is 2 UTF-16 code units / 4 UTF-8 bytes; a 21-byte budget leaves
	// 7 content bytes — landing between the second emoji's surrogate halves.
	const prompt = capturedPrompt('😀'.repeat(6), 21);
	assert.equal(prompt, '😀…[truncated]');
	const content = prompt.replace('…[truncated]', '');
	const withoutPairs = content.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '');
	assert.ok(!/[\uD800-\uDFFF]/.test(withoutPairs), 'no lone surrogate in the truncated payload');
	assert.ok(!prompt.includes('�'), 'no replacement character in the truncated payload');
	assert.ok(new TextEncoder().encode(prompt).length <= 21, 'marker included, still within budget');
});

// --- Model-side tool-span synthesis -----------------------------------------

const humanMsg = { content: 'What is 37*91?', _getType: () => 'human' };
const toolResultMsg = (toolCallId, content) => ({
	content,
	tool_call_id: toolCallId,
	_getType: () => 'tool',
});
const llmEndWithToolCalls = (calls) => ({ generations: [[{ message: { tool_calls: calls } }]] });

/**
 * Full agent loop through the model seat: chatModelStart -> llmEnd requesting
 * two tools -> chatModelStart echoing both tool RESULTS -> llmEnd (final
 * answer). Returns { spans, clock } with an injectable stepping clock.
 */
function runToolLoop(configOverrides = {}) {
	const spans = [];
	const clock = { at: 1000 };
	const tracker = new RunTreeTracker(
		{ ...baseConfig, singleTrace: true, now: () => clock.at, ...configOverrides },
		(s) => spans.push(s),
	);
	const handler = tracker.createHandler();
	handler.handleChatModelStart(OPENAI_SERIALIZED, [[humanMsg]], 'run-1', 'agent-run');
	clock.at = 2000;
	handler.handleLLMEnd(
		llmEndWithToolCalls([
			{ id: 'tc1', name: 'calculator', args: { input: '37*91' } },
			{ id: 'tc2', name: 'search', args: { q: 'x' } },
		]),
		'run-1',
	);
	clock.at = 3000;
	handler.handleChatModelStart(
		OPENAI_SERIALIZED,
		[
			[
				humanMsg,
				{
					content: 'Calling calculator with input: {"input":"37*91","id":"tc1"}',
					_getType: () => 'ai',
				},
				toolResultMsg('tc1', '3367'),
				toolResultMsg('tc2', 'found x'),
			],
		],
		'run-2',
		'agent-run',
	);
	clock.at = 4000;
	handler.handleLLMEnd(OPENAI_RESULT, 'run-2');
	return { spans, tracker };
}

test('tool results echoed into the next model call synthesize tool spans under the shared root', () => {
	const { spans } = runToolLoop({ capturePrompts: true, captureToolIO: true });
	// llm-1, execute_tool calculator, execute_tool search, llm-2, final root
	assert.equal(spans.length, 5);
	const root = spans.find((span) => span.parentSpanId === undefined);
	const toolSpans = spans.filter((span) => span.name.startsWith('execute_tool '));
	const [toolSpan1, toolSpan2] = toolSpans;
	assert.equal(toolSpan1.name, 'execute_tool calculator');
	assert.equal(toolSpan2.name, 'execute_tool search');
	for (const span of toolSpans) {
		assert.equal(span.parentSpanId, root.spanId, 'synthesized spans parent under the shared root');
		assert.equal(span.traceId, root.traceId);
		assert.equal(span.kind, 1, 'synthesized tool spans are INTERNAL');
		// timing is reconstructed from the surrounding LLM-call boundaries
		assert.equal(
			span.startTimeUnixNano,
			'2000000000',
			'start == the llmEnd that requested the tool',
		);
		assert.equal(
			span.endTimeUnixNano,
			'3000000000',
			'end == the chatModelStart that echoed the result',
		);
		assert.ok(!('status' in span), 'synthesized spans leave status UNSET');
		const attrs = attrMap(span);
		assert.equal(attrs['gen_ai.operation.name'], 'execute_tool');
		assert.equal(attrs['n8n.span.synthesized'], true);
		assert.equal(attrs['n8n.tool.result_observed'], undefined, 'observed results carry no marker');
		assert.equal(attrs['n8n.workflow.id'], 'wf-1', 'base attributes stamped');
	}
	const attrs1 = attrMap(toolSpan1);
	assert.equal(attrs1['gen_ai.tool.name'], 'calculator');
	assert.equal(attrs1['gen_ai.tool.call.id'], 'tc1');
	assert.ok(String(attrs1['gen_ai.tool.call.arguments']).includes('37*91'));
	assert.equal(attrs1['gen_ai.tool.call.result'], '3367');
	assert.equal(attrs1['lk.function_tool.name'], 'calculator');
	const attrs2 = attrMap(toolSpan2);
	assert.equal(attrs2['gen_ai.tool.name'], 'search');
	assert.equal(attrs2['gen_ai.tool.call.id'], 'tc2');
	assert.equal(attrs2['gen_ai.tool.call.result'], 'found x');
	const rootAttrs = attrMap(root);
	assert.ok(
		String(rootAttrs.input).includes('What is 37*91?'),
		'root carries the first model input',
	);
	assert.equal(rootAttrs.output, 'four', 'root carries the final model output');
	assert.equal(root.endTimeUnixNano, '4000000000', 'root closes with the final model answer');
});

test('V3 Calling <tool> message reconstructs a tool when gpt-5 Responses omits tool_calls', () => {
	const spans = [];
	const clock = { at: 1000 };
	const tracker = new RunTreeTracker(
		{
			...baseConfig,
			singleTrace: true,
			capturePrompts: true,
			captureToolIO: true,
			now: () => clock.at,
		},
		(span) => spans.push(span),
	);
	const handler = tracker.createHandler();
	handler.handleChatModelStart(OPENAI_SERIALIZED, [[humanMsg]], 'run-1');
	clock.at = 2000;
	// Exact failure shape observed with gpt-5-mini: empty text and no
	// message.tool_calls on the end callback.
	handler.handleLLMEnd({ generations: [[{ text: '' }]] }, 'run-1');
	clock.at = 3000;
	handler.handleChatModelStart(
		OPENAI_SERIALIZED,
		[
			[
				humanMsg,
				{
					content:
						'Calling Calculator with input: {"input":"2*2","id":"call_VBiorDDpqoR6HBqi4WWF0wVW"}',
					_getType: () => 'ai',
				},
				{ content: '[{"response":"4"}]', _getType: () => 'tool' },
			],
		],
		'run-2',
	);
	clock.at = 4000;
	handler.handleLLMEnd({ generations: [[{ text: '4' }]] }, 'run-2');

	const toolSpans = spans.filter((span) => span.name.startsWith('execute_tool '));
	assert.equal(toolSpans.length, 1, 'one first-class tool span is reconstructed');
	const attrs = attrMap(toolSpans[0]);
	assert.equal(toolSpans[0].name, 'execute_tool Calculator');
	assert.equal(attrs['gen_ai.tool.call.id'], 'call_VBiorDDpqoR6HBqi4WWF0wVW');
	assert.ok(String(attrs['gen_ai.tool.call.arguments']).includes('2*2'));
	assert.ok(
		!String(attrs['gen_ai.tool.call.arguments']).includes('call_VBiorDDpqoR6HBqi4WWF0wVW'),
		'the correlation ID is not duplicated inside tool arguments',
	);
	assert.equal(attrs['gen_ai.tool.call.result'], '[{"response":"4"}]');
	assert.equal(attrs['lk.function_tool.name'], 'Calculator');
	assert.equal(toolSpans[0].startTimeUnixNano, '2000000000');
	assert.equal(toolSpans[0].endTimeUnixNano, '3000000000');

	const root = spans.find((span) => span.parentSpanId === undefined);
	assert.equal(attrMap(root).output, '4', 'the trace root carries the final answer');
	tracker.finalize();
	assert.equal(
		spans.filter((span) => span.name.startsWith('execute_tool ')).length,
		1,
		'fallback reconstruction does not leave a duplicate pending call',
	);
});

test('synthesized tool spans omit arguments/result when captureToolIO is off', () => {
	const { spans } = runToolLoop({ captureToolIO: false });
	assert.equal(spans.length, 5);
	for (const span of spans.filter((candidate) => candidate.name.startsWith('execute_tool '))) {
		const attrs = attrMap(span);
		assert.equal(attrs['gen_ai.tool.name'] !== undefined, true, 'tool name still present');
		assert.equal(attrs['gen_ai.tool.call.arguments'], undefined);
		assert.equal(attrs['gen_ai.tool.call.result'], undefined);
	}
});

test('finalize flushes a tool call whose result never reached a later model call', () => {
	const spans = [];
	const clock = { at: 1000 };
	const tracker = new RunTreeTracker(
		{ ...baseConfig, singleTrace: true, captureToolIO: true, now: () => clock.at },
		(s) => spans.push(s),
	);
	const handler = tracker.createHandler();
	handler.handleChatModelStart(OPENAI_SERIALIZED, [[humanMsg]], 'run-1', 'agent-run');
	clock.at = 2000;
	handler.handleLLMEnd(
		llmEndWithToolCalls([{ id: 'tc1', name: 'calculator', args: { input: '1+1' } }]),
		'run-1',
	);
	// no further model call (tool errored mid-flight) — execution end fires finalize
	clock.at = 5000;
	tracker.finalize();
	assert.equal(spans.length, 3, 'llm span, flushed tool span, final root');
	const toolSpan = spans.find((span) => span.name === 'execute_tool calculator');
	const root = spans.find((span) => span.parentSpanId === undefined);
	assert.ok(toolSpan);
	assert.equal(toolSpan.parentSpanId, root.spanId);
	assert.equal(toolSpan.startTimeUnixNano, '2000000000');
	assert.equal(toolSpan.endTimeUnixNano, '5000000000');
	assert.ok(!('status' in toolSpan));
	const attrs = attrMap(toolSpan);
	assert.equal(attrs['n8n.tool.result_observed'], false);
	assert.equal(attrs['gen_ai.tool.call.result'], undefined, 'no output was ever observed');
	assert.ok(String(attrs['gen_ai.tool.call.arguments']).includes('1+1'));
	// finalize is idempotent for the ledger — a second call emits nothing new
	tracker.finalize();
	assert.equal(spans.length, 3);
});

test('sampling off suppresses synthesized tool spans too', () => {
	const { spans, tracker } = runToolLoop({ captureToolIO: true, samplingRatePercent: 0 });
	assert.equal(spans.length, 0);
	tracker.finalize();
	assert.equal(spans.length, 0);
});

test('pending-tool-call ledger caps at 100: source capped per result, oldest dropped across results', () => {
	const spans = [];
	const tracker = new RunTreeTracker({ ...baseConfig, singleTrace: true }, (s) => spans.push(s));
	const handler = tracker.createHandler();
	// A single oversized response is capped at the extractor: only the FIRST
	// 100 of 150 calls are ever mapped/ledgered.
	handler.handleChatModelStart(OPENAI_SERIALIZED, [[humanMsg]], 'run-1', 'agent-run');
	const calls = Array.from({ length: 150 }, (_, i) => ({
		id: `t${i}`,
		name: `tool-${i}`,
		args: {},
	}));
	handler.handleLLMEnd(llmEndWithToolCalls(calls), 'run-1');
	// A second model call adds 50 more: the ledger drops the 50 OLDEST.
	handler.handleChatModelStart(OPENAI_SERIALIZED, [[humanMsg]], 'run-2', 'agent-run');
	const more = Array.from({ length: 50 }, (_, i) => ({
		id: `u${i}`,
		name: `tool-u${i}`,
		args: {},
	}));
	handler.handleLLMEnd(llmEndWithToolCalls(more), 'run-2');
	tracker.finalize();
	const toolSpans = spans.filter((s) => s.name.startsWith('execute_tool '));
	assert.equal(toolSpans.length, 100, 'ledger holds at most 100 pending calls');
	assert.equal(
		attrMap(toolSpans[0])['gen_ai.tool.call.id'],
		't50',
		'oldest ledgered entries were dropped',
	);
	assert.equal(attrMap(toolSpans[49])['gen_ai.tool.call.id'], 't99');
	assert.equal(attrMap(toolSpans[50])['gen_ai.tool.call.id'], 'u0');
	assert.equal(attrMap(toolSpans[99])['gen_ai.tool.call.id'], 'u49');
});

test('a malformed 10k-entry tool_calls array completes fast and the ledger holds exactly the cap', () => {
	const spans = [];
	const tracker = new RunTreeTracker({ ...baseConfig, singleTrace: true }, (s) => spans.push(s));
	const handler = tracker.createHandler();
	handler.handleChatModelStart(OPENAI_SERIALIZED, [[humanMsg]], 'run-1', 'agent-run');
	const calls = Array.from({ length: 10000 }, (_, i) => ({ id: `t${i}`, name: 'x', args: {} }));
	const startedAt = Date.now();
	handler.handleLLMEnd(llmEndWithToolCalls(calls), 'run-1');
	assert.ok(Date.now() - startedAt < 500, 'giant tool_calls payload must not block (was O(N²))');
	tracker.finalize();
	assert.equal(
		spans.filter((s) => s.name.startsWith('execute_tool ')).length,
		100,
		'ledger holds exactly the cap',
	);
});

test('a stray handleLLMEnd for an unknown run must not ledger tool calls', () => {
	const spans = [];
	const tracker = new RunTreeTracker({ ...baseConfig, singleTrace: true }, (s) => spans.push(s));
	const handler = tracker.createHandler();
	handler.handleLLMEnd(
		llmEndWithToolCalls([{ id: 'tc1', name: 'calculator', args: {} }]),
		'never-started',
	);
	tracker.finalize();
	assert.equal(spans.length, 0, 'no phantom root or tool spans at finalize');
	assert.equal(tracker.handlerErrors, 0);
});

test('empty-string tool ids never match: two id-less calls flush unmatched instead of cross-matching', () => {
	const spans = [];
	const tracker = new RunTreeTracker(
		{ ...baseConfig, singleTrace: true, captureToolIO: true },
		(s) => spans.push(s),
	);
	const handler = tracker.createHandler();
	handler.handleChatModelStart(OPENAI_SERIALIZED, [[humanMsg]], 'run-1', 'agent-run');
	handler.handleLLMEnd(
		llmEndWithToolCalls([
			{ id: '', name: 'alpha', args: { a: 1 } },
			{ id: '', name: 'beta', args: { b: 2 } },
		]),
		'run-1',
	);
	handler.handleChatModelStart(
		OPENAI_SERIALIZED,
		[[toolResultMsg('', 'whose result is this?')]],
		'run-2',
		'agent-run',
	);
	handler.handleLLMEnd(OPENAI_RESULT, 'run-2');
	assert.equal(
		spans.filter((s) => s.name.startsWith('execute_tool ')).length,
		0,
		"'' must not match anything",
	);
	tracker.finalize();
	const toolSpans = spans.filter((s) => s.name.startsWith('execute_tool '));
	assert.equal(toolSpans.length, 2, 'both flushed at execution end instead');
	for (const span of toolSpans) {
		assert.equal(attrMap(span)['n8n.tool.result_observed'], false);
		assert.equal(
			attrMap(span)['gen_ai.tool.call.result'],
			undefined,
			'the ambiguous result was never attributed',
		);
	}
});

test('non-string tool name/id: span name falls back to unknown, attributes omitted', () => {
	const spans = [];
	const tracker = new RunTreeTracker({ ...baseConfig, singleTrace: true }, (s) => spans.push(s));
	const handler = tracker.createHandler();
	handler.handleChatModelStart(OPENAI_SERIALIZED, [[humanMsg]], 'run-1', 'agent-run');
	handler.handleLLMEnd(llmEndWithToolCalls([{ id: 123, name: { evil: true }, args: {} }]), 'run-1');
	tracker.finalize();
	const toolSpans = spans.filter((s) => s.name.startsWith('execute_tool '));
	assert.equal(toolSpans.length, 1);
	assert.equal(toolSpans[0].name, 'execute_tool unknown');
	const attrs = attrMap(toolSpans[0]);
	assert.equal(attrs['gen_ai.tool.name'], undefined);
	assert.equal(attrs['gen_ai.tool.call.id'], undefined);
	assert.equal(tracker.handlerErrors, 0);
});

test('a hostile message property getter cannot abort synthesis or the next LLM run', () => {
	const spans = [];
	const tracker = new RunTreeTracker(
		{ ...baseConfig, singleTrace: true, captureToolIO: true },
		(s) => spans.push(s),
	);
	const handler = tracker.createHandler();
	handler.handleChatModelStart(OPENAI_SERIALIZED, [[humanMsg]], 'run-1', 'agent-run');
	handler.handleLLMEnd(llmEndWithToolCalls([{ id: 'tc1', name: 'calculator', args: {} }]), 'run-1');
	const hostile = {
		get tool_call_id() {
			throw new Error('hostile getter');
		},
	};
	handler.handleChatModelStart(
		OPENAI_SERIALIZED,
		[[hostile, toolResultMsg('tc1', '42')]],
		'run-2',
		'agent-run',
	);
	handler.handleLLMEnd(OPENAI_RESULT, 'run-2');
	assert.ok(tracker.handlerErrors >= 1, 'the hostile getter was counted');
	const toolSpans = spans.filter((s) => s.name.startsWith('execute_tool '));
	assert.equal(
		toolSpans.length,
		1,
		'the well-formed result after the hostile message still matched',
	);
	assert.equal(attrMap(toolSpans[0])['gen_ai.tool.call.result'], '42');
	assert.equal(
		spans.filter((s) => s.name.startsWith('llm:')).length,
		2,
		'run-2 still opened and closed',
	);
});

test('wholesale synthesis failure (hostile messages container) still opens the LLM run', () => {
	const spans = [];
	const tracker = new RunTreeTracker({ ...baseConfig, singleTrace: true }, (s) => spans.push(s));
	const handler = tracker.createHandler();
	handler.handleChatModelStart(OPENAI_SERIALIZED, [[humanMsg]], 'run-1', 'agent-run');
	handler.handleLLMEnd(llmEndWithToolCalls([{ id: 'tc1', name: 'calc', args: {} }]), 'run-1');
	const messages = [toolResultMsg('tc1', 'x')];
	messages.flat = () => {
		throw new Error('hostile flat');
	};
	handler.handleChatModelStart(OPENAI_SERIALIZED, messages, 'run-2', 'agent-run');
	handler.handleLLMEnd(OPENAI_RESULT, 'run-2');
	assert.ok(tracker.handlerErrors >= 1, 'the wholesale failure was counted');
	assert.equal(
		spans.filter((s) => s.name.startsWith('llm:')).length,
		2,
		'run-2 span still emitted',
	);
});

// --- Root re-emission bounds (409 + cap) -------------------------------------

test('409 on the root batch re-latches: the root is never re-emitted', () => {
	const spans = [];
	const tracker = new RunTreeTracker({ ...baseConfig, singleTrace: true }, (s) => spans.push(s));
	const handler = tracker.createHandler();
	handler.handleChatModelStart(OPENAI_SERIALIZED, [[]], 'run-1', 'agent-run');
	handler.handleLLMEnd(OPENAI_RESULT, 'run-1');
	const root = spans.find((span) => span.parentSpanId === undefined);
	// Exporter reports the solo root batch as failed with HTTP 409 — the
	// backend already ingested it (e.g. client-side timeout after ingest).
	tracker.notifyExportFailed([{ spanId: root.spanId }], 409);
	handler.handleChatModelStart(OPENAI_SERIALIZED, [[]], 'run-2', 'agent-run');
	handler.handleLLMEnd(OPENAI_RESULT, 'run-2');
	tracker.finalize();
	assert.equal(
		spans.filter((s) => s.spanId === root.spanId).length,
		1,
		'root emitted exactly once — later batches must not carry a re-emitted root',
	);
});

test('non-409 root-batch failures re-emit the root, but stop after the cap', () => {
	const spans = [];
	const tracker = new RunTreeTracker({ ...baseConfig, singleTrace: true }, (s) => spans.push(s));
	const handler = tracker.createHandler();
	handler.handleChatModelStart(OPENAI_SERIALIZED, [[]], 'run-1', 'agent-run');
	handler.handleLLMEnd(OPENAI_RESULT, 'run-1');
	const root = spans.find((span) => span.parentSpanId === undefined);
	const rootEmissions = () => spans.filter((s) => s.spanId === root.spanId).length;
	// failure 1 (status known) -> re-emit 1 on the next closeRun
	tracker.notifyExportFailed([{ spanId: root.spanId }], 503);
	handler.handleChatModelStart(OPENAI_SERIALIZED, [[]], 'run-2', 'agent-run');
	handler.handleLLMEnd(OPENAI_RESULT, 'run-2');
	assert.equal(rootEmissions(), 2, 'one re-emit after a non-409 failure');
	// failure 2 (status unknown) -> re-emit 2, reaching the cap
	tracker.notifyExportFailed([{ spanId: root.spanId }]);
	handler.handleChatModelStart(OPENAI_SERIALIZED, [[]], 'run-3', 'agent-run');
	handler.handleLLMEnd(OPENAI_RESULT, 'run-3');
	assert.equal(rootEmissions(), 3, 'second re-emit reaches the cap');
	// pathological repeated failures -> no further re-emits, not even at finalize
	tracker.notifyExportFailed([{ spanId: root.spanId }], 500);
	handler.handleChatModelStart(OPENAI_SERIALIZED, [[]], 'run-4', 'agent-run');
	handler.handleLLMEnd(OPENAI_RESULT, 'run-4');
	tracker.finalize();
	assert.equal(rootEmissions(), 3, 're-emission stops after the cap');
});

test('unmatched tool-result messages (no pending entry) are ignored, no span, no throw', () => {
	const spans = [];
	const tracker = new RunTreeTracker({ ...baseConfig, singleTrace: true }, (s) => spans.push(s));
	const handler = tracker.createHandler();
	handler.handleChatModelStart(OPENAI_SERIALIZED, [[humanMsg]], 'run-1', 'agent-run');
	handler.handleLLMEnd(llmEndWithToolCalls([{ id: 'tc1', name: 'calculator', args: {} }]), 'run-1');
	handler.handleChatModelStart(
		OPENAI_SERIALIZED,
		[[toolResultMsg('never-requested', 'x')]],
		'run-2',
		'agent-run',
	);
	handler.handleLLMEnd(OPENAI_RESULT, 'run-2');
	// root + 2 llm spans, no synthesized span for the unmatched result
	assert.equal(spans.filter((s) => s.name.startsWith('execute_tool ')).length, 0);
	assert.equal(tracker.handlerErrors, 0);
});
