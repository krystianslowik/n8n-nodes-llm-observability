import type {
	GenerationLike,
	LlmResultLike,
	MessageLike,
	SerializedComponent,
	TokenDetailsLike,
	TokenUsageLike,
	UsageLike,
} from './callbackTypes';

const MAX_GENERATION_BATCHES = 100;
const MAX_GENERATIONS_PER_BATCH = 100;
const MAX_GENERATIONS_TOTAL = 500;
const MAX_CONTENT_BLOCKS = 200;

/**
 * Best-effort extraction of OTel GenAI semantic-convention values from
 * LangChain callback payloads. Extractors never throw and never substitute a
 * class name for a model name or infer response data that was not reported.
 */

const PROVIDER_ALIASES: Record<string, string> = {
	anthropic: 'anthropic',
	awsbedrock: 'aws.bedrock',
	azureaiinference: 'azure.ai.inference',
	azureopenai: 'azure.ai.openai',
	bedrock: 'aws.bedrock',
	chatanthropic: 'anthropic',
	chatbedrock: 'aws.bedrock',
	chatcohere: 'cohere',
	chatgooglegenerativeai: 'gcp.gemini',
	chatgooglevertexai: 'gcp.vertex_ai',
	chatmistralai: 'mistral_ai',
	chatollama: 'ollama',
	chatopenai: 'openai',
	cohere: 'cohere',
	deepseek: 'deepseek',
	googleai: 'gcp.gemini',
	googlegenai: 'gcp.gemini',
	googlegenerativeai: 'gcp.gemini',
	googlevertexai: 'gcp.vertex_ai',
	groq: 'groq',
	mistral: 'mistral_ai',
	mistralai: 'mistral_ai',
	openai: 'openai',
	perplexity: 'perplexity',
	vertexai: 'gcp.vertex_ai',
	watsonx: 'ibm.watsonx.ai',
	watsonxai: 'ibm.watsonx.ai',
	xai: 'x_ai',
};

function providerAlias(value: string): string | undefined {
	const unscoped = value.includes('/') ? (value.split('/').pop() ?? value) : value;
	const lookup = unscoped.toLowerCase().replace(/[^a-z0-9]/g, '');
	return PROVIDER_ALIASES[lookup];
}

/** `['langchain','chat_models','openai','ChatOpenAI']` -> `openai`. */
export function genAiSystemFrom(llm?: SerializedComponent): string {
	const id = llm?.id;
	if (!Array.isArray(id) || id.length === 0) return 'unknown';
	// Prefer the provider/package segment. If the serialized path omits it,
	// exact known LangChain class names remain useful evidence.
	if (id.length >= 2) {
		const candidate = id[id.length - 2];
		const alias = typeof candidate === 'string' ? providerAlias(candidate) : undefined;
		if (alias) return alias;
		if (
			typeof candidate === 'string' &&
			!['chat_models', 'llms', 'models'].includes(candidate.toLowerCase())
		) {
			return candidate.toLowerCase().replace(/-/g, '_');
		}
	}
	const classAlias =
		typeof id[id.length - 1] === 'string' ? providerAlias(id[id.length - 1]) : undefined;
	return classAlias ?? 'unknown';
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value === 'string' && value.length > 0) return value;
	}
	return undefined;
}

export function modelNameFrom(
	llm?: SerializedComponent,
	extraParams?: Record<string, unknown>,
): string | undefined {
	const invocationParams = extraParams?.invocation_params as Record<string, unknown> | undefined;
	const kwargs = llm?.kwargs;
	return firstNonEmptyString(
		invocationParams?.model,
		invocationParams?.model_name,
		invocationParams?.modelName,
		invocationParams?.model_id,
		invocationParams?.modelId,
		kwargs?.model,
		kwargs?.model_name,
		kwargs?.modelName,
		kwargs?.model_id,
		kwargs?.modelId,
	);
}

export interface GenAiRequestDetails {
	choiceCount?: number;
	seed?: number;
	topK?: number;
	stream?: boolean;
	reasoningLevel?: string;
	outputType?: 'text' | 'json' | 'image' | 'speech';
}

function firstFiniteNumber(...values: unknown[]): number | undefined {
	for (const value of values) {
		if (typeof value === 'number' && Number.isFinite(value)) return value;
	}
	return undefined;
}

function firstInteger(...values: unknown[]): number | undefined {
	const value = firstFiniteNumber(...values);
	return value !== undefined && Number.isInteger(value) ? value : undefined;
}

function recordFrom(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** Bounded snapshot shared by every result extractor. */
function generationsFrom(output: LlmResultLike): GenerationLike[] {
	const result: GenerationLike[] = [];
	let batches: LlmResultLike['generations'];
	try {
		batches = output.generations;
	} catch {
		return result;
	}
	if (!Array.isArray(batches)) return result;
	const batchLimit = Math.min(batches.length, MAX_GENERATION_BATCHES);
	for (let batchIndex = 0; batchIndex < batchLimit; batchIndex++) {
		if (!(batchIndex in batches)) continue;
		let batch: GenerationLike[] | undefined;
		try {
			batch = batches[batchIndex];
		} catch {
			continue;
		}
		if (!Array.isArray(batch)) continue;
		const generationLimit = Math.min(
			batch.length,
			MAX_GENERATIONS_PER_BATCH,
			MAX_GENERATIONS_TOTAL - result.length,
		);
		for (let generationIndex = 0; generationIndex < generationLimit; generationIndex++) {
			if (!(generationIndex in batch)) continue;
			try {
				const generation = batch[generationIndex];
				if (generation) result.push(generation);
			} catch {
				/* one hostile candidate must not hide the remaining bounded candidates */
			}
		}
		if (result.length >= MAX_GENERATIONS_TOTAL) break;
	}
	return result;
}

function hasEnumerableOwnProperty(value: object): boolean {
	try {
		for (const key in value) {
			if (Object.prototype.hasOwnProperty.call(value, key)) return true;
		}
	} catch {
		/* hostile structured output is not a usable completion */
	}
	return false;
}

function outputTypeFrom(value: unknown): GenAiRequestDetails['outputType'] {
	const record = recordFrom(value);
	const raw = firstNonEmptyString(
		typeof value === 'string' ? value : undefined,
		record?.type,
		record?.format,
		record?.mime_type,
		record?.mimeType,
	);
	if (!raw) return undefined;
	const normalized = raw.toLowerCase();
	if (normalized.includes('json')) return 'json';
	if (normalized.includes('image')) return 'image';
	if (normalized.includes('audio') || normalized.includes('speech')) return 'speech';
	if (normalized === 'text' || normalized.startsWith('text/')) return 'text';
	return undefined;
}

/** Request controls available in invocation params/serialized kwargs. */
export function requestDetailsFrom(
	llm?: SerializedComponent,
	extraParams?: Record<string, unknown>,
): GenAiRequestDetails {
	const invocation = extraParams?.invocation_params as Record<string, unknown> | undefined;
	const kwargs = llm?.kwargs;
	const reasoning = recordFrom(invocation?.reasoning) ?? recordFrom(kwargs?.reasoning);
	const modalities = invocation?.modalities ?? kwargs?.modalities;
	const requestedModality =
		Array.isArray(modalities) && modalities.length === 1
			? outputTypeFrom(modalities[0])
			: undefined;
	const choiceCount = firstInteger(
		invocation?.n,
		invocation?.candidate_count,
		invocation?.candidateCount,
		kwargs?.n,
		kwargs?.candidate_count,
		kwargs?.candidateCount,
	);
	const topK = firstInteger(
		invocation?.top_k,
		invocation?.topK,
		invocation?.k,
		kwargs?.top_k,
		kwargs?.topK,
		kwargs?.k,
	);
	const streamValue =
		invocation?.stream ?? invocation?.streaming ?? kwargs?.stream ?? kwargs?.streaming;
	const seed = firstInteger(invocation?.seed, kwargs?.seed);
	const reasoningLevel = firstNonEmptyString(
		invocation?.reasoning_effort,
		invocation?.reasoningEffort,
		kwargs?.reasoning_effort,
		kwargs?.reasoningEffort,
		reasoning?.level,
		reasoning?.effort,
	);
	const requestedFormat =
		invocation?.response_format ??
		invocation?.responseFormat ??
		invocation?.response_mime_type ??
		invocation?.responseMimeType ??
		invocation?.output_type ??
		invocation?.outputType ??
		kwargs?.response_format ??
		kwargs?.responseFormat ??
		kwargs?.response_mime_type ??
		kwargs?.responseMimeType ??
		kwargs?.output_type ??
		kwargs?.outputType;
	const outputType = outputTypeFrom(requestedFormat) ?? requestedModality;
	return {
		...(choiceCount !== undefined && choiceCount > 0 ? { choiceCount } : {}),
		...(topK !== undefined && topK > 0 ? { topK } : {}),
		...(seed !== undefined ? { seed } : {}),
		...(typeof streamValue === 'boolean' ? { stream: streamValue } : {}),
		...(reasoningLevel ? { reasoningLevel } : {}),
		...(outputType ? { outputType } : {}),
	};
}

export interface GenAiTokenUsage {
	inputTokens?: number;
	outputTokens?: number;
	cacheReadInputTokens?: number;
	cacheCreationInputTokens?: number;
	reasoningOutputTokens?: number;
}

function nonNegative(...values: unknown[]): number | undefined {
	const value = firstFiniteNumber(...values);
	return value !== undefined && value >= 0 ? value : undefined;
}

function cacheReadFromDetails(details?: TokenDetailsLike): number | undefined {
	return nonNegative(details?.cache_read, details?.cached_tokens);
}

function cacheCreationFromDetails(details?: TokenDetailsLike): number | undefined {
	return nonNegative(details?.cache_creation);
}

function reasoningFromDetails(details?: TokenDetailsLike): number | undefined {
	return nonNegative(details?.reasoning, details?.reasoning_tokens);
}

function inputFromUsage(usage?: UsageLike): number | undefined {
	const input = nonNegative(usage?.input_tokens, usage?.prompt_tokens, usage?.promptTokenCount);
	if (input === undefined) return undefined;
	// Anthropic reports cache read/creation counts as separate top-level fields
	// excluded from input_tokens. Detailed cached-token fields from OpenAI and
	// normalized LangChain usage are already included and must not be added.
	if (
		typeof usage?.cache_read_input_tokens === 'number' ||
		typeof usage?.cache_creation_input_tokens === 'number'
	) {
		return (
			input +
			(nonNegative(usage.cache_read_input_tokens) ?? 0) +
			(nonNegative(usage.cache_creation_input_tokens) ?? 0)
		);
	}
	return input;
}

function cacheReadFromUsage(usage?: UsageLike): number | undefined {
	return nonNegative(
		usage?.cache_read_input_tokens,
		usage?.cachedContentTokenCount,
		cacheReadFromDetails(usage?.input_token_details),
		cacheReadFromDetails(usage?.input_tokens_details),
	);
}

function cacheCreationFromUsage(usage?: UsageLike): number | undefined {
	return nonNegative(
		usage?.cache_creation_input_tokens,
		cacheCreationFromDetails(usage?.input_token_details),
		cacheCreationFromDetails(usage?.input_tokens_details),
	);
}

function reasoningFromUsage(usage?: UsageLike): number | undefined {
	return nonNegative(
		usage?.thoughtsTokenCount,
		reasoningFromDetails(usage?.output_token_details),
		reasoningFromDetails(usage?.output_tokens_details),
	);
}

function messagesFrom(output: LlmResultLike): MessageLike[] {
	const messages: MessageLike[] = [];
	for (const generation of generationsFrom(output)) {
		try {
			if (generation.message) messages.push(generation.message);
		} catch {
			/* provider result objects are untrusted callback input */
		}
	}
	return messages;
}

function tokenUsageCacheRead(usage?: TokenUsageLike): number | undefined {
	return nonNegative(
		usage?.cacheReadInputTokens,
		usage?.promptTokensDetails?.cachedTokens,
		usage?.promptTokensDetails?.cacheRead,
	);
}

export function tokenUsageFrom(output: LlmResultLike): GenAiTokenUsage {
	const tokenUsage = output.llmOutput?.tokenUsage;
	const providerUsage = output.llmOutput?.usage;
	const estimated = output.llmOutput?.estimatedTokenUsage;
	const messages = messagesFrom(output);
	const messageUsage = messages.map((message) => message.usage_metadata);
	const responseUsage = messages.map((message) => message.response_metadata?.usage);
	const responseTokenUsage = messages.map((message) => message.response_metadata?.tokenUsage);
	const inputTokens = nonNegative(
		tokenUsage?.promptTokens,
		inputFromUsage(providerUsage),
		...messageUsage.map((usage) => inputFromUsage(usage)),
		...responseUsage.map((usage) => inputFromUsage(usage)),
		...responseTokenUsage.map((usage) => usage?.promptTokens),
		estimated?.promptTokens,
	);
	const outputTokens = nonNegative(
		tokenUsage?.completionTokens,
		providerUsage?.output_tokens,
		providerUsage?.completion_tokens,
		providerUsage?.candidatesTokenCount,
		...messageUsage.flatMap((usage) => [
			usage?.output_tokens,
			usage?.completion_tokens,
			usage?.candidatesTokenCount,
		]),
		...responseUsage.flatMap((usage) => [
			usage?.output_tokens,
			usage?.completion_tokens,
			usage?.candidatesTokenCount,
		]),
		...responseTokenUsage.map((usage) => usage?.completionTokens),
		estimated?.completionTokens,
	);
	const cacheReadInputTokens = nonNegative(
		tokenUsageCacheRead(tokenUsage),
		cacheReadFromUsage(providerUsage),
		...messageUsage.map((usage) => cacheReadFromUsage(usage)),
		...responseUsage.map((usage) => cacheReadFromUsage(usage)),
		...responseTokenUsage.map((usage) => tokenUsageCacheRead(usage)),
		tokenUsageCacheRead(estimated),
	);
	const cacheCreationInputTokens = nonNegative(
		tokenUsage?.cacheCreationInputTokens,
		cacheCreationFromUsage(providerUsage),
		...messageUsage.map((usage) => cacheCreationFromUsage(usage)),
		...responseUsage.map((usage) => cacheCreationFromUsage(usage)),
		...responseTokenUsage.map((usage) => usage?.cacheCreationInputTokens),
		estimated?.cacheCreationInputTokens,
	);
	const reasoningOutputTokens = nonNegative(
		tokenUsage?.reasoningOutputTokens,
		tokenUsage?.completionTokensDetails?.reasoningTokens,
		reasoningFromUsage(providerUsage),
		...messageUsage.map((usage) => reasoningFromUsage(usage)),
		...responseUsage.map((usage) => reasoningFromUsage(usage)),
		...responseTokenUsage.flatMap((usage) => [
			usage?.reasoningOutputTokens,
			usage?.completionTokensDetails?.reasoningTokens,
		]),
		estimated?.reasoningOutputTokens,
		estimated?.completionTokensDetails?.reasoningTokens,
	);
	return {
		...(inputTokens !== undefined ? { inputTokens } : {}),
		...(outputTokens !== undefined ? { outputTokens } : {}),
		...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
		...(cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens } : {}),
		...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
	};
}

function textFromContent(content: unknown): string | undefined {
	if (typeof content === 'string' && content.length > 0) return content;
	if (!Array.isArray(content)) return undefined;
	const text: string[] = [];
	const limit = Math.min(content.length, MAX_CONTENT_BLOCKS);
	for (let index = 0; index < limit; index++) {
		if (!(index in content)) continue;
		let block: unknown;
		try {
			block = content[index];
		} catch {
			continue;
		}
		if (typeof block === 'string') {
			if (block.length > 0) text.push(block);
			continue;
		}
		const record = recordFrom(block);
		if (!record) continue;
		const type = firstNonEmptyString(record.type)?.toLowerCase();
		if (type === 'text' || type === 'input_text' || type === 'output_text') {
			const value = firstNonEmptyString(record.text, record.content);
			if (value) text.push(value);
		}
	}
	return text.length > 0 ? text.join('') : undefined;
}
function meaningfulStructuredValue(value: unknown): unknown | undefined {
	if (value === undefined || value === null || value === '') return undefined;
	if (typeof value !== 'object') return value;
	if (Array.isArray(value)) {
		if (value.length === 0) return undefined;
		const blocks = Array.prototype.slice.call(value, 0, MAX_CONTENT_BLOCKS) as unknown[];
		const typedBlocks = blocks
			.map((block) => recordFrom(block)?.type)
			.filter((type): type is string => typeof type === 'string');
		if (typedBlocks.length > 0 && typedBlocks.every((type) => /tool|function/i.test(type))) {
			return undefined;
		}
		return value;
	}
	const type = recordFrom(value)?.type;
	if (typeof type === 'string' && /tool|function/i.test(type)) return undefined;
	return hasEnumerableOwnProperty(value) ? value : undefined;
}

/** First meaningful candidate, including structured terminal completions. */
export function completionValueFrom(output: LlmResultLike): unknown | undefined {
	for (const generation of generationsFrom(output)) {
		try {
			const text = firstNonEmptyString(generation.text);
			if (text) return text;
			const structuredText =
				typeof generation.text === 'string'
					? undefined
					: meaningfulStructuredValue(generation.text);
			if (structuredText !== undefined) return structuredText;
			const contentText = textFromContent(generation.message?.content);
			if (contentText) return contentText;
			const content = meaningfulStructuredValue(generation.message?.content);
			if (content !== undefined) return content;
		} catch {
			/* continue to the next bounded candidate */
		}
	}
	return undefined;
}

/** String-only compatibility accessor used by lifecycle detection. */
export function completionTextFrom(output: LlmResultLike): string | undefined {
	const completion = completionValueFrom(output);
	return typeof completion === 'string' ? completion : undefined;
}

function finishReasonFrom(generation: GenerationLike): string | undefined {
	return firstNonEmptyString(
		generation.generationInfo?.finish_reason,
		generation.generationInfo?.stop_reason,
		generation.message?.response_metadata?.finish_reason,
		generation.message?.response_metadata?.stop_reason,
	);
}

export function responseDetailsFrom(output: LlmResultLike): {
	id?: string;
	model?: string;
	finishReasons?: string[];
} {
	const generations = generationsFrom(output);
	const messages = generations.map((generation) => generation.message).filter((message) => message);
	const id = firstNonEmptyString(
		output.llmOutput?.id,
		output.llmOutput?.response_id,
		...messages.flatMap((message) => [
			message?.response_metadata?.id,
			message?.response_metadata?.response_id,
			message?.id,
		]),
	);
	const model = firstNonEmptyString(
		output.llmOutput?.model,
		output.llmOutput?.model_name,
		...messages.flatMap((message) => [
			message?.response_metadata?.model,
			message?.response_metadata?.model_name,
		]),
	);
	const finishReasons = generations
		.map((generation) => finishReasonFrom(generation))
		.filter((reason): reason is string => reason !== undefined);
	return {
		...(id ? { id } : {}),
		...(model ? { model } : {}),
		...(finishReasons.length > 0 ? { finishReasons } : {}),
	};
}

/** Sanity cap shared with the tracker's pending-tool-call ledger. */
const MAX_TOOL_CALLS = 100;

function callsFromMessage(
	message: MessageLike | undefined,
	limit: number,
): Array<{ id?: string; name?: string; args?: unknown }> {
	const calls: Array<{ id?: string; name?: string; args?: unknown }> = [];
	if (limit <= 0) return calls;
	const normalized = message?.tool_calls;
	if (Array.isArray(normalized) && normalized.length > 0) {
		const bounded = Array.prototype.slice.call(normalized, 0, limit) as typeof normalized;
		for (const call of bounded) {
			calls.push({
				...(typeof call?.id === 'string' ? { id: call.id } : {}),
				...(typeof call?.name === 'string' ? { name: call.name } : {}),
				args: call?.args,
			});
		}
		return calls;
	}
	const raw = message?.additional_kwargs?.tool_calls;
	if (!Array.isArray(raw)) return calls;
	const bounded = Array.prototype.slice.call(raw, 0, limit) as typeof raw;
	for (const call of bounded) {
		let args: unknown = call?.function?.arguments;
		if (typeof args === 'string') {
			try {
				args = JSON.parse(args);
			} catch {
				/* retain the raw provider value */
			}
		}
		calls.push({
			...(typeof call?.id === 'string' ? { id: call.id } : {}),
			...(typeof call?.function?.name === 'string' ? { name: call.function.name } : {}),
			args,
		});
	}
	return calls;
}

/** All model-requested calls across every batch/candidate, capped globally. */
export function toolCallsFrom(
	output: LlmResultLike,
): Array<{ id?: string; name?: string; args?: unknown }> {
	const result: Array<{ id?: string; name?: string; args?: unknown }> = [];
	for (const generation of generationsFrom(output)) {
		const remaining = MAX_TOOL_CALLS - result.length;
		try {
			result.push(...callsFromMessage(generation.message, remaining));
		} catch {
			/* one hostile candidate must not make tracing fail */
		}
		if (result.length >= MAX_TOOL_CALLS) return result;
	}
	return result;
}
