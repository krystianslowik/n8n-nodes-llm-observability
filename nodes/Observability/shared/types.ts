import type { IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';

/**
 * One entry per operation, keyed by operation `name` — mirrors the
 * `executeMaps` pattern used by the sibling `n8n-nodes-pdf` package
 * (`PdfToolkit.node.ts`) so `Observability.node.ts` stays a thin
 * resource/operation dispatcher instead of a growing switch statement.
 */
export type ExecuteMap = Record<
	string,
	(this: IExecuteFunctions, itemIndex: number) => Promise<INodeExecutionData>
>;
