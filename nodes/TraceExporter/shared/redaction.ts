export interface Redactor {
	redact: (text: string) => string;
	invalidPatternCount: number;
}

const REDACTION_REPLACEMENT = '[REDACTED]';

/**
 * Accept either a raw JavaScript regular expression or `/pattern/flags`.
 * Invalid entries are ignored and counted so a bad optional privacy rule
 * cannot stop the model from running (the count is logged without echoing
 * the potentially sensitive pattern itself).
 */
export function compileRedactor(patterns: string[]): Redactor {
	const compiled: RegExp[] = [];
	let invalidPatternCount = 0;

	for (const raw of patterns) {
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
			if (!flags.includes('g')) flags += 'g';
			compiled.push(new RegExp(source, flags));
		} catch {
			invalidPatternCount++;
		}
	}

	return {
		invalidPatternCount,
		redact: (text: string): string => {
			let result = text;
			for (const pattern of compiled) {
				try {
					pattern.lastIndex = 0;
					result = result.replace(pattern, REDACTION_REPLACEMENT);
				} catch {
					// A hostile runtime value must never affect the model call.
				}
			}
			return result;
		},
	};
}
