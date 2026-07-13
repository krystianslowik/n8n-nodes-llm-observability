# Changelog

All notable changes to this project will be documented in this file.

## 0.1.5 - 2026-07-13

### Added

- Add Language Model picker aliases for observability, OpenTelemetry, OTLP,
  Opik, Langfuse, and Datadog.
- Add explicit sampled/not-sampled execution data, truthful background queue
  status, and execution warnings for setup, redaction, and queue problems.

### Changed

- Rename the node to **AI Trace Exporter**, replace its icon, label both model
  connections, and group privacy, trace attribute, and export settings in node
  version 1.1 while preserving version 1 workflow parameters.
- Replace the credential's preset form with guided backend setup and explicit,
  backward-compatible endpoint authentication.
- Document Datadog through an OpenTelemetry Collector; the Datadog site and API
  key now stay on the collector's Datadog exporter instead of being sent to its
  OTLP receiver.
- Replace README ASCII diagrams with Mermaid and align all labels with the n8n
  editor.

### Fixed

- Preserve explicit authentication on existing Langfuse, Opik, and collector
  credentials instead of silently forcing a backend-specific mode.
- Keep existing traced-model output fan-out valid while restricting the input
  to one Chat Model.
- Correct package metadata and documentation anchors used by n8n discovery.

## 0.1.4 - 2026-07-10

### Added

- Report Trace Exporter model runs through n8n's execution-state API, so the
  middleware appears executed (green) and exposes the OTLP `traceId` and root
  `spanId` in run data for direct backend correlation.
- Apply configurable JavaScript-regex redaction to every captured prompt,
  completion, tool argument/result, error, tag, and metadata value before
  export. Invalid patterns are ignored and counted without logging their text.
- Add searchable Environment, Tags, Release, Service Name, node identity, item
  index, and flattened metadata attributes, including Langfuse-native mappings.
- Export GenAI request controls plus response ID, resolved model, and finish
  reason when the provider callback exposes them.
- Emit standard OTel exception events and propagate LLM failures to the
  synthetic agent root instead of leaving a failed trace apparently healthy.

### Changed

- Make the Langfuse, Opik, and Datadog credential presets operational:
  Langfuse ingestion v4; Opik workspace/project routing; and Datadog LLM
  Observability source/application headers are added automatically. Additional
  headers now compose with every primary auth mode and may override defaults.
- Use current OTel GenAI `gen_ai.provider.name` and standard `chat <model>` span
  naming while retaining deprecated `gen_ai.system` for older backend mappers.
- Export the package's real instrumentation scope name/version, sampled span
  flags, OTLP array attributes, and Langfuse agent/generation/tool/chain types.
- Exclude the unregistered, unimplemented Observability-node stubs and build
  cache from the npm tarball; only the shipped Trace Exporter is packaged.

## 0.1.3 - 2026-07-10

### Fixed

- Reconstruct tool spans from n8n Tools Agent V3's measured
  `Calling <tool> with input: <JSON>` history when current OpenAI Responses
  callbacks omit `message.tool_calls`, including ID-based de-duplication with
  provider-reported calls.
- Export tool I/O under OTel GenAI `gen_ai.tool.call.arguments` / `result` and
  mark reconstructed tools as first-class `tool` spans in Opik.
- Export prompts and completions as structured `gen_ai.input.messages` /
  `gen_ai.output.messages` instead of deprecated prompt/completion fields.
- Close the synthetic root after the final model answer, so the Opik trace has
  its first input, final output, and a duration that contains every child span.

## 0.1.2 - 2026-07-09

### Fixed

- **One agent execution is one trace again on n8n's steppable Tools Agent
  (V3, the current default).** n8n runs `supplyData` close hooks after every
  agent _step_, not at execution end; previous versions evicted the
  per-execution tracing pipeline there, splitting one run into one trace per
  LLM call and losing the pending tool-call ledger (so no tool spans). The
  close hook now only marks the pipeline; eviction happens lazily after a
  linger window, so all steps of an execution share one trace.
- **Tool calls and token usage are captured reliably.** n8n's built-in
  tracing callback mutates the shared LangChain result before later handlers
  run — it strips the `message` (with `tool_calls` and `usage_metadata`) from
  generations. The exporter's handler now attaches first, ahead of the
  mutation.
- **Token usage on OpenAI's Responses API** (auto-selected by LangChain for
  gpt-5-family and other current OpenAI models): usage is additionally read
  from the `estimatedTokenUsage` output — on that path it is the
  backend-reported count, and it was previously missed entirely.

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
