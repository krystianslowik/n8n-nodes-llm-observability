/**
 * Thread-mapping verification: which span attribute does Opik's OTel intake
 * map to the trace's thread_id (Opik "Threads" / conversation grouping)?
 *
 * Candidates (one trace each, attribute on the parentless ROOT span — Opik
 * extracts thread_id from ROOT span attributes only, per comet-ml/opik#3578):
 *   - thread_id               (Opik's documented key, added in opik PR #3578)
 *   - gen_ai.conversation.id  (OTel GenAI semconv, vendor-neutral)
 *   - session.id              (what this node already emits)
 *
 * FINDING (verified 2026-07-09 against self-hosted Opik at
 * https://opik.krystianslowik.com, workspace `default`):
 *   - `thread_id`              -> trace.thread_id POPULATED (matches value).
 *   - `gen_ai.conversation.id` -> trace.thread_id POPULATED (matches value).
 *   - `session.id`             -> trace.thread_id null (IGNORED).
 * So Opik groups traces into Threads from either the documented `thread_id`
 * key (comet-ml/opik#3578) or the OTel GenAI semconv `gen_ai.conversation.id`;
 * the generic `session.id` key does NOT reach Opik Threads. We emit both
 * mapped keys — `thread_id` covers Opik versions that predate the semconv
 * mapping.
 *
 * Run: node spike/verify-thread-mapping.mjs
 */
import {
	buildExportRequest,
	generateSpanId,
	generateTraceId,
	msToNanos,
	toOtlpAttributes,
	SPAN_KIND_CLIENT,
} from '../dist/nodes/TraceExporter/shared/otlpJson.js';

const base = process.env.OPIK_URL ?? 'https://opik.krystianslowik.com/api/v1/private/otel';
const api = base.replace(/\/+$/, '').replace(/\/api\/v1\/private\/otel$/, '');
const project = process.env.OPIK_PROJECT ?? 'thread-mapping-spike';
const headers = { 'Content-Type': 'application/json', projectName: project };
if (process.env.OPIK_WORKSPACE) headers['Comet-Workspace'] = process.env.OPIK_WORKSPACE;

const candidates = [
	{ key: 'thread_id', value: `spike-thread-${Date.now()}` },
	{ key: 'gen_ai.conversation.id', value: `spike-conv-${Date.now()}` },
	{ key: 'session.id', value: `spike-session-${Date.now()}` },
];

// POST one tiny trace per candidate: a single parentless root span (a second
// parentless span on the same traceId would 409; children would append fine).
const posted = [];
for (const candidate of candidates) {
	const now = Date.now();
	const traceId = generateTraceId();
	const spanName = `thread-spike:${candidate.key}`;
	const body = buildExportRequest({ 'service.name': 'n8n-otel-spike' }, [
		{
			traceId,
			spanId: generateSpanId(),
			name: spanName,
			kind: SPAN_KIND_CLIENT,
			startTimeUnixNano: msToNanos(now - 500),
			endTimeUnixNano: msToNanos(now),
			attributes: toOtlpAttributes({
				'gen_ai.system': 'openai',
				[candidate.key]: candidate.value,
			}),
		},
	]);
	const res = await fetch(`${base.replace(/\/+$/, '')}/v1/traces`, {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
	});
	console.log(`POST ${candidate.key}=${candidate.value} -> ${res.status}`);
	posted.push({ ...candidate, spanName });
}

// Opik ingests asynchronously; poll the REST API and check trace.thread_id.
const listUrl = `${api}/api/v1/private/traces?project_name=${encodeURIComponent(project)}&page=1&size=25`;
for (let attempt = 1; attempt <= 6; attempt++) {
	await new Promise((resolve) => setTimeout(resolve, 2000));
	const res = await fetch(listUrl, { headers });
	if (!res.ok) {
		console.log(`GET traces -> ${res.status} (attempt ${attempt})`);
		continue;
	}
	const items = (await res.json()).content ?? [];
	const found = posted.map((p) => ({
		...p,
		trace: items.find((t) => t.name === p.spanName),
	}));
	if (found.some((f) => !f.trace)) {
		console.log(`attempt ${attempt}: ${found.filter((f) => f.trace).length}/${posted.length} traces visible, retrying...`);
		continue;
	}
	console.log('\n=== RESULTS ===');
	for (const f of found) {
		const got = f.trace.thread_id ?? null;
		const ok = got === f.value;
		console.log(
			`${ok ? 'MAPPED ' : 'IGNORED'}: span attr ${f.key} -> trace.thread_id=${JSON.stringify(got)}${ok ? ' (matches)' : ''}`,
		);
	}
	process.exit(0);
}
console.error('traces never became visible; inspect manually');
process.exit(1);
