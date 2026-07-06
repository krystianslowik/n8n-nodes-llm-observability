# n8n-nodes-llm-observability (AI/LLM Observability)

This is an n8n community node package. It lets you export OpenTelemetry
traces for your AI Agent / LLM workflows to the observability platform your
team already uses — Langfuse, Comet Opik, Datadog, or any OTel collector —
**without forking or replacing any built-in node**. It also gives you the
"& Evaluations" half of that workflow: logging scores/feedback to a trace and
creating dataset items for offline evals.

[n8n](https://n8n.io/) is a [fair-code licensed](https://docs.n8n.io/sustainable-use-license/) workflow automation platform.

[Installation](#installation)
[Nodes](#nodes)
[Credentials](#credentials)
[Compatibility](#compatibility)
[Status: scaffold](#status-scaffold)
[Resources](#resources)
[Version history](#version-history)

## Installation

Follow the [installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) in the n8n community nodes documentation.

## Nodes

This package ships two nodes:

### Trace Exporter (sub-node) — the core node

A passthrough middleware sub-node you insert **between any Chat Model and the
AI Agent**. You keep your existing provider node; Trace Exporter wraps
whatever model flows through it with tracing, so swapping providers later
doesn't lose your traces:

```
[OpenAI Chat Model] ──ai_languageModel──▶ [Trace Exporter] ──ai_languageModel──▶ [AI Agent]
```

This mirrors the port topology of n8n's built-in **Model Selector** node
(`inputs`/`outputs` both `ai_languageModel`) — see
[Known caveats](#known-caveats-ai_languagemodel-typing) below.

Parameters:
- **Trace Name**, **Session ID**, **User ID**, **Custom Metadata** (JSON) —
  attached to every trace this node emits.
- **Options**: Capture Prompts/Completions (off by default — see
  [Privacy defaults](#privacy-defaults)), Capture Tool I/O (off by default),
  Max Payload Size (KB), Sampling Rate (%), Redaction Patterns (regex/JSONPath
  list applied before export).

Export is asynchronous and fire-and-forget: a slow or unreachable
observability backend can cause dropped trace data, but it can never fail or
add blocking latency to your workflow.

### Observability (regular node)

Operations for the evaluations loop and manual instrumentation:

| Resource | Operation | Description |
|---|---|---|
| Score | Create | Attach a score/feedback value (name, value, comment) to a trace or span |
| Dataset Item | Create | Add an input/expected-output pair to a dataset for offline evaluation |
| Span | Start / End / Add Event | Open, close, or annotate a custom span around an arbitrary (non-AI) workflow section, so it lands in the same trace |

## Credentials

Both nodes share one credential, **OTLP Exporter API** (`otlpExporterApi`):

| Field | Notes |
|---|---|
| Preset | UX helper: Langfuse / Comet Opik / Datadog / Custom — indicates which backend you're targeting; see the table below for the values to enter |
| Endpoint URL | The OTLP/HTTP endpoint that receives exported traces |
| Auth Type | Basic Auth / API Key Header / Custom Headers |
| Username / Public Key, Password / Secret Key | Shown for Basic Auth (e.g. a Langfuse public/secret key pair) |
| API Key, Header Name | Shown for API Key Header (e.g. Datadog's `DD-API-KEY`) |
| Custom Headers | Shown for Custom Headers — arbitrary JSON object of header name/value pairs |

Preset reference (fill these in manually today — see [Status: scaffold](#status-scaffold)):

| Preset | Endpoint URL pattern | Auth Type | Notes |
|---|---|---|---|
| Langfuse | `https://cloud.langfuse.com/api/public/otel` (or your self-hosted URL) | Basic Auth | Username = public key, Password = secret key |
| Comet Opik | `https://www.comet.com/opik/api/v1/private/otel` (or your self-hosted URL) | API Key Header | Header Name = `Authorization` |
| Datadog | Your Datadog OTLP intake URL for your site | API Key Header | Header Name = `DD-API-KEY` |
| Custom / generic OTel Collector | Your collector's `/v1/traces` URL | whichever your collector expects | — |

## Compatibility

Requires n8n with the AI Agent / LangChain nodes (`@n8n/nodes-langchain`)
available, since Trace Exporter's input/output connects to that ecosystem's
`ai_languageModel` port.

### Known caveats: `ai_languageModel` typing

The `ai_languageModel` connection type is fully supported at **runtime** by
n8n's AI framework — the same port core's **Model Selector** node uses — but
the public `INodeTypeDescription` typings for community (non-core) nodes
don't yet officially model it (tracked internally as **upstream extensibility request**). Existing
published community packages that do this (e.g. `n8n-nodes-openai-langfuse`)
work around it with a targeted type cast; this package does the same on just
the `inputs`/`outputs` fields of `TraceExporter.node.ts` rather than casting
the whole node description.

### Privacy defaults

Prompt/completion capture and tool I/O capture are **off by default**. No
prompt or completion text leaves your instance unless you explicitly enable
those toggles. When enabled, payloads are truncated to the configured Max
Payload Size and run through your configured Redaction Patterns before
export.

## Status: scaffold

This package is a **scaffold**: complete node UIs, a fully wired credential,
and correct execution skeletons — but the OpenTelemetry span emission and the
LangChain callback-handler wiring are **stub functions**, not real
implementations:

- `nodes/TraceExporter/shared/wrapModelWithTracing.ts` currently returns the
  connected model unchanged.
- Every Observability operation throws a `"not implemented yet"`
  `NodeOperationError`.

Both are blocked on the PRD's **open question O1**: does
`@n8n/scan-community-package` accept fully-bundled dependencies? This package
currently ships with **zero runtime dependencies** (a hard verification
requirement), and real span emission needs an OTel SDK
(`@opentelemetry/api` + `@opentelemetry/sdk-trace-*` +
`@opentelemetry/exporter-trace-otlp-http`) plus LangChain's callback base
classes (`@langchain/core`) — neither of which can be added as an ordinary
runtime dependency without resolving that question first (likely via
bundling/vendoring, itself requiring verification-team sign-off).

See `/Users/slowik/Desktop/n8n/projects/nodes/prd/llm-node-prd.md` for the
full product spec and `AGENTS.md` for engineering conventions used in this
repo.

## Resources

- [n8n community nodes documentation](https://docs.n8n.io/integrations/community-nodes/)
- [n8n built-in Model Selector node](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.modelselector/) — the port-topology reference for Trace Exporter
- [OpenTelemetry GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
- [Langfuse OTel ingestion docs](https://langfuse.com/docs/opentelemetry/get-started)
- [Comet Opik OTel docs](https://www.comet.com/docs/opik/tracing/opentelemetry/overview)
- [Datadog OTLP ingestion docs](https://docs.datadoghq.com/opentelemetry/)

## Version history

See [CHANGELOG.md](./CHANGELOG.md).
