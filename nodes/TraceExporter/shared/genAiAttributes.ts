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

/**
 * Sanity cap on extracted tool calls per LLM result, applied by slicing the
 * source array BEFORE mapping so a giant malformed `tool_calls` payload never
 * even allocates a giant mapped copy. Matches the tracker's pending-ledger
 * bound (MAX_PENDING_TOOL_CALLS).
 */
const MAX_TOOL_CALLS = 100;

/**
 * Tool calls the model decided to make, from LangChain's provider-normalized
 * `message.tool_calls`. Tool *executions* never reach a model-attached
 * callback handler (measured live in the spike) — this is the model-side view
 * of tool activity, which is the best a passthrough sub-node can observe.
 */
export function toolCallsFrom(
	output: LlmResultLike,
): Array<{ id?: string; name?: string; args?: unknown }> {
	const message = output.generations?.[0]?.[0]?.message;
	const normalized = message?.tool_calls;
	if (Array.isArray(normalized) && normalized.length > 0) {
		return normalized
			.slice(0, MAX_TOOL_CALLS)
			.map((call) => ({ id: call?.id, name: call?.name, args: call?.args }));
	}
	// Fallback: raw OpenAI shape in additional_kwargs — `arguments` is a JSON
	// string; parse best-effort, keep the raw string when parsing fails.
	const raw = message?.additional_kwargs?.tool_calls;
	if (!Array.isArray(raw)) return [];
	return raw.slice(0, MAX_TOOL_CALLS).map((call) => {
		let args: unknown = call?.function?.arguments;
		if (typeof args === 'string') {
			try {
				args = JSON.parse(args);
			} catch {
				/* keep the unparsed string */
			}
		}
		return { id: call?.id, name: call?.function?.name, args };
	});
}
