import {
	NodeConnectionTypes,
	type INodeType,
	type INodeTypeDescription,
	type ISupplyDataFunctions,
	type SupplyData,
} from 'n8n-workflow';

import type { OtlpCredential } from './shared/otlpExport';
import { createExecutionStateHandler } from './shared/n8nExecutionState';
import type { ExecutionStateHandler, TraceExecutionContext } from './shared/n8nExecutionState';
import {
	attachHandler,
	wrapModelWithTracing,
	type TraceExporterOptions,
} from './shared/wrapModelWithTracing';

/**
 * A model instance can be reused across steppable-agent supplyData calls.
 * Replace that model's prior step-local UI handler instead of accumulating
 * callbacks bound to stale ISupplyDataFunctions contexts.
 */
function attachExecutionStateHandler(model: unknown, handler: ExecutionStateHandler): boolean {
	if (model && typeof model === 'object') {
		const callbacks = (model as { callbacks?: unknown }).callbacks;
		if (Array.isArray(callbacks)) {
			const existingIndex = callbacks.findIndex(
				(candidate) =>
					candidate !== null &&
					typeof candidate === 'object' &&
					(candidate as { name?: unknown }).name === handler.name,
			);
			if (existingIndex >= 0) {
				callbacks[existingIndex] = handler;
				return true;
			}
		}
	}
	return attachHandler(model, handler);
}

/**
 * Trace Exporter — the core innovation of this package (PRD §5 "Node A").
 *
 * A passthrough middleware sub-node inserted between any Chat Model and the
 * AI Agent:
 *
 *   [OpenAI Chat Model] ──ai_languageModel──▶ [Trace Exporter] ──ai_languageModel──▶ [AI Agent]
 *
 * Known runtime caveat (PRD §7): the
 * `ai_languageModel` (`NodeConnectionTypes.AiLanguageModel`) connection type
 * is supported at *runtime* by n8n's AI framework, but the public
 * `INodeTypeDescription`/`INodeInputConfiguration` typings for community
 * (non-core) nodes do not officially model it — the same situation the core
 * **Model Selector** node's `inputs`/`outputs` are in
 * (`packages/@n8n/nodes-langchain/nodes/ModelSelector/ModelSelector.node.ts`),
 * and the same workaround existing published community packages (e.g.
 * `n8n-nodes-openai-langfuse`) use: a targeted cast on the `inputs`/`outputs`
 * fields. We do the same below rather than casting the whole
 * `INodeTypeDescription`, so everything else on `description` still gets
 * full type-checking.
 */
// This middleware supplies an ai_languageModel connection; it cannot be attached as an AI tool.
// eslint-disable-next-line @n8n/community-nodes/node-usable-as-tool
export class TraceExporter implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'AI Trace Exporter',
		name: 'traceExporter',
		icon: { light: 'file:traceExporter.svg', dark: 'file:traceExporter.dark.svg' },
		group: ['transform'],
		// n8n stores the last light-version entry in the integer
		// InstalledNodes.latestVersion database column for community packages.
		// Keep 1.1 for workflows created with 0.1.5, but use integer 2 as current.
		version: [1, 1.1, 2],
		description:
			'Export AI Agent model and tool traces to Opik, Langfuse, or an OpenTelemetry backend',
		subtitle: '={{$parameter["traceName"]}}',
		defaults: {
			name: 'AI Trace Exporter',
		},
		codex: {
			categories: ['AI'],
			subcategories: {
				AI: ['Language Models'],
			},
			alias: [
				'AI observability',
				'LLM observability',
				'OpenTelemetry',
				'OTel',
				'OTLP',
				'tracing',
				'Langfuse',
				'Opik',
				'Datadog',
			],
		},
		// See the class-level comment above (PRD §7): `AiLanguageModel`
		// is a valid runtime `NodeConnectionType`, but community-node public
		// typings for `inputs`/`outputs` don't yet officially include it, so we
		// cast just these two fields. `maxConnections: 1` — this node wraps
		// exactly one model; a bare-string entry would allow unlimited
		// connections (and make getInputConnectionData return an array).
		inputs: [
			{
				type: NodeConnectionTypes.AiLanguageModel,
				displayName: 'Chat Model',
				required: true,
				maxConnections: 1,
			},
		] as INodeTypeDescription['inputs'],
		outputs: [
			{
				type: NodeConnectionTypes.AiLanguageModel,
				displayName: 'Traced Chat Model',
			},
		] as INodeTypeDescription['outputs'],
		requiredInputs: 1,
		credentials: [
			{
				name: 'otlpExporterApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Connect one Chat Model to the input, then connect the output to an AI Agent',
				name: 'connectionNotice',
				type: 'notice',
				default: '',
			},
			{
				displayName: 'Trace Name',
				name: 'traceName',
				type: 'string',
				default: '',
				placeholder: 'e.g. support-agent-run',
				description: 'Name shown for the root trace. Leave empty to use "n8n agent execution".',
			},
			{
				displayName: 'Session ID',
				name: 'sessionId',
				type: 'string',
				default: '',
				description: 'Stable conversation ID used to group related executions',
			},
			{
				displayName: 'User ID',
				name: 'userId',
				type: 'string',
				default: '',
				description: 'End-user identifier attached to the trace',
			},
			{
				displayName: 'Metadata',
				name: 'metadata',
				type: 'json',
				validateType: 'object',
				default: '{}',
				description: 'JSON object attached to every exported trace',
			},
			{
				displayName: 'Include Prompts and Responses',
				name: 'capturePrompts',
				type: 'boolean',
				default: false,
				description:
					'Whether to export model prompts and responses. These can contain sensitive data.',
				displayOptions: {
					show: {
						'@version': [{ _cnd: { gte: 1.1 } }],
					},
				},
			},
			{
				displayName: 'Include Tool Inputs and Outputs',
				name: 'captureToolIO',
				type: 'boolean',
				default: false,
				description: 'Whether to export tool inputs and outputs. These can contain sensitive data.',
				displayOptions: {
					show: {
						'@version': [{ _cnd: { gte: 1.1 } }],
					},
				},
			},
			{
				displayName:
					'Content capture is off by default. Token counts, latency, model details, errors, and trace context are still exported.',
				name: 'contentCaptureNotice',
				type: 'notice',
				default: '',
				displayOptions: {
					show: {
						'@version': [{ _cnd: { gte: 1.1 } }],
						capturePrompts: [false],
						captureToolIO: [false],
					},
				},
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: {
					show: {
						'@version': [{ _cnd: { lte: 1 } }],
					},
				},
				options: [
					{
						displayName: 'Environment',
						name: 'environment',
						type: 'string',
						default: '',
						placeholder: 'e.g. production',
						description: 'Deployment environment used to filter and compare traces',
					},
					{
						displayName: 'Include Prompts and Responses',
						name: 'capturePrompts',
						type: 'boolean',
						default: false,
						description:
							'Whether to export model prompts and responses. These can contain sensitive data.',
					},
					{
						displayName: 'Include Tool Inputs and Outputs',
						name: 'captureToolIO',
						type: 'boolean',
						default: false,
						description:
							'Whether to export tool inputs and outputs. These can contain sensitive data.',
					},
					{
						displayName: 'Max Payload Size (KB)',
						name: 'maxPayloadSizeKb',
						type: 'number',
						typeOptions: { minValue: 1 },
						default: 32,
						description: 'Captured content larger than this is truncated before export',
					},
					{
						displayName: 'Redaction Patterns',
						name: 'redactionPatterns',
						type: 'string',
						typeOptions: { multipleValues: true },
						default: [],
						placeholder: 'e.g. \\b\\d{16}\\b or /secret-[a-z0-9]+/gi',
						description:
							'JavaScript regular expressions applied to every captured payload, error, tag, and metadata value before export; matches become [REDACTED]',
					},
					{
						displayName: 'Release',
						name: 'release',
						type: 'string',
						default: '',
						placeholder: 'e.g. 1.4.2 or a1b2c3d',
						description: 'Application release or deployment version attached to traces',
					},
					{
						displayName: 'Sampling Rate (%)',
						name: 'samplingRatePercent',
						type: 'number',
						typeOptions: { minValue: 0, maxValue: 100 },
						default: 100,
						description: 'Percentage of traces to queue for export',
					},
					{
						displayName: 'Service Name',
						name: 'serviceName',
						type: 'string',
						default: 'n8n',
						description: 'OpenTelemetry service.name resource attribute',
					},
					{
						displayName: 'Tags',
						name: 'tags',
						type: 'string',
						typeOptions: { multipleValues: true },
						default: [],
						placeholder: 'e.g. support or experiment-a',
						description: 'Searchable labels attached to every span and trace',
					},
				],
			},
			{
				displayName: 'Privacy Options',
				name: 'privacyOptions',
				type: 'collection',
				placeholder: 'Add Privacy Option',
				default: {},
				displayOptions: {
					show: {
						'@version': [{ _cnd: { gte: 1.1 } }],
					},
				},
				options: [
					{
						displayName: 'Max Captured Content Size (KB)',
						name: 'maxPayloadSizeKb',
						type: 'number',
						typeOptions: { minValue: 1 },
						default: 32,
						description: 'Captured content larger than this is truncated before export',
					},
					{
						displayName: 'Redaction Patterns',
						name: 'redactionPatterns',
						type: 'string',
						typeOptions: { multipleValues: true },
						default: [],
						placeholder: 'e.g. \\b\\d{16}\\b or /secret-[a-z0-9]+/gi',
						description:
							'JavaScript regular expressions applied before export; matches become [REDACTED]',
					},
				],
			},
			{
				displayName: 'Trace Attributes',
				name: 'traceAttributes',
				type: 'collection',
				placeholder: 'Add Trace Attribute',
				default: {},
				displayOptions: {
					show: {
						'@version': [{ _cnd: { gte: 1.1 } }],
					},
				},
				options: [
					{
						displayName: 'Environment',
						name: 'environment',
						type: 'string',
						default: '',
						placeholder: 'e.g. production',
						description: 'Deployment environment used to filter and compare traces',
					},
					{
						displayName: 'Release',
						name: 'release',
						type: 'string',
						default: '',
						placeholder: 'e.g. 1.4.2 or a1b2c3d',
						description: 'Application release or deployment identifier',
					},
					{
						displayName: 'Service Name',
						name: 'serviceName',
						type: 'string',
						default: 'n8n',
						description: 'Value used for the OpenTelemetry service.name attribute',
					},
					{
						displayName: 'Tags',
						name: 'tags',
						type: 'string',
						typeOptions: { multipleValues: true },
						default: [],
						placeholder: 'e.g. support or experiment-a',
						description: 'Searchable labels attached to every span and trace',
					},
				],
			},
			{
				displayName: 'Export Options',
				name: 'exportOptions',
				type: 'collection',
				placeholder: 'Add Export Option',
				default: {},
				displayOptions: {
					show: {
						'@version': [{ _cnd: { gte: 1.1 } }],
					},
				},
				options: [
					{
						displayName: 'Sampling Rate (%)',
						name: 'samplingRatePercent',
						type: 'number',
						typeOptions: { minValue: 0, maxValue: 100 },
						default: 100,
						description: 'Percentage of traces to queue for export',
					},
				],
			},
			{
				displayName:
					'Trace export runs in the background. A successful workflow run does not confirm that the backend accepted the trace.',
				name: 'exportNotice',
				type: 'notice',
				default: '',
			},
		],
	};

	async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
		// With `maxConnections: 1` on the input, getInputConnectionData returns
		// the single supplied model directly. The array-unwrap below is a
		// defensive fallback for older n8n versions that still hand back an
		// ARRAY (measured live in the spike: attaching to the array traces
		// nothing).
		const supplied = await this.getInputConnectionData(
			NodeConnectionTypes.AiLanguageModel,
			itemIndex,
		);
		const model = Array.isArray(supplied) ? (supplied[0] as unknown) : supplied;
		const traceContextBox: {
			current?: () => TraceExecutionContext | undefined;
		} = {};
		// `supplyData()` itself does not create run data in n8n. A fresh,
		// step-local callback reports model start/end/error through
		// addInputData/addOutputData so the Trace Exporter appears executed
		// (green) just like n8n's built-in Model Selector middleware. Attach it
		// before the execution-wide OTLP handler below; the latter prepends
		// itself and therefore still reads provider output before n8n's core
		// callback mutates it.
		try {
			if (
				!attachExecutionStateHandler(
					model,
					createExecutionStateHandler(this, () => traceContextBox.current?.()),
				)
			) {
				this.logger.warn(
					'[TraceExporter] could not attach n8n execution-state reporting to the supplied model',
				);
			}
		} catch {
			// UI execution state is best-effort and must never block model passthrough.
		}

		const nodeVersion = this.getNode().typeVersion ?? 1;
		const legacyOptions = this.getNodeParameter('options', itemIndex, {}) as {
			capturePrompts?: boolean;
			captureToolIO?: boolean;
			maxPayloadSizeKb?: number;
			samplingRatePercent?: number;
			redactionPatterns?: string[];
			environment?: string;
			tags?: string[];
			release?: string;
			serviceName?: string;
		};

		let capturePrompts = legacyOptions.capturePrompts ?? false;
		let captureToolIO = legacyOptions.captureToolIO ?? false;
		let maxPayloadSizeKb = legacyOptions.maxPayloadSizeKb ?? 32;
		let samplingRatePercent = legacyOptions.samplingRatePercent ?? 100;
		let redactionPatterns = legacyOptions.redactionPatterns ?? [];
		let environment = legacyOptions.environment ?? '';
		let tags = legacyOptions.tags ?? [];
		let release = legacyOptions.release ?? '';
		let serviceName = legacyOptions.serviceName ?? 'n8n';

		if (nodeVersion >= 1.1) {
			const privacyOptions = this.getNodeParameter('privacyOptions', itemIndex, {}) as {
				maxPayloadSizeKb?: number;
				redactionPatterns?: string[];
			};
			const traceAttributes = this.getNodeParameter('traceAttributes', itemIndex, {}) as {
				environment?: string;
				tags?: string[];
				release?: string;
				serviceName?: string;
			};
			const exportOptions = this.getNodeParameter('exportOptions', itemIndex, {}) as {
				samplingRatePercent?: number;
			};

			capturePrompts = this.getNodeParameter('capturePrompts', itemIndex, false) as boolean;
			captureToolIO = this.getNodeParameter('captureToolIO', itemIndex, false) as boolean;
			maxPayloadSizeKb = privacyOptions.maxPayloadSizeKb ?? 32;
			redactionPatterns = privacyOptions.redactionPatterns ?? [];
			environment = traceAttributes.environment ?? '';
			tags = traceAttributes.tags ?? [];
			release = traceAttributes.release ?? '';
			serviceName = traceAttributes.serviceName ?? 'n8n';
			samplingRatePercent = exportOptions.samplingRatePercent ?? 100;
		}

		const traceExporterOptions: TraceExporterOptions = {
			traceName: this.getNodeParameter('traceName', itemIndex, '') as string,
			sessionId: this.getNodeParameter('sessionId', itemIndex, '') as string,
			userId: this.getNodeParameter('userId', itemIndex, '') as string,
			metadata: this.getNodeParameter('metadata', itemIndex, {}),
			capturePrompts,
			captureToolIO,
			maxPayloadSizeKb,
			samplingRatePercent,
			redactionPatterns,
			environment,
			tags,
			release,
			serviceName,
			itemIndex,
		};

		const credential = (await this.getCredentials(
			'otlpExporterApi',
			itemIndex,
		)) as unknown as OtlpCredential;

		const {
			model: wrappedModel,
			closeFunction,
			getTraceContext,
		} = wrapModelWithTracing(this, model, traceExporterOptions, credential);
		traceContextBox.current = getTraceContext;

		return closeFunction ? { response: wrappedModel, closeFunction } : { response: wrappedModel };
	}
}
