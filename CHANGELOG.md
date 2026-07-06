# Changelog

All notable changes to this project will be documented in this file.

## 0.1.0 - 2026-07-06

### Added

- Initial scaffold: `Trace Exporter` middleware sub-node (`ai_languageModel`
  in/out, wraps a connected Chat Model), `Observability` node (Score, Dataset
  Item, Span resources), and shared `OtlpExporterApi` credential
  (Langfuse/Opik/Datadog/Custom presets, Basic Auth / API Key Header / Custom
  Headers). All OTel span emission and LangChain callback-handler internals
  are stubs pending PRD open question O1 (OTel SDK bundling strategy).
