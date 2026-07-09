import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OtlpExporterApi } from '../dist/credentials/OtlpExporterApi.credentials.js';

test('credential test POSTs an empty OTLP payload to the /v1/traces endpoint', () => {
	const { request } = new OtlpExporterApi().test;
	assert.equal(request.method, 'POST', 'OTLP intakes only accept POST — GET always 404s');
	assert.deepEqual(request.body, { resourceSpans: [] }, 'empty ExportTraceServiceRequest: valid, ingests nothing');
	assert.equal(request.json, true);
	assert.ok(request.url.startsWith('={{'), 'url is an expression on the credential endpoint');
	assert.ok(request.url.includes('/v1/traces'), 'targets the same /v1/traces path the exporter uses');
	assert.ok(
		request.url.includes('endsWith("/v1/traces")'),
		'mirrors buildExportTarget: /v1/traces appended exactly once',
	);
});

test('authenticate skips the auth header entirely when apiKey is empty (matches export layer)', async () => {
	const credential = new OtlpExporterApi();
	const result = await credential.authenticate(
		{ authType: 'apiKeyHeader', apiKey: '', headerName: 'DD-API-KEY' },
		{ url: 'http://x', headers: {} },
	);
	assert.deepEqual(result.headers, {}, 'no empty-valued auth header is injected');
});

test('authenticate sets the API key under the configured header name when present', async () => {
	const credential = new OtlpExporterApi();
	const result = await credential.authenticate(
		{ authType: 'apiKeyHeader', apiKey: 'k-123', headerName: 'DD-API-KEY' },
		{ url: 'http://x', headers: {} },
	);
	assert.equal(result.headers['DD-API-KEY'], 'k-123');
});
