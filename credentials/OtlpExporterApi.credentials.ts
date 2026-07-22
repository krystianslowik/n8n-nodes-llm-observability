import type {
	ICredentialDataDecryptedObject,
	ICredentialTestRequest,
	ICredentialType,
	IHttpRequestOptions,
	INodeProperties,
} from 'n8n-workflow';

import {
	parseAdditionalHeaders,
	presetHeaders,
	resolveApiKeyHeaderName,
	resolveAuthType,
	type OtlpCredential,
} from '../nodes/TraceExporter/shared/otlpExport';

/** Shared OTLP/HTTP credential used by the trace exporter. */
export class OtlpExporterApi implements ICredentialType {
	name = 'otlpExporterApi';
	displayName = 'OTLP Trace Exporter API';
	documentationUrl = 'https://github.com/krystianslowik/n8n-nodes-llm-observability#setup';
	icon: ICredentialType['icon'] = {
		light: 'file:../nodes/TraceExporter/traceExporter.svg',
		dark: 'file:../nodes/TraceExporter/traceExporter.dark.svg',
	};

	properties: INodeProperties[] = [
		{
			displayName: 'Backend',
			name: 'preset',
			type: 'options',
			options: [
				{
					name: 'Langfuse Cloud',
					value: 'langfuse',
					description: 'Basic Auth with a Langfuse project public key and secret key',
				},
				{
					name: 'Opik Cloud',
					value: 'opik',
					description: 'API key with Comet workspace and optional Opik project headers',
				},
				{
					name: 'Datadog via OTLP Collector',
					value: 'datadog',
					description: 'Send JSON to a collector configured with the Datadog exporter',
				},
				{
					name: 'Generic OTLP',
					value: 'custom',
					description: 'An OpenTelemetry collector, self-hosted backend, or custom intake',
				},
			],
			default: 'langfuse',
			description:
				'Provides backend-specific setup guidance and routing headers. Authentication remains explicit below.',
		},
		{
			displayName:
				'Use the OTLP/HTTP base endpoint for your Langfuse Cloud region. Backend Default authentication uses the project public and secret keys below. <a href="https://langfuse.com/integrations/native/opentelemetry" target="_blank">View Langfuse endpoints</a>.',
			name: 'langfuseSetupNotice',
			type: 'notice',
			default: '',
			displayOptions: { show: { preset: ['langfuse'] } },
		},
		{
			displayName:
				'Use <code>https://www.comet.com/opik/api/v1/private/otel</code>. Backend Default authentication sends the API key plus the workspace and optional project headers.',
			name: 'opikSetupNotice',
			type: 'notice',
			default: '',
			displayOptions: { show: { preset: ['opik'] } },
		},
		{
			displayName:
				'Point this node at an OpenTelemetry Collector that accepts OTLP/HTTP JSON. Configure that collector with the Datadog exporter, including your Datadog site and API key. Authentication below protects the collector receiver only. <a href="https://docs.datadoghq.com/opentelemetry/setup/collector_exporter/install/" target="_blank">View collector setup</a>.',
			name: 'datadogSetupNotice',
			type: 'notice',
			default: '',
			displayOptions: { show: { preset: ['datadog'] } },
		},
		{
			displayName:
				'Use an OTLP/HTTP JSON endpoint. Authentication and additional headers are configured below.',
			name: 'customSetupNotice',
			type: 'notice',
			default: '',
			displayOptions: { show: { preset: ['custom'] } },
		},
		{
			displayName: 'Endpoint URL',
			name: 'endpointUrl',
			type: 'string',
			typeOptions: { url: true },
			required: true,
			default: '',
			placeholder: 'https://your-otlp-endpoint.example.com',
			description:
				'Base OTLP/HTTP JSON endpoint. The exporter appends /v1/traces unless the URL already ends with that path.',
		},
		{
			displayName: 'Opik Workspace',
			name: 'opikWorkspace',
			type: 'string',
			required: true,
			default: '',
			placeholder: 'default',
			displayOptions: { show: { preset: ['opik'] } },
			description: 'Comet workspace sent in the Comet-Workspace header',
		},
		{
			displayName: 'Opik Project Name',
			name: 'opikProjectName',
			type: 'string',
			default: '',
			placeholder: 'Default Project',
			displayOptions: { show: { preset: ['opik'] } },
			description: 'Optional project sent in the projectName header',
		},
		{
			displayName: 'Authentication',
			name: 'authType',
			type: 'options',
			options: [
				{
					name: 'Backend Default',
					value: 'backendDefault',
					description:
						'Langfuse Basic Auth, Opik API key, and no receiver authentication for collector or generic endpoints',
				},
				{ name: 'Basic Auth', value: 'basicAuth' },
				{ name: 'API Key Header', value: 'apiKeyHeader' },
				{ name: 'Headers Only', value: 'customHeaders' },
			],
			default: 'backendDefault',
			description:
				'Authentication used to reach the configured endpoint. Explicit modes override the selected backend default.',
		},
		{
			displayName: 'Langfuse Public Key',
			name: 'username',
			type: 'string',
			required: true,
			default: '',
			displayOptions: {
				show: { preset: ['langfuse'], authType: ['backendDefault'] },
			},
			description: 'Project public key used as the Basic Auth username',
		},
		{
			displayName: 'Langfuse Secret Key',
			name: 'password',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			displayOptions: {
				show: { preset: ['langfuse'], authType: ['backendDefault'] },
			},
			description: 'Project secret key used as the Basic Auth password',
		},
		{
			displayName: 'Username',
			name: 'username',
			type: 'string',
			required: true,
			default: '',
			displayOptions: { show: { authType: ['basicAuth'] } },
			description: 'Basic Auth username',
		},
		{
			displayName: 'Password',
			name: 'password',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			displayOptions: { show: { authType: ['basicAuth'] } },
			description: 'Basic Auth password',
		},
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			displayOptions: { show: { preset: ['opik'], authType: ['backendDefault'] } },
			description: 'Opik API key sent in the Authorization header',
		},
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			displayOptions: { show: { authType: ['apiKeyHeader'] } },
			description: 'API key sent using the configured header name',
		},
		{
			displayName: 'Header Name',
			name: 'headerName',
			type: 'string',
			default: 'Authorization',
			required: true,
			placeholder: 'Authorization',
			displayOptions: { show: { authType: ['apiKeyHeader'] } },
			description: 'HTTP header that carries the API key',
		},
		{
			displayName: 'Request Headers',
			name: 'customHeaders',
			type: 'json',
			typeOptions: { redactJsonLeaves: true },
			validateType: 'object',
			default: '{}',
			displayOptions: { show: { authType: ['customHeaders'] } },
			description: 'Flat JSON object containing the headers used to authenticate to the endpoint',
		},
		{
			displayName: 'Additional Headers (Advanced)',
			name: 'customHeaders',
			type: 'json',
			typeOptions: { redactJsonLeaves: true },
			validateType: 'object',
			default: '{}',
			displayOptions: {
				show: { authType: ['backendDefault', 'basicAuth', 'apiKeyHeader'] },
			},
			description:
				'Optional flat JSON object applied last. Values can override generated headers and are redacted after saving.',
		},
	];

	/**
	 * Custom authenticate function (rather than the declarative `IAuthenticateGeneric`
	 * shape) because which header(s) get set depends on `authType`, which is
	 * itself a credential field — the generic/declarative form can't easily
	 * branch on that. No network call happens here: it shapes credential-test
	 * requests; the live exporter mirrors the same rules through
	 * `buildExportTarget`.
	 */
	authenticate = async (
		credentials: ICredentialDataDecryptedObject,
		requestOptions: IHttpRequestOptions,
	): Promise<IHttpRequestOptions> => {
		const headers: Record<string, string> = {
			...((requestOptions.headers as Record<string, string> | undefined) ?? {}),
			...presetHeaders(credentials as unknown as OtlpCredential),
		};

		const credential = credentials as unknown as OtlpCredential;
		const authType = resolveAuthType(credential);

		if (authType === 'basicAuth') {
			const token = Buffer.from(
				`${credentials.username as string}:${credentials.password as string}`,
			).toString('base64');
			headers.Authorization = `Basic ${token}`;
		} else if (authType === 'apiKeyHeader') {
			// Empty API key means "no auth header", not an empty header value —
			// mirrors `buildExportTarget` (nodes/TraceExporter/shared/otlpExport.ts).
			if (credentials.apiKey) {
				const headerName = resolveApiKeyHeaderName(credential);
				headers[headerName] = credentials.apiKey as string;
			}
		}
		Object.assign(headers, parseAdditionalHeaders(credentials.customHeaders));

		return {
			...requestOptions,
			headers,
		};
	};

	/**
	 * OTLP/HTTP intake endpoints only accept POSTed OTLP payloads — a GET
	 * would 404/405 on every backend. POST an empty (valid) OTLP
	 * ExportTraceServiceRequest instead: `{"resourceSpans":[]}` is a no-op
	 * for the backend (no spans, no vendor telemetry) but exercises the URL
	 * and the auth headers `authenticate` attaches, so a reachable backend
	 * answers 2xx. The URL expression mirrors `buildExportTarget`
	 * (nodes/TraceExporter/shared/otlpExport.ts): strip trailing slashes,
	 * append `/v1/traces` exactly once.
	 */
	test: ICredentialTestRequest = {
		request: {
			method: 'POST',
			url: '={{ $credentials.endpointUrl.replace(/\\/+$/, "").endsWith("/v1/traces") ? $credentials.endpointUrl.replace(/\\/+$/, "") : $credentials.endpointUrl.replace(/\\/+$/, "") + "/v1/traces" }}',
			body: { resourceSpans: [] },
			json: true,
		},
		rules: [
			{
				type: 'responseCode',
				properties: {
					value: 400,
					message:
						'The endpoint rejected the OTLP probe. Check that it accepts OTLP/HTTP JSON trace requests.',
				},
			},
			{
				type: 'responseCode',
				properties: {
					value: 401,
					message: 'Authentication failed. Check the selected backend and credential values.',
				},
			},
			{
				type: 'responseCode',
				properties: {
					value: 403,
					message:
						'The backend refused trace ingestion. Check API key permissions, workspace, and project access.',
				},
			},
			{
				type: 'responseCode',
				properties: {
					value: 404,
					message:
						'No OTLP trace intake was found at this URL. Check the endpoint and its /v1/traces path.',
				},
			},
			{
				type: 'responseCode',
				properties: {
					value: 405,
					message:
						'This endpoint does not accept OTLP trace POST requests. Check the backend endpoint URL.',
				},
			},
			{
				type: 'responseCode',
				properties: {
					value: 429,
					message: 'The backend rate-limited the connection test. Wait, then try again.',
				},
			},
		],
	};
}
