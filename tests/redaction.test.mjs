import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compileRedactor } from '../dist/nodes/TraceExporter/shared/redaction.js';

test('redactor supports raw and /pattern/flags regexes and replaces every match', () => {
	const redactor = compileRedactor(['secret-[0-9]+', '/token-[a-z]+/i']);
	assert.equal(redactor.invalidPatternCount, 0);
	assert.equal(
		redactor.redact('secret-123 token-AbC secret-456'),
		'[REDACTED] [REDACTED] [REDACTED]',
	);
});

test('redactor ignores invalid patterns without echoing or throwing', () => {
	const redactor = compileRedactor(['[', 'safe']);
	assert.equal(redactor.invalidPatternCount, 1);
	assert.doesNotThrow(() => redactor.redact('safe value'));
	assert.equal(redactor.redact('safe value'), '[REDACTED] value');
});

test('redactor applies the supported structured field-path subset to JSON values', () => {
	const redactor = compileRedactor([], {
		fieldPaths: ['$.user.email', "$['api.key']", '$.items[*].token', '$..password'],
	});
	assert.equal(redactor.invalidFieldPathCount, 0);
	assert.deepEqual(
		JSON.parse(
			redactor.redact(
				JSON.stringify({
					user: { email: 'a@example.com', password: 'one' },
					'api.key': 'key',
					items: [{ token: 't1' }, { token: 't2', nested: { password: 'two' } }],
				}),
			),
		),
		{
			user: { email: '[REDACTED]', password: '[REDACTED]' },
			'api.key': '[REDACTED]',
			items: [{ token: '[REDACTED]' }, { token: '[REDACTED]', nested: { password: '[REDACTED]' } }],
		},
	);
});

test('redactor rejects unsafe regexes and bounds oversized input without leaking the tail', () => {
	const redactor = compileRedactor(['(a+)+$', 'secret'], { maxInputChars: 1024 });
	assert.equal(redactor.invalidPatternCount, 1);
	const result = redactor.redact(`secret${'x'.repeat(3000)}tail-secret`);
	assert.ok(result.length < 1200);
	assert.ok(!result.includes('tail-secret'));
	assert.match(result, /^\[REDACTED\]/);
	assert.match(result, /redaction input truncated/);

	const invalidPath = compileRedactor([], { fieldPaths: ['user.password', '$.[broken'] });
	assert.equal(invalidPath.invalidFieldPathCount, 2);
});

test('structured redaction fails closed when valid JSON is too deep to transform safely', () => {
	const depth = 12000;
	const deeplyNested = `${'{"child":'.repeat(depth)}{"password":"secret"}${'}'.repeat(depth)}`;
	const redactor = compileRedactor([], {
		fieldPaths: ['$..password'],
		maxInputChars: deeplyNested.length + 1,
	});
	assert.equal(redactor.redact(deeplyNested), '[REDACTED]');
});
