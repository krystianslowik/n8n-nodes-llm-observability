export interface Redactor {
	redact: (text: string) => string;
	invalidPatternCount: number;
	invalidFieldPathCount: number;
}

export interface RedactorOptions {
	/**
	 * Structured field paths applied when the captured value is valid JSON.
	 * This is deliberately a small, documented field-path language, not full
	 * JSONPath: `$.user.email`, `$['api.key']`, `$.items[*].token`, and
	 * `$..password` are supported.
	 */
	fieldPaths?: string[];
	/** Work bound before regex evaluation or JSON parsing. Hard-capped at 1 MiB. */
	maxInputChars?: number;
}

const REDACTION_REPLACEMENT = '[REDACTED]';
const INPUT_TRUNCATION_MARKER = '…[redaction input truncated]';
const MAX_PATTERNS = 64;
const MAX_PATTERN_LENGTH = 512;
const DEFAULT_MAX_INPUT_CHARS = 256 * 1024;
const HARD_MAX_INPUT_CHARS = 1024 * 1024;

type FieldPathSegment =
	| { kind: 'key'; key: string }
	| { kind: 'index'; index: number }
	| { kind: 'wildcard' }
	| { kind: 'recursive'; key?: string };

function parseBracketKey(raw: string): string | undefined {
	if (raw.length < 2) return undefined;
	const quote = raw[0];
	if ((quote !== '"' && quote !== "'") || raw[raw.length - 1] !== quote) return undefined;
	if (quote === '"') {
		try {
			const parsed = JSON.parse(raw);
			return typeof parsed === 'string' ? parsed : undefined;
		} catch {
			return undefined;
		}
	}
	// JSON.parse does not accept single-quoted strings. Support the two useful
	// escapes without pretending this is a JavaScript expression parser.
	let result = '';
	for (let index = 1; index < raw.length - 1; index++) {
		const character = raw[index];
		if (character !== '\\') {
			result += character;
			continue;
		}
		index++;
		const escaped = raw[index];
		if (escaped !== "'" && escaped !== '\\') return undefined;
		result += escaped;
	}
	return result;
}

function parseFieldPath(path: string): FieldPathSegment[] | undefined {
	if (!path.startsWith('$')) return undefined;
	const segments: FieldPathSegment[] = [];
	let index = 1;
	while (index < path.length) {
		if (path[index] === '.') {
			const recursive = path[index + 1] === '.';
			index += recursive ? 2 : 1;
			if (index >= path.length) return undefined;
			if (path[index] === '*') {
				segments.push(recursive ? { kind: 'recursive' } : { kind: 'wildcard' });
				index++;
				continue;
			}
			const start = index;
			while (index < path.length && path[index] !== '.' && path[index] !== '[') index++;
			if (start === index) return undefined;
			const key = path.slice(start, index);
			segments.push(recursive ? { kind: 'recursive', key } : { kind: 'key', key });
			continue;
		}
		if (path[index] === '[') {
			const close = path.indexOf(']', index + 1);
			if (close === -1) return undefined;
			const expression = path.slice(index + 1, close).trim();
			if (expression === '*') segments.push({ kind: 'wildcard' });
			else if (/^(?:0|[1-9][0-9]*)$/.test(expression)) {
				segments.push({ kind: 'index', index: Number(expression) });
			} else {
				const key = parseBracketKey(expression);
				if (key === undefined) return undefined;
				segments.push({ kind: 'key', key });
			}
			index = close + 1;
			continue;
		}
		return undefined;
	}
	return segments;
}

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
	return value !== null && typeof value === 'object';
}

function redactAtPath(value: unknown, segments: FieldPathSegment[], at = 0): unknown {
	if (at >= segments.length) return REDACTION_REPLACEMENT;
	if (!isContainer(value)) return value;
	const segment = segments[at];

	if (segment.kind === 'recursive') {
		for (const key of Object.keys(value)) {
			let child = (value as Record<string, unknown>)[key];
			if (segment.key === undefined || key === segment.key) {
				child = redactAtPath(child, segments, at + 1);
				(value as Record<string, unknown>)[key] = child;
			}
			if (isContainer(child)) {
				(value as Record<string, unknown>)[key] = redactAtPath(child, segments, at);
			}
		}
		return value;
	}

	if (segment.kind === 'wildcard') {
		for (const key of Object.keys(value)) {
			(value as Record<string, unknown>)[key] = redactAtPath(
				(value as Record<string, unknown>)[key],
				segments,
				at + 1,
			);
		}
		return value;
	}

	if (segment.kind === 'index') {
		if (Array.isArray(value) && segment.index < value.length) {
			value[segment.index] = redactAtPath(value[segment.index], segments, at + 1);
		}
		return value;
	}

	if (Object.prototype.hasOwnProperty.call(value, segment.key)) {
		(value as Record<string, unknown>)[segment.key] = redactAtPath(
			(value as Record<string, unknown>)[segment.key],
			segments,
			at + 1,
		);
	}
	return value;
}

function redactStructuredJson(text: string, paths: FieldPathSegment[][]): string {
	if (paths.length === 0) return text;
	const trimmed = text.trim();
	if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return text;
	let value: unknown;
	try {
		value = JSON.parse(trimmed);
	} catch {
		return text;
	}
	try {
		for (const path of paths) value = redactAtPath(value, path);
		return JSON.stringify(value);
	} catch {
		// The text was valid JSON and therefore in scope for structured rules.
		// A traversal/stringify failure must not send the original sensitive body.
		return REDACTION_REPLACEMENT;
	}
}

/**
 * Reject common catastrophic-backtracking forms before they can run on
 * user/workflow content. This is intentionally conservative: privacy rules
 * that cannot be evaluated with a predictable work bound are reported as
 * invalid instead of risking an event-loop stall.
 */
function isSafeRegexSource(source: string): boolean {
	if (source.length === 0 || source.length > MAX_PATTERN_LENGTH) return false;
	if (/\\[1-9]/.test(source)) return false;
	// Nested quantifiers: `(a+)+`, `(?:.*){2,}`, `(a?)*`.
	if (/\((?:\\.|[^()])*[*+?{](?:\\.|[^()])*\)\s*[*+?{]/.test(source)) return false;
	// Quantified alternation is a common overlapping-branch ReDoS shape:
	// `(a|aa)+`. Reject it even when each branch has no inner quantifier.
	if (/\((?:\\.|[^()])*\|(?:\\.|[^()])*\)\s*[*+{]/.test(source)) return false;
	// Multiple unbounded wildcards can create quadratic scans on a near miss.
	if (/(?:\.\*|\.\+)(?:\\.|[^\n])*(?:\.\*|\.\+)/.test(source)) return false;
	return true;
}

function boundedPrefix(text: string, limit: number): { text: string; truncated: boolean } {
	if (text.length <= limit) return { text, truncated: false };
	return { text: text.slice(0, limit), truncated: true };
}

/**
 * Compile optional regex and structured field-path privacy rules. Invalid or
 * unsafe entries are ignored and counted so optional tracing can never stop
 * the model call. Regex input and output are bounded before every pass.
 */
export function compileRedactor(patterns: string[], options: RedactorOptions = {}): Redactor {
	const compiled: RegExp[] = [];
	let invalidPatternCount = 0;
	let invalidFieldPathCount = 0;
	const rawPatterns = Array.isArray(patterns) ? patterns : [];
	for (const raw of rawPatterns.slice(0, MAX_PATTERNS)) {
		if (typeof raw !== 'string' || raw.length === 0) continue;
		try {
			let source = raw;
			let flags = 'g';
			if (raw.startsWith('/')) {
				const lastSlash = raw.lastIndexOf('/');
				if (lastSlash > 0) {
					source = raw.slice(1, lastSlash);
					flags = raw.slice(lastSlash + 1);
				}
			}
			if (!isSafeRegexSource(source)) {
				invalidPatternCount++;
				continue;
			}
			if (!flags.includes('g')) flags += 'g';
			const pattern = new RegExp(source, flags);
			pattern.lastIndex = 0;
			if (pattern.test('')) {
				invalidPatternCount++;
				continue;
			}
			pattern.lastIndex = 0;
			compiled.push(pattern);
		} catch {
			invalidPatternCount++;
		}
	}
	if (rawPatterns.length > MAX_PATTERNS) invalidPatternCount += rawPatterns.length - MAX_PATTERNS;

	const fieldPaths: FieldPathSegment[][] = [];
	const rawFieldPaths = Array.isArray(options.fieldPaths) ? options.fieldPaths : [];
	for (const raw of rawFieldPaths.slice(0, MAX_PATTERNS)) {
		const parsed = typeof raw === 'string' ? parseFieldPath(raw) : undefined;
		if (parsed) fieldPaths.push(parsed);
		else invalidFieldPathCount++;
	}
	if (rawFieldPaths.length > MAX_PATTERNS) {
		invalidFieldPathCount += rawFieldPaths.length - MAX_PATTERNS;
	}

	const configuredLimit = options.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS;
	const maxInputChars = Math.min(
		HARD_MAX_INPUT_CHARS,
		Math.max(
			1024,
			Number.isFinite(configuredLimit) ? Math.floor(configuredLimit) : DEFAULT_MAX_INPUT_CHARS,
		),
	);

	return {
		invalidPatternCount,
		invalidFieldPathCount,
		redact: (input: string): string => {
			const text = typeof input === 'string' ? input : '';
			const bounded = boundedPrefix(text, maxInputChars);
			const looksStructured = /^\s*(?:\[|\{)/.test(text);
			// A truncated JSON document cannot be parsed safely. If structured
			// rules are configured, drop it instead of returning unredacted fields.
			let result =
				bounded.truncated && looksStructured && fieldPaths.length > 0
					? REDACTION_REPLACEMENT
					: redactStructuredJson(bounded.text, fieldPaths);
			for (const pattern of compiled) {
				try {
					pattern.lastIndex = 0;
					result = result.replace(pattern, REDACTION_REPLACEMENT);
					if (result.length > maxInputChars) {
						result = `${result.slice(0, maxInputChars)}${INPUT_TRUNCATION_MARKER}`;
					}
				} catch {
					// A hostile runtime value must never affect the model call.
				}
			}
			if (bounded.truncated && result !== REDACTION_REPLACEMENT) {
				return `${result}${INPUT_TRUNCATION_MARKER}`;
			}
			return result;
		},
	};
}
