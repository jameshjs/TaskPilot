import { getSettings } from './store';

const TIMEOUT_MS = 25_000;

export class ApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

/** POST JSON to the TaskPilot backend. Throws ApiError on any failure. */
export async function callApi<Res>(path: string, body: unknown): Promise<Res> {
  const settings = await getSettings();
  const url = `${settings.apiUrl.replace(/\/+$/, '')}${path}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(settings.apiToken ? { authorization: `Bearer ${settings.apiToken}` } : {}),
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ApiError(`Backend ${res.status}: ${text.slice(0, 200) || res.statusText}`, res.status);
    }
    return (await res.json()) as Res;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if ((e as Error).name === 'AbortError') throw new ApiError('Backend timed out');
    throw new ApiError(`Cannot reach backend at ${settings.apiUrl}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Fire-and-forget: report a failure to the backend so it lands in Sentry. */
export function reportTelemetry(kind: 'dom_selection_failed' | 'workflow_failed' | 'client_error', message: string, tags?: Record<string, string>, extra?: Record<string, unknown>): void {
  void callApi('/telemetry', { kind, message, tags, extra }).catch(() => undefined);
}
