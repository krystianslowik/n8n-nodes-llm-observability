/**
 * Post-run verification: reads recent traces + their spans from Opik's REST
 * API and prints an assertion summary (spec: "read-back, not fire-and-hope").
 * Run: OPIK_URL=... node spike/verify-trace.mjs
 */
import { apiBaseFrom, opikHeaders, projectName } from './opik.mjs';

const base = process.env.OPIK_URL;
if (!base) {
	console.error('Set OPIK_URL, e.g. http://localhost:5173/api/v1/private/otel');
	process.exit(1);
}
const api = apiBaseFrom(base);
const headers = opikHeaders(process.env);
const project = encodeURIComponent(projectName(process.env));

const tracesRes = await fetch(`${api}/api/v1/private/traces?project_name=${project}&page=1&size=5`, {
	headers,
});
if (!tracesRes.ok) {
	console.error(`trace list failed: ${tracesRes.status} ${await tracesRes.text()}`);
	process.exit(1);
}
const traces = await tracesRes.json();
const items = traces.content ?? traces.traces ?? [];
console.log(`found ${items.length} recent trace(s) in project`);

for (const trace of items) {
	console.log(`\n=== trace ${trace.id} (start: ${trace.start_time ?? '?'}) ===`);
	const spansRes = await fetch(
		`${api}/api/v1/private/spans?project_name=${project}&trace_id=${trace.id}&page=1&size=50`,
		{ headers },
	);
	if (!spansRes.ok) {
		console.log(`  span list failed: ${spansRes.status}`);
		continue;
	}
	const spans = (await spansRes.json()).content ?? [];
	console.log(`  ${spans.length} span(s):`);
	for (const span of spans) {
		console.log(
			`  - ${span.name} parent=${span.parent_span_id ?? 'ROOT'} usage=${JSON.stringify(span.usage ?? span.metadata?.usage ?? null)}`,
		);
	}
	const checks = {
		'has >=1 span': spans.length >= 1,
		'has an llm span': spans.some((s) => String(s.name).startsWith('llm:')),
		'llm span reports token usage': spans.some(
			(s) => JSON.stringify(s).includes('input_tokens') || JSON.stringify(s).includes('prompt_tokens'),
		),
	};
	for (const [label, ok] of Object.entries(checks)) console.log(`  ${ok ? 'PASS' : 'FAIL'}: ${label}`);
}
console.log(
	'\nNOTE: field names above are best-guess against the Opik REST schema — if spans print as undefined, dump one raw span JSON and adjust; record the real schema in FINDINGS.md.',
);
