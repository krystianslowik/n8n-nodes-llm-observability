import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { scoreDescription, scoreExecuteMap } from './resources/score';
import { datasetItemDescription, datasetItemExecuteMap } from './resources/datasetItem';
import { spanDescription, spanExecuteMap } from './resources/span';
import type { ExecuteMap } from './shared/types';

const resourceProperty: INodeProperties = {
	displayName: 'Resource',
	name: 'resource',
	type: 'options',
	noDataExpression: true,
	options: [
		{ name: 'Score', value: 'score' },
		{ name: 'Dataset Item', value: 'datasetItem' },
		{ name: 'Span', value: 'span' },
	],
	default: 'score',
};

// One execute map per resource — keeps `execute()` a thin dispatcher rather
// than a growing switch statement, same pattern as the sibling
// `n8n-nodes-pdf` package's `PdfToolkit.node.ts`.
const executeMaps: Record<string, ExecuteMap> = {
	score: scoreExecuteMap,
	datasetItem: datasetItemExecuteMap,
	span: spanExecuteMap,
};

/**
 * Observability — Node B (PRD §5). Regular (Main-input/output) node covering
 * the evaluations loop (Score, Dataset Item) and manual custom-span
 * instrumentation (Span) that PRD F9 asks for around non-AI workflow steps.
 *
 * Every operation body is a stub for now (see
 * `shared/notImplemented.ts`) — the real OTLP/HTTP export path (PRD §7) is
 * blocked on open question O1 (OTel SDK bundling vs. n8n's zero-runtime-
 * dependency verification rule).
 */
export class Observability implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Observability',
		name: 'observability',
		icon: { light: 'file:observability.svg', dark: 'file:observability.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Log evaluation scores, dataset items, and custom spans to your OTLP observability backend',
		defaults: {
			name: 'Observability',
		},
		codex: {
			categories: ['AI'],
			subcategories: {
				AI: ['Tools'],
			},
		},
		// This node works with small JSON payloads (scores, dataset items, span
		// attributes) and has no binary-data limitations, so it's eligible to be
		// used as an AI Agent tool per the community-nodes lint rule default
		// (contrast with the sibling PDF package, which works with binary PDFs
		// and only sets this per the lint rule's default recommendation rather
		// than genuine AI-tool fit).
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'otlpExporterApi',
				required: true,
			},
		],
		properties: [resourceProperty, ...scoreDescription, ...datasetItemDescription, ...spanDescription],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				const resource = this.getNodeParameter('resource', itemIndex) as string;
				const operation = this.getNodeParameter('operation', itemIndex) as string;

				const executeOperation = executeMaps[resource]?.[operation];
				if (!executeOperation) {
					throw new NodeOperationError(
						this.getNode(),
						`Unknown operation "${operation}" for resource "${resource}"`,
						{ itemIndex },
					);
				}

				returnData.push(await executeOperation.call(this, itemIndex));
			} catch (error) {
				// Every operation body in this scaffold is a stub (see
				// `resources/**` and `shared/notImplemented.ts`), so this branch is
				// expected to run for every item until the operations are
				// implemented (PRD open question O1).
				if (this.continueOnFail()) {
					returnData.push({
						json: this.getInputData(itemIndex)[0].json,
						error,
						pairedItem: itemIndex,
					});
					continue;
				}

				throw error instanceof NodeOperationError
					? error
					: new NodeOperationError(this.getNode(), error as Error, { itemIndex });
			}
		}

		return [returnData];
	}
}
