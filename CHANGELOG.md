# Changelog

All notable changes to this project will be documented in this file.

## 0.1.1 - 2026-07-09

### Added

- **Synthesized tool spans**: tool calls now appear as first-class child spans
  in the trace, reconstructed from the model's tool-call requests and the
  results echoed back in the next model call (OTel GenAI `execute_tool`
  semantics, `n8n.span.synthesized: true`). Timing spans the gap between the
  surrounding LLM calls; tools whose results never reach a later model call
  are flushed at execution end with `n8n.tool.result_observed: false`.
  Supports both LangChain-normalized and raw OpenAI `tool_calls` shapes.
- **Session/thread grouping**: Session ID now also exports
  `gen_ai.conversation.id`, `thread_id` (populates Opik's Threads view —
  verified against a live instance), and `langfuse.session.id` (Langfuse
  Sessions); User ID also exports `langfuse.user.id`.
- Export POSTs carry a 10-second timeout so a hung backend can no longer pin
  the in-flight export slot.

### Changed

- The model input is now declared with `maxConnections: 1` — the UI prevents
  connecting more than one Chat Model.
- The credential's **Test** button POSTs an empty OTLP payload instead of a
  GET, so a reachable backend with valid auth now answers 2xx instead of the
  previous always-404.
- Payload truncation is UTF-8 byte-accurate (was UTF-16 code units), never
  splits a multi-byte character, and keeps the truncated payload plus marker
  within the configured budget.
- Successful spans no longer set an explicit OK status (OTel convention:
  status is UNSET on success, ERROR on failure).
- The credential's `authenticate` skips the API-key header when the key is
  empty, matching the exporter's behavior.

### Fixed

- A root-span export that failed client-side (e.g. timeout) but was ingested
  by the backend could poison every subsequent batch with 409 conflicts; a
  409 now re-latches the root as delivered, and root re-emission is bounded.
- A malformed provider payload with a huge `tool_calls` array could block the
  workflow thread; extraction and the pending-tool-call ledger are now
  hard-capped with linear-time draining.
- Non-numeric Max Payload Size values fall back to the 32 KB default instead
  of truncating every captured payload to nothing.
- One malformed message object can no longer abort span creation for the
  LLM call it arrived with.

## 0.1.0 - 2026-07-09

### Added

- **Trace Exporter** sub-node: a passthrough between any Chat Model and the
  AI Agent that exports OpenTelemetry traces (OTLP/HTTP JSON, GenAI semantic
  conventions) to Comet Opik, Langfuse, Datadog, or any OTLP collector —
  zero runtime dependencies, no vendor SDKs.
- One trace per agent execution: synthetic root span + one child span per LLM
  call with model, provider, token usage, latency, and error status; n8n
  context (workflow, execution, node) and session/user/metadata attributes on
  every span.
- Opt-in capture of prompts (`[{role, content}]`), completions, and model-side
  tool-call decisions; payload truncation; per-trace sampling.
- Fire-and-forget export with bounded queue: a slow or unreachable backend can
  only ever drop trace data, never fail or block the workflow. Failed root
  spans are retried during the execution and once more at execution end.
- `OTLP Exporter API` credential with Basic Auth / API Key Header / Custom
  Headers modes and Langfuse/Opik/Datadog presets.
- Validated end-to-end against self-hosted Comet Opik (OTLP JSON ingestion,
  native GenAI attribute mapping, cost computation) with Anthropic and OpenAI
  chat models on n8n 2.29.

### Notes

- The `Observability` node (Score / Dataset Item / Span operations) is present
  in source but not registered in this release — its operations are not
  implemented yet and will ship in a later version.
- Tool executions are not visible as first-class spans (n8n architectural
  limit for model-attached tracers); tool activity is readable in captured
  conversation history when prompt capture is enabled.

<!-- scaffold history: ## 0.1.0 - 2026-07-06 initial scaffold -->
