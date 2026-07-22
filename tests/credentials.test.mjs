import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OtlpExporterApi } from '../dist/credentials/OtlpExporterApi.credentials.js';

test('credential test POSTs an empty OTLP payload to the /v1/traces endpoint', () => {
	const { request, rules } = new OtlpExporterApi().test;
	assert.equal(request.method, 'POST', 'OTLP intakes only accept POST — GET always 404s');
	assert.deepEqual(
		request.body,
		{ resourceSpans: [] },
		'empty ExportTraceServiceRequest: valid, ingests nothing',
	);
	assert.equal(request.json, true);
	assert.ok(request.url.startsWith('={{'), 'url is an expression on the credential endpoint');
	assert.ok(
		request.url.includes('/v1/traces'),
		'targets the same /v1/traces path the exporter uses',
	);
	assert.ok(
		request.url.includes('endsWith("/v1/traces")'),
		'mirrors buildExportTarget: /v1/traces appended exactly once',
	);
	assert.deepEqual(
		rules.map((rule) => rule.properties.value),
		[400, 401, 403, 404, 405, 429],
		'common setup failures have actionable credential-test messages',
	);
});

test('credential UI guides named backends without changing stored field names', () => {
	const credential = new OtlpExporterApi();
	const propertyNames = credential.properties.map((property) => property.name);
	const property = (name) => credential.properties.find((candidate) => candidate.name === name);

	assert.equal(credential.name, 'otlpExporterApi');
	assert.match(credential.documentationUrl, /#setup$/);
	for (const storedName of [
		'preset',
		'endpointUrl',
		'authType',
		'username',
		'password',
		'apiKey',
		'headerName',
		'customHeaders',
	]) {
		assert.ok(propertyNames.includes(storedName), `missing stored credential field: ${storedName}`);
	}
	assert.equal(property('preset').displayName, 'Backend');
	assert.deepEqual(
		property('preset').options.map((option) => option.name),
		['Langfuse Cloud', 'Opik Cloud', 'Datadog via OTLP Collector', 'Generic OTLP'],
	);
	assert.equal(property('endpointUrl').required, true);
	assert.equal(property('endpointUrl').typeOptions.url, true);
	assert.equal(property('authType').default, 'backendDefault');
	assert.equal(property('authType').displayOptions, undefined);
	assert.ok(
		property('authType').options.some(
			(option) => option.name === 'Headers Only' && option.value === 'customHeaders',
		),
	);
	assert.equal(property('opikWorkspace').required, true);
	assert.equal(propertyNames.includes('datadogMlApp'), false);
	const headerProperties = credential.properties.filter(
		(candidate) => candidate.name === 'customHeaders',
	);
	assert.equal(headerProperties.length, 2);
	for (const headers of headerProperties) {
		assert.equal(headers.type, 'json');
		assert.equal(headers.validateType, 'object');
		assert.equal(headers.typeOptions.redactJsonLeaves, true);
	}
	assert.ok(
		headerProperties.some(
			(headers) =>
				headers.displayName === 'Request Headers' &&
				headers.displayOptions?.show?.authType?.includes('customHeaders'),
		),
		'Headers Only exposes a primary Request Headers field',
	);
	assert.ok(
		credential.properties.some(
			(candidate) =>
				candidate.name === 'apiKey' &&
				candidate.displayOptions?.show?.preset?.includes('opik') &&
				candidate.displayOptions?.show?.authType?.includes('backendDefault') &&
				candidate.required === true,
		),
		'Opik Backend Default exposes its required API key',
	);
	assert.ok(
		credential.properties.some(
			(candidate) =>
				candidate.name === 'username' &&
				candidate.displayOptions?.show?.authType?.includes('basicAuth') &&
				candidate.displayOptions?.show?.preset === undefined,
		),
		'Explicit Basic Auth remains available for every backend',
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

test('authenticate derives Langfuse Basic Auth only for Backend Default', async () => {
	const credential = new OtlpExporterApi();
	const result = await credential.authenticate(
		{
			preset: 'langfuse',
			authType: 'backendDefault',
			username: 'pk-lf-test',
			password: 'sk-lf-test',
		},
		{ url: 'http://x', headers: {} },
	);

	assert.equal(
		result.headers.Authorization,
		`Basic ${Buffer.from('pk-lf-test:sk-lf-test').toString('base64')}`,
	);
	assert.equal(result.headers['x-langfuse-ingestion-version'], '4');
});

test('explicit authentication overrides a named backend without dropping its routing headers', async () => {
	const credential = new OtlpExporterApi();
	const result = await credential.authenticate(
		{
			preset: 'langfuse',
			authType: 'apiKeyHeader',
			apiKey: 'proxy-key',
			headerName: 'x-proxy-key',
		},
		{ url: 'http://x', headers: {} },
	);

	assert.equal(result.headers['x-langfuse-ingestion-version'], '4');
	assert.equal(result.headers['x-proxy-key'], 'proxy-key');
	assert.equal(result.headers.Authorization, undefined);
});

test('authenticate derives the Opik Authorization header for Backend Default', async () => {
	const credential = new OtlpExporterApi();
	const result = await credential.authenticate(
		{
			preset: 'opik',
			authType: 'backendDefault',
			apiKey: 'opik-key',
			headerName: 'wrong-header',
			opikWorkspace: 'workspace',
			opikProjectName: 'project',
		},
		{ url: 'http://x', headers: {} },
	);

	assert.deepEqual(result.headers, {
		'Comet-Workspace': 'workspace',
		projectName: 'project',
		Authorization: 'opik-key',
	});
});

test('authenticate preserves an existing Opik credential with Basic proxy auth', async () => {
	const credential = new OtlpExporterApi();
	const result = await credential.authenticate(
		{
			preset: 'opik',
			authType: 'basicAuth',
			username: 'proxy-user',
			password: 'proxy-secret',
			opikWorkspace: 'workspace',
		},
		{ url: 'http://x', headers: {} },
	);

	assert.equal(
		result.headers.Authorization,
		`Basic ${Buffer.from('proxy-user:proxy-secret').toString('base64')}`,
	);
	assert.equal(result.headers['Comet-Workspace'], 'workspace');
});

test('Datadog Backend Default leaves receiver auth to the collector configuration', async () => {
	const credential = new OtlpExporterApi();
	const result = await credential.authenticate(
		{
			preset: 'datadog',
			authType: 'backendDefault',
			apiKey: 'must-not-be-sent-to-the-receiver',
			datadogMlApp: 'legacy-value',
		},
		{ url: 'http://x', headers: {} },
	);

	assert.deepEqual(result.headers, {});
});

test('Datadog collector receiver authentication remains explicitly configurable', async () => {
	const credential = new OtlpExporterApi();
	const result = await credential.authenticate(
		{
			preset: 'datadog',
			authType: 'apiKeyHeader',
			apiKey: 'collector-key',
			headerName: 'x-collector-key',
		},
		{ url: 'http://x', headers: {} },
	);

	assert.deepEqual(result.headers, { 'x-collector-key': 'collector-key' });
});

test('authenticate keeps custom API key headers configurable', async () => {
	const credential = new OtlpExporterApi();
	const result = await credential.authenticate(
		{
			preset: 'custom',
			authType: 'apiKeyHeader',
			apiKey: 'collector-key',
			headerName: 'x-collector-key',
		},
		{ url: 'http://x', headers: {} },
	);

	assert.equal(result.headers['x-collector-key'], 'collector-key');
});

test('authenticate applies operational preset headers and additive custom headers', async () => {
	const credential = new OtlpExporterApi();
	const result = await credential.authenticate(
		{
			preset: 'opik',
			authType: 'backendDefault',
			apiKey: 'key',
			headerName: 'Authorization',
			opikWorkspace: 'workspace',
			opikProjectName: 'project',
			customHeaders: '{"projectName":"override","x-route":"blue"}',
		},
		{ url: 'http://x', headers: {} },
	);
	assert.deepEqual(result.headers, {
		'Comet-Workspace': 'workspace',
		projectName: 'override',
		Authorization: 'key',
		'x-route': 'blue',
	});
});
