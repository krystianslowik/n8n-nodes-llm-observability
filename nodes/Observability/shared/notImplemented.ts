import type { IExecuteFunctions } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

/**
 * Every Observability operation in this scaffold is a stub: the actual
 * OTLP/HTTP export (PRD §7 "OTLP/HTTP + protobuf or JSON export implemented
 * against the OTel spec") is deliberately not wired in yet, pending PRD open
 * question O1 (bundling strategy for the OTel SDK against n8n's zero-
 * runtime-dependency verification rule).
 *
 * Every per-operation file in `resources/**` calls this helper instead of
 * implementing real network logic, so that:
 * - the error always names the failing resource/operation, and
 * - the error always carries `itemIndex` so `continueOnFail()` in
 *   `Observability.node.ts` can turn it into a per-item error result instead
 *   of failing the whole execution.
 *
 * When implemented, the real body behind each of these calls MUST use
 * `this.helpers.httpRequest` (never the deprecated `this.helpers.request`,
 * per n8n verification guidelines) to POST an OTLP `ExportTraceServiceRequest`
 * (or Langfuse/Opik-specific score/dataset-item REST calls, whichever the
 * chosen backend needs for Node B's non-tracing operations) to
 * `credentials.endpointUrl`.
 */
export function throwNotImplemented(
	this: IExecuteFunctions,
	operationLabel: string,
	itemIndex: number,
): never {
	throw new NodeOperationError(
		this.getNode(),
		`The "${operationLabel}" operation is not implemented yet`,
		{
			itemIndex,
			description:
				'This is a scaffold stub. See PRD open question O1 (OTel SDK bundling) in the llm-node-prd.md before implementing real OTLP/HTTP export logic here.',
		},
	);
}
