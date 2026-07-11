# n8n-nodes-observability

OpenTelemetry tracing for n8n AI Agent workflows.

The **Trace Exporter** is a passthrough sub-node inserted between a Chat Model
and the AI Agent. Each agent execution is exported as one OTLP/HTTP JSON trace:
one span per LLM call (model, token usage, latency, errors; prompts and
completions opt-in) plus reconstructed tool-call spans. Compatible backends:
Comet Opik, Langfuse, Datadog, or any OTLP/HTTP collector. The package has no
runtime dependencies and does not modify the model or agent nodes.

```
[Anthropic Chat Model] ──ai_languageModel──▶ [Trace Exporter] ──ai_languageModel──▶ [AI Agent]
```

## What a trace looks like

One trace per agent execution (n8n execution ID), named after the Trace Name
parameter:

```
trace "support-agent-run"
├─ support-agent-run                 input: "…"  output: "The result is 163344"
├─ chat claude-sonnet-4-6   683 tok   input messages: [{"role":"user","parts":[…]}]
├─ execute_tool calculator           arguments: "2 × 81672"  result: "163344"
└─ chat claude-sonnet-4-6   791 tok   output messages: [{"role":"assistant","parts":[…]}]
```

Spans use OTel GenAI semantic-convention attributes; backends that map them
(e.g. Opik) derive model, provider, per-call token usage, and cost from the
attributes directly.

## Installation

**Self-hosted n8n:** Settings → Community Nodes → Install → `n8n-nodes-observability`.

Requires n8n with AI (LangChain) nodes available. No external services beyond
your observability backend.

## Setup

1. Add the **Trace Exporter** node between your Chat Model and your AI Agent
   (both connections are the model type — the node is a passthrough).
2. Create an **OTLP Exporter API** credential:

| Backend | Endpoint URL | Primary auth | Preset behavior |
|---|---|---|---|
| Comet Opik (cloud) | `https://www.comet.com/opik/api/v1/private/otel` | API Key Header — `Authorization` | Set Opik Workspace and Project Name; the preset sends `Comet-Workspace` and `projectName` |
| Opik (self-hosted) | `http://<host>:5173/api/v1/private/otel` | Custom Headers / none | Project Name is optional |
| Langfuse | `https://cloud.langfuse.com/api/public/otel` | Basic Auth — public key / secret key | Sends `x-langfuse-ingestion-version: 4` |
| Datadog | `https://otlp-http-intake.logs.<site>/v1/traces` | API Key Header — `dd-api-key` | Sends `dd-otlp-source: llmobs` and the configured `dd-ml-app` |
| Any OTel collector | your collector's OTLP/HTTP base | as configured | Custom preset adds nothing |

**Additional Headers** are applied after the preset and primary auth for every
auth mode. This supports proxies and self-hosted routing, and intentionally
allows an advanced configuration to override a preset header.

> The credential's **Test** button POSTs an empty OTLP payload
> (`{"resourceSpans":[]}`) to `<endpoint>/v1/traces` — the same URL the
> exporter uses — so a reachable backend with valid auth answers 2xx and the
> test passes. No spans are ingested by the test.

3. Optionally set **Trace Name** (names the trace in your backend),
   **Session ID** and **User ID** (expression-friendly — e.g. reference a chat
   session), and **Custom Metadata**.

**Session/thread grouping:** Session ID is exported under the keys each
backend natively groups on — `thread_id` and `gen_ai.conversation.id` (Opik
picks up either as the trace's thread, so executions sharing a Session ID
appear as one conversation under Opik's *Threads*), and `session.id` /
`langfuse.session.id` (Langfuse *Sessions*). User ID is likewise exported as
`user.id` and `langfuse.user.id` (Langfuse *Users*). Set Session ID to a chat
session key (e.g. `{{ $json.sessionId }}`) to get per-conversation grouping.

## Options

| Option | Default | Notes |
|---|---|---|
| Capture Prompts/Completions | **off** | Full prompt/completion text in spans. Off by default: prompt data does not leave your instance unless you opt in. |
| Capture Tool I/O | **off** | Tool-call information from the model's responses. |
| Environment | — | Searchable deployment environment (`deployment.environment.name`, Langfuse environment). |
| Max Payload Size (KB) | 32 | Captured payloads are truncated before export. |
| Redaction Patterns | — | JavaScript regexes (raw or `/pattern/flags`); all matches become `[REDACTED]` before export. |
| Release | — | Searchable release/deployment version. |
| Sampling Rate (%) | 100 | Traces below the sample are dropped in-process. |
| Service Name | `n8n` | OTel `service.name` resource attribute. |
| Tags | — | Searchable trace labels, including Langfuse-native trace tags. |

**Failure policy:** export is asynchronous and fire-and-forget. A slow or
unreachable backend can only ever mean dropped trace data — never a failed or
slowed workflow. Failed exports are logged as warnings.

## What is captured (and what isn't)

Captured per LLM call: requested/resolved model, provider, request controls,
response ID/finish reason, input/output token usage, latency, errors, and — only
when enabled — prompts, completions, and model-side tool-call decisions. All
spans carry n8n context (`n8n.workflow.id/name`, `n8n.execution.id`,
`n8n.node.id/name/type`, item index) plus your session/user/metadata,
environment, release, and tags.

The Trace Exporter also reports model start/end/error through n8n's sub-node
execution API. It therefore turns green when the connected agent actually
invokes the model, and its execution data includes the exported `traceId` and
root `spanId` for correlation with the observability backend. Prompt and
completion content is never duplicated into this n8n execution-state payload.

Redaction applies before payloads leave the process, including error messages
and searchable metadata—not only prompt text. Invalid regexes are ignored and
reported by count without logging the pattern itself. Prompt/completion and
tool I/O capture remain off by default.

Tool *executions* (the actual Calculator/HTTP/etc. runs between LLM calls) are
not visible to a model-attached tracer in n8n's current architecture.
`execute_tool <name>` spans are therefore reconstructed from what does pass
through the model: the tool calls the model requested, matched to the results
echoed back in the next model call. This includes n8n V3's fallback
`Calling <tool> with input: <JSON>` message when a provider callback omits
structured `tool_calls` (all reconstructed spans are marked
`n8n.span.synthesized: true`). Their
timing is derived from the surrounding LLM-call boundaries and includes n8n
framework overhead, not pure tool runtime. A tool whose result never reaches a
later model call (e.g. an error mid-tool) is still emitted at execution end,
marked `n8n.tool.result_observed: false` and without output — as are id-less
tool calls, which can't be matched to their results even when one did flow
through a later model call. Tool input/output payloads are only captured with
**Capture Tool I/O** enabled. Engine-level tool spans (exact timing, engine
visibility) depend on an n8n-core extension point.

## Compatibility

Tested against n8n 2.29 with the AI Agent (Tools Agent) and Anthropic/OpenAI
chat models; any Chat Model sub-node should work — the tracer attaches at the
LangChain callback level and contains no provider-specific code. Requires
Node.js ≥ 22.22 on self-hosted instances.

## Roadmap

- Score / feedback and dataset-item operations
- Engine-level tool spans with exact timing (requires an n8n-core extension point)
- Export retry/backoff, batching, compression, and explicit flush diagnostics
- Multi-destination fan-out

## License

[MIT](LICENSE)
