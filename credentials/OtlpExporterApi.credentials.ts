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
	type OtlpCredential,
} from '../nodes/TraceExporter/shared/otlpExport';

/**
 * Shared credential for both nodes in this package (PRD §5 "Configuration
 * (shared credential: 'OTLP Exporter')"). One credential type, one
 * third-party-agnostic protocol (OTLP/HTTP) — this is what keeps the package
 * inside n8n's "one service per package" verification rule even though it
 * talks to Langfuse, Comet Opik, Datadog, or any other OTel collector.
 *
 * The preset adds the vendor-specific OTLP headers that a generic auth
 * selector cannot infer, while Endpoint URL and primary auth remain explicit:
 *   - Langfuse  -> https://cloud.langfuse.com/api/public/otel, Basic Auth (public key / secret key)
 *   - Comet Opik -> https://www.comet.com/opik/api/v1/private/otel, API Key Header ("Authorization")
 *   - Datadog   -> https://otlp-http-intake.logs.<site>/v1/traces, API Key Header ("DD-API-KEY")
 */
export class OtlpExporterApi implements ICredentialType {
	name = 'otlpExporterApi';
	displayName = 'OTLP Exporter API';
	documentationUrl = 'https://github.com/krystianslowik/n8n-nodes-llm-observability?tab=readme-ov-file#credentials';
	icon: ICredentialType['icon'] = { light: 'file:../nodes/TraceExporter/traceExporter.svg', dark: 'file:../nodes/TraceExporter/traceExporter.dark.svg' };

	properties: INodeProperties[] = [
		{
			displayName: 'Preset',
			name: 'preset',
			type: 'options',
			options: [
				{ name: 'Langfuse', value: 'langfuse' },
				{ name: 'Comet Opik', value: 'opik' },
				{ name: 'Datadog', value: 'datadog' },
				{ name: 'Custom', value: 'custom' },
			],
			default: 'langfuse',
			description:
				'Adds the backend-specific OTLP headers required for trace ingestion. Endpoint URL and the primary authentication values remain explicit below.',
		},
		{
			displayName: 'Opik Workspace',
			name: 'opikWorkspace',
			type: 'string',
			default: '',
			displayOptions: { show: { preset: ['opik'] } },
			description: 'Comet workspace sent in the Comet-Workspace header (required by Opik Cloud)',
		},
		{
			displayName: 'Opik Project Name',
			name: 'opikProjectName',
			type: 'string',
			default: '',
			displayOptions: { show: { preset: ['opik'] } },
			description: 'Opik project sent in the projectName header',
		},
		{
			displayName: 'Datadog ML App',
			name: 'datadogMlApp',
			type: 'string',
			default: 'n8n',
			displayOptions: { show: { preset: ['datadog'] } },
			description: 'Application name sent in the dd-ml-app header',
		},
		{
			displayName: 'Endpoint URL',
			name: 'endpointUrl',
			type: 'string',
			required: true,
			default: '',
			placeholder: 'https://cloud.langfuse.com/api/public/otel',
			description: 'The OTLP/HTTP endpoint that receives exported traces (an OTel collector or a vendor OTLP intake URL)',
		},
		{
			displayName: 'Auth Type',
			name: 'authType',
			type: 'options',
			options: [
				{ name: 'Basic Auth', value: 'basicAuth' },
				{ name: 'API Key Header', value: 'apiKeyHeader' },
				{ name: 'Custom Headers', value: 'customHeaders' },
			],
			default: 'basicAuth',
			description: 'How credentials are attached to the OTLP export request',
		},
		{
			displayName: 'Username / Public Key',
			name: 'username',
			type: 'string',
			default: '',
			displayOptions: { show: { authType: ['basicAuth'] } },
			description: 'E.g. a Langfuse public key',
		},
		{
			displayName: 'Password / Secret Key',
			name: 'password',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			displayOptions: { show: { authType: ['basicAuth'] } },
			description: 'E.g. a Langfuse secret key',
		},
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			displayOptions: { show: { authType: ['apiKeyHeader'] } },
			description: 'E.g. a Datadog or Comet Opik API key',
		},
		{
			displayName: 'Header Name',
			name: 'headerName',
			type: 'string',
			default: 'Authorization',
			placeholder: 'DD-API-KEY',
			displayOptions: { show: { authType: ['apiKeyHeader'] } },
			description: 'Name of the HTTP header the API Key is sent under (e.g. "DD-API-KEY" for Datadog, "Authorization" for others)',
		},
		{
			displayName: 'Additional Headers',
			name: 'customHeaders',
			type: 'json',
			default: '{}',
			description:
				'Arbitrary headers added after preset and primary authentication headers, as a JSON object (e.g. {"x-api-key": "..."}). Values here can override defaults. Treat them as sensitive.',
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

		const authType = credentials.authType as string;

		if (authType === 'basicAuth') {
			const token = Buffer.from(`${credentials.username as string}:${credentials.password as string}`).toString(
				'base64',
			);
			headers.Authorization = `Basic ${token}`;
		} else if (authType === 'apiKeyHeader') {
			// Empty API key means "no auth header", not an empty header value —
			// mirrors `buildExportTarget` (nodes/TraceExporter/shared/otlpExport.ts).
			if (credentials.apiKey) {
				const headerName = (credentials.headerName as string) || 'Authorization';
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
	};
}
