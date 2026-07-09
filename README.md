# n8n-nodes-observability

OpenTelemetry tracing for n8n AI Agent workflows — without replacing your nodes.

Insert the **Trace Exporter** between any Chat Model and the AI Agent, and every
agent execution shows up in your observability backend as one trace: each LLM
call with model, token usage, cost, latency, and (opt-in) prompts and
completions. Works with **Comet Opik**, **Langfuse**, **Datadog**, or any
OTLP-compatible collector — one protocol, no vendor SDKs, zero runtime
dependencies.

```
[Anthropic Chat Model] ──ai_languageModel──▶ [Trace Exporter] ──ai_languageModel──▶ [AI Agent]
```

Keep your existing provider node. Swap OpenAI for Anthropic for Ollama — the
tracing stays. No forked Agent nodes, no provider lock-in.

## What a trace looks like

One trace per agent execution (n8n execution ID), named after your Trace Name:

```
trace "support-agent-run"
├─ support-agent-run                 (root)
├─ llm:claude-sonnet-4-6   683 tok   prompt: [{"role":"human","content":"…"}]
└─ llm:claude-sonnet-4-6   791 tok   completion: "The result of **2 × 81,672 = 163,344**."
```

Backends that understand OTel GenAI semantic conventions (Opik does natively)
show model, provider, per-call token usage, and computed cost with no extra
configuration.

## Installation

**Self-hosted n8n:** Settings → Community Nodes → Install → `n8n-nodes-observability`.

Requires n8n with AI (LangChain) nodes available. No external services beyond
your observability backend.

## Setup

1. Add the **Trace Exporter** node between your Chat Model and your AI Agent
   (both connections are the model type — the node is a passthrough).
2. Create an **OTLP Exporter API** credential:

| Backend | Endpoint URL | Auth |
|---|---|---|
| Comet Opik (cloud) | `https://www.comet.com/opik/api/v1/private/otel` | API Key Header — header `authorization`, plus custom headers for `Comet-Workspace` and `projectName` if needed |
| Opik (self-hosted) | `http://<host>:5173/api/v1/private/otel` | Custom Headers `{}` (none by default) |
| Langfuse | `https://cloud.langfuse.com/api/public/otel` | Basic Auth — public key / secret key |
| Datadog | `https://otlp-http-intake.logs.<site>/v1/traces` | API Key Header — header `DD-API-KEY` |
| Any OTel collector | your collector's OTLP/HTTP base | as configured |

> The credential's **Test** button GETs the endpoint, and OTLP endpoints only
> accept POSTed span payloads — most backends answer 404 to the test. A failed
> test does **not** mean your credential is wrong; save it and run a workflow.

3. Optionally set **Trace Name** (names the trace in your backend),
   **Session ID** and **User ID** (expression-friendly — e.g. reference a chat
   session), and **Custom Metadata**.

## Options

| Option | Default | Notes |
|---|---|---|
| Capture Prompts/Completions | **off** | Full prompt/completion text in spans. Off by default: prompt data does not leave your instance unless you opt in. |
| Capture Tool I/O | **off** | Tool-call information from the model's responses. |
| Max Payload Size (KB) | 32 | Captured payloads are truncated before export. |
| Sampling Rate (%) | 100 | Traces below the sample are dropped in-process. |
| Redaction Patterns | — | Reserved; not applied yet in this version. |

**Failure policy:** export is asynchronous and fire-and-forget. A slow or
unreachable backend can only ever mean dropped trace data — never a failed or
slowed workflow. Failed exports are logged as warnings.

## What is captured (and what isn't)

Captured per LLM call: model name, provider, input/output token usage, latency,
errors, and — only when enabled — prompts, completions, and model-side tool-call
decisions. All spans carry n8n context (`n8n.workflow.id/name`,
`n8n.execution.id`, `n8n.node.name`) plus your session/user/metadata.

**Current scope is LLM-call observability.** Tool *executions* (the actual
Calculator/HTTP/etc. runs between LLM calls) are not visible to a model-attached
tracer in n8n's current architecture, so they don't appear as first-class spans
yet. With prompt capture enabled, tool activity is readable in the conversation
history of subsequent LLM calls. First-class agent/tool spans are on the
roadmap and depend on an n8n-core extension point.

## Compatibility

Tested against n8n 2.29 with the AI Agent (Tools Agent) and Anthropic/OpenAI
chat models; any Chat Model sub-node should work — the tracer attaches at the
LangChain callback level and contains no provider-specific code. Requires
Node.js ≥ 22.22 on self-hosted instances.

## Roadmap

- Score / feedback and dataset-item operations (evaluations loop)
- First-class tool spans; redaction patterns; per-vendor session mapping
- Multi-destination fan-out

## License

[MIT](LICENSE)
