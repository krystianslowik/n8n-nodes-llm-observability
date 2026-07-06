import type {
	ICredentialDataDecryptedObject,
	ICredentialTestRequest,
	ICredentialType,
	IHttpRequestOptions,
	INodeProperties,
} from 'n8n-workflow';

/**
 * Shared credential for both nodes in this package (PRD §5 "Configuration
 * (shared credential: 'OTLP Exporter')"). One credential type, one
 * third-party-agnostic protocol (OTLP/HTTP) — this is what keeps the package
 * inside n8n's "one service per package" verification rule even though it
 * talks to Langfuse, Comet Opik, Datadog, or any other OTel collector.
 *
 * The "Preset" field is UX sugar only (PRD §5 table: "selecting
 * Langfuse/Opik/Datadog/Custom prefills endpoint pattern + auth header
 * names"). TODO (PRD F6): wire up a `methods.credentialTest`/UI-side prefill
 * (or a `loadOptionsMethod`-driven default) so choosing a preset actually
 * populates Endpoint URL / Auth Type / Header Name with the vendor's known
 * values instead of just being descriptive text, e.g.:
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
				'UX helper only — indicates which backend you are targeting so the Endpoint URL / Auth Type fields below can be filled in with the pattern that backend expects. Does not change request behavior by itself; see the README preset table for the exact values to enter for each backend.',
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
			displayName: 'Custom Headers',
			name: 'customHeaders',
			type: 'json',
			default: '{}',
			displayOptions: { show: { authType: ['customHeaders'] } },
			description:
				'Arbitrary headers sent with every export request, as a JSON object (e.g. {"x-api-key": "..."}). Treat any values here as sensitive — n8n encrypts the whole credential at rest, but avoid pasting secrets into node parameters elsewhere that would surface these values in logs.',
		},
	];

	/**
	 * Custom authenticate function (rather than the declarative `IAuthenticateGeneric`
	 * shape) because which header(s) get set depends on `authType`, which is
	 * itself a credential field — the generic/declarative form can't easily
	 * branch on that. Kept intentionally simple/correct per the scaffold spec;
	 * no network call happens here, this only shapes the request options that
	 * a future `helpers.httpRequestWithAuthentication` call would use once the
	 * real OTLP export (PRD §7, open question O1) is implemented.
	 */
	authenticate = async (
		credentials: ICredentialDataDecryptedObject,
		requestOptions: IHttpRequestOptions,
	): Promise<IHttpRequestOptions> => {
		const headers: Record<string, string> = {
			...((requestOptions.headers as Record<string, string> | undefined) ?? {}),
		};

		const authType = credentials.authType as string;

		if (authType === 'basicAuth') {
			const token = Buffer.from(`${credentials.username as string}:${credentials.password as string}`).toString(
				'base64',
			);
			headers.Authorization = `Basic ${token}`;
		} else if (authType === 'apiKeyHeader') {
			const headerName = (credentials.headerName as string) || 'Authorization';
			headers[headerName] = credentials.apiKey as string;
		} else if (authType === 'customHeaders') {
			let customHeaders: Record<string, string> = {};
			const rawCustomHeaders = credentials.customHeaders;
			if (typeof rawCustomHeaders === 'string') {
				try {
					customHeaders = JSON.parse(rawCustomHeaders) as Record<string, string>;
				} catch {
					customHeaders = {};
				}
			} else if (rawCustomHeaders && typeof rawCustomHeaders === 'object') {
				customHeaders = rawCustomHeaders as Record<string, string>;
			}
			Object.assign(headers, customHeaders);
		}

		return {
			...requestOptions,
			headers,
		};
	};

	/**
	 * TODO: OTLP/HTTP intake endpoints (Langfuse `/api/public/otel`, Opik's and
	 * Datadog's OTLP intake, generic OTel Collector `/v1/traces`) generally do
	 * NOT expose a lightweight GET health-check route the way a REST API would
	 * — they only accept POSTed OTLP payloads (protobuf or JSON) and often
	 * reject anything else with a 405/415 rather than a clean 200. A "real"
	 * test here would need to POST an empty/minimal valid OTLP
	 * ExportTraceServiceRequest and treat any non-5xx response as success,
	 * which isn't safe to do from a credential test without the actual OTLP
	 * export implementation (blocked on PRD open question O1). Left as a
	 * conservative stub (GET the bare endpoint) so the "Test" button exists
	 * without generating misleading vendor telemetry.
	 */
	test: ICredentialTestRequest = {
		request: {
			method: 'GET',
			url: '={{$credentials.endpointUrl}}',
		},
	};
}
