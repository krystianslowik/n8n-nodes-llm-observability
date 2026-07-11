import { NodeConnectionTypes, NodeOperationError, type ISupplyDataFunctions } from 'n8n-workflow';

import type { LlmResultLike, SerializedComponent, TracingHooks } from './callbackTypes';
import { genAiSystemFrom, modelNameFrom, tokenUsageFrom } from './genAiAttributes';

type RunDetails = {
	index: number;
	model?: string;
	provider: string;
};

export type ExecutionStateHandler = TracingHooks & { awaitHandlers: true };

export interface TraceContext {
	traceId: string;
	rootSpanId: string;
}

/**
 * Report this passthrough model as an executed n8n sub-node.
 *
 * A successful `supplyData()` call does not create n8n run data by itself.
 * Built-in middleware such as Model Selector therefore pairs `addInputData()`
 * and `addOutputData()` from a LangChain callback. Without that pair the
 * Trace Exporter works, but stays grey in the editor after an agent run.
 *
 * This handler is deliberately separate from the execution-wide OTLP
 * tracker: n8n creates a fresh SupplyData context for every steppable-agent
 * step, while the OTLP handler must persist across all steps. The UI payload
 * contains only model/provider/usage metadata, so enabling execution-state
 * reporting never expands prompt or completion retention.
 */
export function createExecutionStateHandler(
	ctx: ISupplyDataFunctions,
	getTraceContext?: () => TraceContext | undefined,
): ExecutionStateHandler {
	const runs = new Map<string, RunDetails>();

	const start = (
		llm: SerializedComponent,
		runId: string,
		extraParams?: Record<string, unknown>,
	): void => {
		if (runs.has(runId)) return;
		try {
			const model = modelNameFrom(llm, extraParams);
			const provider = genAiSystemFrom(llm);
			const traceContext = getTraceContext?.();
			const { index } = ctx.addInputData(NodeConnectionTypes.AiLanguageModel, [
				[
					{
						json: {
							provider,
							...(model ? { model } : {}),
							...(traceContext ?? {}),
						},
					},
				],
			]);
			runs.set(runId, { index, model, provider });
		} catch {
			// Execution visualization is best-effort and must never affect the model.
		}
	};

	return {
		name: 'n8nTraceExporterExecutionState',
		// Matches n8n's own LLM execution-state callback. The methods below are
		// synchronous, but this also guarantees an error is painted before the
		// model error reaches the root node if n8n starts awaiting the hook.
		awaitHandlers: true,
		handleLLMStart: (llm, _prompts, runId, _parentRunId, extraParams) => {
			start(llm, runId, extraParams);
		},
		handleLLMEnd: (output: LlmResultLike, runId: string) => {
			const details = runs.get(runId);
			if (!details) return;
			runs.delete(runId);
			try {
				const usage = tokenUsageFrom(output);
				const traceContext = getTraceContext?.();
				ctx.addOutputData(NodeConnectionTypes.AiLanguageModel, details.index, [
					[
						{
							json: {
								provider: details.provider,
								...(details.model ? { model: details.model } : {}),
								...(traceContext ?? {}),
								...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
								...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
							},
						},
					],
				]);
			} catch {
				// Execution visualization is best-effort and must never affect the model.
			}
		},
		handleLLMError: (error: unknown, runId: string) => {
			const details = runs.get(runId);
			if (!details) return;
			runs.delete(runId);
			try {
				let cause: Error;
				if (error instanceof Error) cause = error;
				else {
					try {
						cause = new Error(String(error));
					} catch {
						cause = new Error('Unknown model error');
					}
				}
				ctx.addOutputData(
					NodeConnectionTypes.AiLanguageModel,
					details.index,
					new NodeOperationError(ctx.getNode(), cause, { functionality: 'configuration-node' }),
				);
			} catch {
				// Execution visualization is best-effort and must never affect the model.
			}
		},
	};
}
