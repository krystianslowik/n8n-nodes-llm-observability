/**
 * Shared helpers for spike scripts talking to a self-hosted (or cloud) Opik.
 * Env contract:
 *   OPIK_URL       — OTLP base, e.g. http://localhost:5173/api/v1/private/otel
 *   OPIK_API_KEY   — optional (cloud or auth-enabled self-host)
 *   OPIK_WORKSPACE — optional (cloud: workspace name)
 *   OPIK_PROJECT   — optional project name (default: "Default Project")
 */
export function opikHeaders(env) {
	const headers = { 'Content-Type': 'application/json' };
	if (env.OPIK_API_KEY) headers.authorization = env.OPIK_API_KEY;
	if (env.OPIK_WORKSPACE) headers['Comet-Workspace'] = env.OPIK_WORKSPACE;
	if (env.OPIK_PROJECT) headers.projectName = env.OPIK_PROJECT;
	return headers;
}

export function otlpTracesUrl(base) {
	const trimmed = base.replace(/\/+$/, '');
	return trimmed.endsWith('/v1/traces') ? trimmed : `${trimmed}/v1/traces`;
}

/** http://host/api/v1/private/otel -> http://host (for the regular REST API) */
export function apiBaseFrom(otlpBase) {
	return otlpBase.replace(/\/+$/, '').replace(/\/api\/v1\/private\/otel$/, '');
}

export function projectName(env) {
	return env.OPIK_PROJECT ?? 'Default Project';
}
