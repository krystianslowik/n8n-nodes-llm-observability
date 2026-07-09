import type { LlmResultLike, SerializedComponent } from './callbackTypes';

/**
 * Best-effort extraction of OTel GenAI semantic-convention values from
 * LangChain callback payloads (spec §"Run-tree tracker", PRD F1). Which of
 * these paths actually carry data per provider is itself a spike finding —
 * extractors never throw, they just return undefined/empty.
 */

/** `["langchain","chat_models","openai","ChatOpenAI"]` -> "openai" */
export function genAiSystemFrom(llm?: SerializedComponent): string {
	const id = llm?.id;
	if (Array.isArray(id) && id.length >= 2) return String(id[id.length - 2]);
	return 'unknown';
}

export function modelNameFrom(
	llm?: SerializedComponent,
	extraParams?: Record<string, unknown>,
): string | undefined {
	const invocationParams = extraParams?.invocation_params as Record<string, unknown> | undefined;
	if (typeof invocationParams?.model === 'string') return invocationParams.model;
	const kwargs = llm?.kwargs;
	if (typeof kwargs?.model === 'string') return kwargs.model;
	if (typeof kwargs?.model_name === 'string') return kwargs.model_name;
	const id = llm?.id;
	if (Array.isArray(id) && id.length > 0) return String(id[id.length - 1]);
	return undefined;
}

export function tokenUsageFrom(output: LlmResultLike): {
	inputTokens?: number;
	outputTokens?: number;
} {
	const tokenUsage = output.llmOutput?.tokenUsage;
	if (typeof tokenUsage?.promptTokens === 'number' || typeof tokenUsage?.completionTokens === 'number') {
		return { inputTokens: tokenUsage.promptTokens, outputTokens: tokenUsage.completionTokens };
	}
	const usage = output.llmOutput?.usage;
	if (typeof usage?.input_tokens === 'number' || typeof usage?.output_tokens === 'number') {
		return { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens };
	}
	const usageMetadata = output.generations?.[0]?.[0]?.message?.usage_metadata;
	if (
		typeof usageMetadata?.input_tokens === 'number' ||
		typeof usageMetadata?.output_tokens === 'number'
	) {
		return { inputTokens: usageMetadata.input_tokens, outputTokens: usageMetadata.output_tokens };
	}
	return {};
}

export function completionTextFrom(output: LlmResultLike): string | undefined {
	const text = output.generations?.[0]?.[0]?.text;
	return typeof text === 'string' && text.length > 0 ? text : undefined;
}
