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

export interface LlmResultLike {
	generations?: Array<
		Array<{
			text?: string;
			message?: {
				usage_metadata?: { input_tokens?: number; output_tokens?: number };
				/** LangChain-normalized tool calls the model decided to make (provider-agnostic). */
				tool_calls?: Array<{ name?: string; args?: unknown; id?: string }>;
				/**
				 * Raw provider payload LangChain passes through unnormalized. OpenAI
				 * puts function-style tool calls here (`arguments` is a JSON string)
				 * when the normalized `tool_calls` above is absent.
				 */
				additional_kwargs?: {
					tool_calls?: Array<{
						id?: string;
						type?: string;
						function?: { name?: string; arguments?: string };
					}>;
				};
			};
		}>
	>;
	llmOutput?: {
		tokenUsage?: { promptTokens?: number; completionTokens?: number };
		usage?: { input_tokens?: number; output_tokens?: number };
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
