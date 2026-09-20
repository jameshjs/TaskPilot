/**
 * Composio REST client. The extension never holds a provider credential: it asks this
 * Worker, the Worker holds COMPOSIO_API_KEY, and Composio holds the user's OAuth tokens.
 *
 * REST rather than @composio/core: the SDK calls `createRequire(import.meta.url)` at
 * init, and `import.meta.url` is undefined in Workers, so it throws on startup
 * (ComposioHQ/composio#2296). REST is three endpoints and no dependency.
 *
 * Endpoints (base defaults to https://backend.composio.dev/api, auth is `x-api-key`):
 *   GET  /v3.1/connected_accounts?user_id=…        → { items: [{ id, status, toolkit }] }
 *   POST /v3.1/connected_accounts/link             → { redirect_url, session_uri }
 *   POST /v3/tools/execute/{tool_slug}             → { data, error, successful, log_id }
 *
 * Shapes are read defensively — a provider response is untrusted input, same as a model
 * response in openai.ts.
 */
import type { IntegrationName, IntegrationState } from '../../shared/api';
import type { Env } from './env';
import { HttpError } from './http';
import type { ToolSpec } from './tools';

const TIMEOUT_MS = 20_000;
const DEFAULT_BASE = 'https://backend.composio.dev/api';

export function isLive(env: Env): boolean {
  return !!env.COMPOSIO_API_KEY;
}

function base(env: Env): string {
  return (env.COMPOSIO_BASE_URL || DEFAULT_BASE).replace(/\/+$/, '');
}

/**
 * One Composio call. Failures are deliberately flattened to a fixed message: index.ts
 * echoes `e.message` to the client, and a provider body can carry account details.
 * The detail goes to the Worker log instead.
 */
async function call<T>(env: Env, path: string, init: { method: 'GET' | 'POST'; body?: unknown }): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(base(env) + path, {
      method: init.method,
      headers: { 'content-type': 'application/json', 'x-api-key': env.COMPOSIO_API_KEY ?? '' },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: ctrl.signal,
    });
  } catch (e) {
    console.log(JSON.stringify({ event: 'composio.network_error', path, message: (e as Error).message }));
    throw new HttpError((e as Error).name === 'AbortError' ? 504 : 502, 'Could not reach the connected-apps service.');
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // Body is logged, never returned: it can contain account identifiers.
    console.log(JSON.stringify({ event: 'composio.error', path, status: res.status, body: (await res.text().catch(() => '')).slice(0, 500) }));
    if (res.status === 429) throw new HttpError(429, 'The connected-apps service is rate limiting; try again shortly.');
    if (res.status === 401 || res.status === 403) throw new HttpError(502, 'The connected-apps service rejected TaskPilot’s credentials.');
    throw new HttpError(502, 'The connected-apps service failed to handle that request.');
  }
  try {
    return (await res.json()) as T;
  } catch {
    throw new HttpError(502, 'The connected-apps service returned an unreadable response.');
  }
}

// ── Connections ────────────────────────────────────────────────────────────

/** Composio's per-account lifecycle. Only ACTIVE can actually run a tool. */
function toStatus(raw: unknown): IntegrationState['status'] {
  return String(raw ?? '').toUpperCase() === 'ACTIVE' ? 'connected' : 'disconnected';
}

/** Hardcoded per toolkit: Composio reports no scope list we can show the user. */
const SCOPES: Record<IntegrationName, string[]> = {
  github: ['read repositories', 'read issues', 'create issues'],
  googlecalendar: ['read upcoming events'],
  gmail: ['read recent mail'],
  discord: [],
};

function demoState(name: IntegrationName): IntegrationState {
  return { name, status: 'demo', account: 'demo-user', scopes: SCOPES[name] };
}

/**
 * The real connection state for one user. Unlike the previous implementation this asks
 * Composio rather than inferring "connected" from the presence of an API key.
 */
export async function listConnections(env: Env, userId: string, toolkits: IntegrationName[]): Promise<IntegrationState[]> {
  if (!isLive(env)) return toolkits.map(demoState);

  const res = await call<{ items?: unknown[] }>(env, `/v3.1/connected_accounts?user_id=${encodeURIComponent(userId)}`, { method: 'GET' });
  const items = Array.isArray(res.items) ? res.items : [];

  return toolkits.map((name) => {
    const found = items.find((i) => {
      const row = i as Record<string, unknown>;
      const slug = (row.toolkit as Record<string, unknown> | undefined)?.slug ?? row.toolkit_slug;
      return String(slug ?? '').toLowerCase() === name;
    }) as Record<string, unknown> | undefined;

    if (!found) return { name, status: 'disconnected' as const, scopes: SCOPES[name] };
    return {
      name,
      status: toStatus(found.status),
      account: typeof found.id === 'string' ? found.id : undefined,
      scopes: SCOPES[name],
    };
  });
}

/** The connected account id for a toolkit, or null when the user has not linked one. */
export async function activeConnectionId(env: Env, userId: string, toolkit: IntegrationName): Promise<string | null> {
  const [state] = await listConnections(env, userId, [toolkit]);
  return state && state.status === 'connected' ? (state.account ?? null) : null;
}

/**
 * Start OAuth. Composio hosts the sign-in page and keeps the tokens; the extension only
 * ever opens this URL in a tab.
 */
export async function createConnectLink(env: Env, userId: string, toolkit: IntegrationName): Promise<{ redirectUrl: string }> {
  if (!isLive(env)) return { redirectUrl: 'demo://connect/' + toolkit };
  const res = await call<{ redirect_url?: unknown }>(env, '/v3.1/connected_accounts/link', {
    method: 'POST',
    body: { toolkit_slug: toolkit, user_id: userId },
  });
  const url = typeof res.redirect_url === 'string' ? res.redirect_url : '';
  if (!/^https:\/\//.test(url)) throw new HttpError(502, 'The connected-apps service did not return a sign-in link.');
  return { redirectUrl: url };
}

// ── Tool execution ─────────────────────────────────────────────────────────

export interface ToolRun {
  data: unknown;
  logId?: string;
}

/**
 * Run one allowlisted tool. Callers must have validated `slug` and `args` through
 * tools.ts first — this does not re-derive whether the tool is safe to run.
 */
export async function executeTool(env: Env, opts: { spec: ToolSpec; userId: string; args: Record<string, unknown>; connectedAccountId?: string }): Promise<ToolRun> {
  if (!isLive(env)) {
    return { data: { simulated: true, tool: opts.spec.slug, arguments: opts.args, message: 'Simulated in demo mode — no external call was made.' } };
  }

  const res = await call<{ data?: unknown; error?: unknown; successful?: unknown; log_id?: unknown }>(
    env,
    '/v3/tools/execute/' + encodeURIComponent(opts.spec.slug),
    {
      method: 'POST',
      body: {
        user_id: opts.userId,
        arguments: opts.args,
        ...(opts.connectedAccountId ? { connected_account_id: opts.connectedAccountId } : {}),
      },
    },
  );

  // A 200 with successful:false is a provider-level failure, not a transport one.
  if (res.successful === false || (res.error != null && res.error !== '')) {
    console.log(JSON.stringify({ event: 'composio.tool_failed', tool: opts.spec.slug, error: String(res.error ?? '').slice(0, 300) }));
    throw new HttpError(502, `${opts.spec.label} did not complete. Check the connected account and try again.`);
  }
  return { data: res.data ?? null, logId: typeof res.log_id === 'string' ? res.log_id : undefined };
}
