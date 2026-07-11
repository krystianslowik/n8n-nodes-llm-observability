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
