# Changelog

All notable changes to this project will be documented in this file.

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
