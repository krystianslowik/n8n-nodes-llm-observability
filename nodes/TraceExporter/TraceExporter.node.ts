import {
	NodeConnectionTypes,
	type INodeType,
	type INodeTypeDescription,
	type ISupplyDataFunctions,
	type SupplyData,
} from 'n8n-workflow';

import type { OtlpCredential } from './shared/otlpExport';
import { wrapModelWithTracing, type TraceExporterOptions } from './shared/wrapModelWithTracing';

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
export class TraceExporter implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Trace Exporter',
		name: 'traceExporter',
		icon: { light: 'file:traceExporter.svg', dark: 'file:traceExporter.dark.svg' },
		group: ['transform'],
		version: 1,
		description:
			'Wraps a connected Chat Model with OpenTelemetry trace export (Langfuse, Comet Opik, Datadog, or any OTLP collector) without replacing the model or the AI Agent',
		subtitle: '={{$parameter["traceName"] || "Trace Exporter"}}',
		defaults: {
			name: 'Trace Exporter',
		},
		// This is a middleware sub-node with `ai_languageModel` in/out (no
		// `main` input/output) — an AI Agent can't attach it as a `tool` the way
		// it would a regular node; it sits between the model and the agent
		// instead. `UsableAsToolDescription`'s type doesn't accept `false`
		// (only `true | UsableAsToolDescription | undefined`), and omitting the
		// field trips `@n8n/community-nodes/node-usable-as-tool`'s "when in
		// doubt, set it to true" default. `true` here is a lint-rule
		// accommodation, not an assertion that this sub-node is meaningfully
		// tool-usable — same resolution the sibling `n8n-nodes-pdf` package
		// uses for its own not-quite-fitting case.
		usableAsTool: true,
		codex: {
			categories: ['AI'],
			subcategories: {
				AI: ['Language Models'],
			},
		},
		// See the class-level comment above (PRD §7): `AiLanguageModel`
		// is a valid runtime `NodeConnectionType`, but community-node public
		// typings for `inputs`/`outputs` don't yet officially include it, so we
		// cast just these two fields. `maxConnections: 1` — this node wraps
		// exactly one model; a bare-string entry would allow unlimited
		// connections (and make getInputConnectionData return an array).
		inputs: [
			{ type: NodeConnectionTypes.AiLanguageModel, maxConnections: 1 },
		] as INodeTypeDescription['inputs'],
		outputs: [NodeConnectionTypes.AiLanguageModel] as INodeTypeDescription['outputs'],
		credentials: [
			{
				name: 'otlpExporterApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Trace Name',
				name: 'traceName',
				type: 'string',
				default: '',
				placeholder: 'e.g. support-agent-run',
				description: 'Name attached to the trace emitted for each agent execution (PRD F4)',
			},
			{
				displayName: 'Session ID',
				name: 'sessionId',
				type: 'string',
				default: '',
				description:
					'Groups multiple traces into one conversation/session in the observability backend. Expression-friendly — e.g. reference a chat session ID from earlier in the workflow.',
			},
			{
				displayName: 'User ID',
				name: 'userId',
				type: 'string',
				default: '',
				description: 'End-user identifier attached to the trace, for per-user cost/usage breakdowns in the backend',
			},
			{
				displayName: 'Custom Metadata',
				name: 'metadata',
				type: 'json',
				default: '{}',
				description: 'Arbitrary JSON object attached to every trace emitted by this node',
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Capture Prompts/Completions',
						name: 'capturePrompts',
						type: 'boolean',
						default: false,
						description:
							'Whether to include full prompt/completion text in exported spans. Off by default (PRD R5: sensitive prompt data must not leave the instance unless explicitly opted in).',
					},
					{
						displayName: 'Capture Tool I/O',
						name: 'captureToolIO',
						type: 'boolean',
						default: false,
						description: 'Whether to include tool call inputs/outputs in exported spans. Off by default for the same privacy reason as prompt/completion capture.',
					},
					{
						displayName: 'Max Payload Size (KB)',
						name: 'maxPayloadSizeKb',
						type: 'number',
						default: 32,
						description: 'Prompt/completion/tool payloads larger than this are truncated before export (PRD §5 "max payload size + truncation")',
					},
					{
						displayName: 'Redaction Patterns',
						name: 'redactionPatterns',
						type: 'string',
						typeOptions: { multipleValues: true },
						default: [],
						placeholder: 'e.g. \\b\\d{16}\\b or $.customer.email',
						description: 'Regex or JSONPath patterns applied to captured payloads before export; matches are redacted (PRD §5, enterprise ask: "sensitive data exposed in logs")',
					},
					{
						displayName: 'Sampling Rate (%)',
						name: 'samplingRatePercent',
						type: 'number',
						typeOptions: { minValue: 0, maxValue: 100 },
						default: 100,
						description: 'Percentage of traces to export; the rest are dropped before ever leaving the process (PRD §5 "Sampling rate (0-100%)")',
					},
				],
			},
			{
				displayName: 'Export runs asynchronously in the background and never blocks or fails the workflow — a slow or unreachable observability backend only results in dropped trace data, never a failed node (PRD §5 failure policy, §6 non-functional requirements)',
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
		const supplied = await this.getInputConnectionData(NodeConnectionTypes.AiLanguageModel, itemIndex);
		const model = Array.isArray(supplied) ? (supplied[0] as unknown) : supplied;

		const options = this.getNodeParameter('options', itemIndex, {}) as {
			capturePrompts?: boolean;
			captureToolIO?: boolean;
			maxPayloadSizeKb?: number;
			samplingRatePercent?: number;
			redactionPatterns?: string[];
		};

		const traceExporterOptions: TraceExporterOptions = {
			traceName: this.getNodeParameter('traceName', itemIndex, '') as string,
			sessionId: this.getNodeParameter('sessionId', itemIndex, '') as string,
			userId: this.getNodeParameter('userId', itemIndex, '') as string,
			metadata: this.getNodeParameter('metadata', itemIndex, {}),
			capturePrompts: options.capturePrompts ?? false,
			captureToolIO: options.captureToolIO ?? false,
			maxPayloadSizeKb: options.maxPayloadSizeKb ?? 32,
			samplingRatePercent: options.samplingRatePercent ?? 100,
			redactionPatterns: options.redactionPatterns ?? [],
		};

		const credential = (await this.getCredentials(
			'otlpExporterApi',
			itemIndex,
		)) as unknown as OtlpCredential;

		const { model: wrappedModel, closeFunction } = wrapModelWithTracing(
			this,
			model,
			traceExporterOptions,
			credential,
		);

		return closeFunction ? { response: wrappedModel, closeFunction } : { response: wrappedModel };
	}
}
