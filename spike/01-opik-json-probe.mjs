/**
 * Spike gate #1: does Opik's OTLP intake accept JSON encoding?
 * POSTs one minimal hardcoded GenAI span, then reads traces back via the
 * regular REST API. Run: OPIK_URL=http://localhost:5173/api/v1/private/otel node spike/01-opik-json-probe.mjs
 */
import {
	buildExportRequest,
	generateSpanId,
	generateTraceId,
	msToNanos,
	toOtlpAttributes,
	SPAN_KIND_CLIENT,
	STATUS_OK,
} from '../dist/nodes/TraceExporter/shared/otlpJson.js';
import { apiBaseFrom, opikHeaders, otlpTracesUrl, projectName } from './opik.mjs';

const base = process.env.OPIK_URL;
if (!base) {
	console.error('Set OPIK_URL, e.g. http://localhost:5173/api/v1/private/otel');
	process.exit(1);
}

const now = Date.now();
const traceId = generateTraceId();
const body = buildExportRequest({ 'service.name': 'n8n-otel-spike' }, [
	{
		traceId,
		spanId: generateSpanId(),
		name: 'spike-probe-llm-call',
		kind: SPAN_KIND_CLIENT,
		startTimeUnixNano: msToNanos(now - 1200),
		endTimeUnixNano: msToNanos(now),
		attributes: toOtlpAttributes({
			'gen_ai.system': 'openai',
			'gen_ai.request.model': 'gpt-4o-mini',
			'gen_ai.usage.input_tokens': 21,
			'gen_ai.usage.output_tokens': 7,
		}),
		status: { code: STATUS_OK },
	},
]);

const postUrl = otlpTracesUrl(base);
const postRes = await fetch(postUrl, {
	method: 'POST',
	headers: opikHeaders(process.env),
	body: JSON.stringify(body),
});
console.log(`POST ${postUrl} -> ${postRes.status}`);
console.log(await postRes.text());
console.log(`probe traceId: ${traceId}`);

// Opik ingests asynchronously; poll the REST API a few times.
const api = apiBaseFrom(base);
const listUrl = `${api}/api/v1/private/traces?project_name=${encodeURIComponent(projectName(process.env))}&page=1&size=10`;
for (let attempt = 1; attempt <= 5; attempt++) {
	await new Promise((resolve) => setTimeout(resolve, 2000));
	const readRes = await fetch(listUrl, { headers: opikHeaders(process.env) });
	console.log(`GET ${listUrl} -> ${readRes.status} (attempt ${attempt})`);
	if (!readRes.ok) continue;
	const data = await readRes.json();
	console.log(JSON.stringify(data, null, 2).slice(0, 4000));
	break;
}
