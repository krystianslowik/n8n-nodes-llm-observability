/**
 * Structural (duck-typed) subset of `@langchain/core`'s callback surface —
 * defined locally so this package imports nothing from LangChain (spec
 * "Constraints": zero runtime dependencies, zero bundled code). LangChain's
 * `Callbacks` type accepts plain `CallbackHandlerMethods`-shaped objects in a
 * model's `callbacks` array; these types mirror exactly the hooks the spike
 * measures. Signatures follow @langchain/core@0.3 (positional runId /
 * parentRunId); trailing parameters LangChain passes beyond these are simply
 * ignored by our handlers.
 */

export interface SerializedComponent {
	id?: string[];
	kwargs?: Record<string, unknown>;
}

export interface TokenDetailsLike {
	cache_read?: number;
	cache_creation?: number;
	cached_tokens?: number;
	reasoning?: number;
	reasoning_tokens?: number;
}

export interface UsageLike {
	input_tokens?: number;
	output_tokens?: number;
	prompt_tokens?: number;
	completion_tokens?: number;
	promptTokenCount?: number;
	candidatesTokenCount?: number;
	cache_read_input_tokens?: number;
	cache_creation_input_tokens?: number;
	cachedContentTokenCount?: number;
	thoughtsTokenCount?: number;
	input_token_details?: TokenDetailsLike;
	input_tokens_details?: TokenDetailsLike;
	output_token_details?: TokenDetailsLike;
	output_tokens_details?: TokenDetailsLike;
}

export interface TokenUsageLike {
	promptTokens?: number;
	completionTokens?: number;
	cacheReadInputTokens?: number;
	cacheCreationInputTokens?: number;
	reasoningOutputTokens?: number;
	promptTokensDetails?: { cachedTokens?: number; cacheRead?: number };
	completionTokensDetails?: { reasoningTokens?: number };
}

export interface MessageLike {
	id?: unknown;
	content?: unknown;
	name?: unknown;
	usage_metadata?: UsageLike;
	response_metadata?: {
		id?: unknown;
		response_id?: unknown;
		model?: unknown;
		model_name?: unknown;
		finish_reason?: unknown;
		stop_reason?: unknown;
		usage?: UsageLike;
		tokenUsage?: TokenUsageLike;
	};
	/** LangChain-normalized tool calls the model decided to make (provider-agnostic). */
	tool_calls?: Array<{ name?: unknown; args?: unknown; id?: unknown }>;
	/**
	 * Raw provider payload LangChain passes through unnormalized. OpenAI puts
	 * function-style tool calls here when the normalized shape is absent.
	 */
	additional_kwargs?: {
		tool_calls?: Array<{
			id?: unknown;
			type?: unknown;
			function?: { name?: unknown; arguments?: unknown };
		}>;
	};
}

export interface GenerationLike {
	text?: unknown;
	generationInfo?: { finish_reason?: unknown; stop_reason?: unknown };
	message?: MessageLike;
}

export interface LlmResultLike {
	generations?: GenerationLike[][];
	llmOutput?: {
		id?: unknown;
		response_id?: unknown;
		model?: unknown;
		model_name?: unknown;
		tokenUsage?: TokenUsageLike;
		usage?: UsageLike;
		/** @langchain/openai Responses-API path; backend-reported there despite the name. */
		estimatedTokenUsage?: TokenUsageLike;
	};
}

export interface AgentActionLike {
	tool?: string;
	toolInput?: unknown;
	log?: string;
}

/**
 * The measurement surface. Every hook the spike cares about, in
 * CallbackHandlerMethods shape. All optional so the handler object literal
 * can pick what it implements; `name` helps n8n/LangChain debugging output.
 */
export interface TracingHooks {
	name: string;
	handleChatModelStart?(
		llm: SerializedComponent,
		messages: unknown[][],
		runId: string,
		parentRunId?: string,
		extraParams?: Record<string, unknown>,
	): void;
	handleLLMStart?(
		llm: SerializedComponent,
		prompts: string[],
		runId: string,
		parentRunId?: string,
		extraParams?: Record<string, unknown>,
	): void;
	handleLLMEnd?(output: LlmResultLike, runId: string, parentRunId?: string): void;
	handleLLMError?(error: unknown, runId: string, parentRunId?: string): void;
	/**
	 * LangChain streaming callback. Token content is intentionally ignored by
	 * the tracker; the first invocation is enough to measure time to first
	 * chunk without retaining a duplicate response stream.
	 */
	handleLLMNewToken?(
		token: string,
		indices: { prompt?: number; completion?: number },
		runId: string,
		parentRunId?: string,
	): void;
	handleChainStart?(
		chain: SerializedComponent,
		inputs: Record<string, unknown>,
		runId: string,
		parentRunId?: string,
	): void;
	handleChainEnd?(outputs: Record<string, unknown>, runId: string, parentRunId?: string): void;
	handleChainError?(error: unknown, runId: string, parentRunId?: string): void;
	handleToolStart?(
		tool: SerializedComponent,
		input: string,
		runId: string,
		parentRunId?: string,
	): void;
	handleToolEnd?(output: unknown, runId: string, parentRunId?: string): void;
	handleToolError?(error: unknown, runId: string, parentRunId?: string): void;
	handleAgentAction?(action: AgentActionLike, runId: string, parentRunId?: string): void;
}
