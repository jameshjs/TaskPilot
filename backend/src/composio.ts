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

  // `user_ids`, plural. The singular `user_id` is accepted and then silently ignored:
  // it returns every account in the project, so a nonexistent user still came back with
  // six. Relying on it meant handing one user's connected_account_id to another user's
  // tool call. The per-row check below is the belt to that braces — a filter this API
  // has already been seen to drop is not something to trust on its own.
  const res = await call<{ items?: unknown[] }>(env, `/v3.1/connected_accounts?user_ids=${encodeURIComponent(userId)}`, { method: 'GET' });
  const items = (Array.isArray(res.items) ? res.items : []).filter((i) => {
    const row = (i ?? {}) as Record<string, unknown>;
    const owner = row.user_id ?? (row.user as Record<string, unknown> | undefined)?.id;
    if (String(owner ?? '') === userId) return true;
    console.log(JSON.stringify({ event: 'composio.foreign_account_filtered', toolkit: (row.toolkit as Record<string, unknown> | undefined)?.slug ?? row.toolkit_slug }));
    return false;
  });

  return toolkits.map((name) => {
    const forToolkit = items.filter((i) => {
      const row = i as Record<string, unknown>;
      const slug = (row.toolkit as Record<string, unknown> | undefined)?.slug ?? row.toolkit_slug;
      return String(slug ?? '').toLowerCase() === name;
    }) as Record<string, unknown>[];

    // Reconnecting leaves the old rows behind as EXPIRED, so a toolkit can have several.
    // Prefer an ACTIVE one; picking whichever the API happened to list first would report
    // a working account as disconnected.
    const found = forToolkit.find((row) => String(row.status ?? '').toUpperCase() === 'ACTIVE') ?? forToolkit[0];

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
 * Auth configs are per-project and per-toolkit, and the link endpoint addresses one by
 * id — a toolkit slug alone is not enough (Composio answers `auth_config_id: Required`).
 * They change about never, so resolve once per isolate rather than on every connect.
 */
const authConfigIds = new Map<IntegrationName, string>();

/** Test-only: the cache is per-isolate, so tests need to clear it between cases. */
export function resetAuthConfigCache(): void {
  authConfigIds.clear();
}

/**
 * The enabled auth config for a toolkit.
 *
 * A missing one is an operator gap, not a user error: nobody can sign in until the
 * project has a config for that app. Say so explicitly instead of surfacing Composio's
 * generic validation failure as a 502.
 */
async function authConfigId(env: Env, toolkit: IntegrationName): Promise<string> {
  const cached = authConfigIds.get(toolkit);
  if (cached) return cached;

  const res = await call<{ items?: unknown[] }>(env, `/v3/auth_configs?toolkit_slugs=${encodeURIComponent(toolkit)}`, { method: 'GET' });
  const items = Array.isArray(res.items) ? res.items : [];
  const found = items.find((i) => {
    const row = (i ?? {}) as Record<string, unknown>;
    const slug = (row.toolkit as Record<string, unknown> | undefined)?.slug ?? row.toolkit_slug;
    // `toolkit_slugs` is a filter, not a guarantee — confirm the row before trusting it.
    return String(slug ?? '').toLowerCase() === toolkit && String(row.status ?? '').toUpperCase() === 'ENABLED';
  }) as Record<string, unknown> | undefined;

  if (typeof found?.id !== 'string' || !found.id) {
    console.log(JSON.stringify({ event: 'composio.no_auth_config', toolkit, candidates: items.length }));
    throw new HttpError(409, `${toolkit} sign-in is not configured yet, so TaskPilot cannot connect it.`);
  }
  authConfigIds.set(toolkit, found.id);
  return found.id;
}

/**
 * Start OAuth. Composio hosts the sign-in page and keeps the tokens; the extension only
 * ever opens this URL in a tab.
 */
export async function createConnectLink(env: Env, userId: string, toolkit: IntegrationName): Promise<{ redirectUrl: string }> {
  if (!isLive(env)) return { redirectUrl: 'demo://connect/' + toolkit };
  const res = await call<{ redirect_url?: unknown }>(env, '/v3.1/connected_accounts/link', {
    method: 'POST',
    body: { auth_config_id: await authConfigId(env, toolkit), user_id: userId },
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
 * The one line of a provider complaint worth showing, with identifiers stripped.
 *
 * Provider payloads are still never returned wholesale — see `call` above. But refusing
 * to say anything at all is its own failure: "check the connected account" sent a user
 * re-authorising a perfectly good account when the real problem was a missing argument.
 */
function providerReason(raw: string): string {
  const inner = /"message"\s*:\s*"([^"]{3,200})"/.exec(raw)?.[1] ?? raw.split('\n')[0] ?? '';
  return inner
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[address]') // account identifiers
    .replace(/\b(gh[pousr]|sk|ey|ac|ca)_[A-Za-z0-9_-]{8,}/g, '[id]') // tokens and record ids
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

/**
 * Whose fault the failure was.
 *
 * Everything used to collapse into a 502, which made an unusable error: the client can
 * retry a 502 forever and a bad argument will never fix itself. Arguments the provider
 * refused are the caller's to correct (400); a revoked grant needs a reconnect (409);
 * only an actually broken provider is a 502.
 */
function toolFailure(spec: ToolSpec, raw: string): HttpError {
  const reason = providerReason(raw);
  const status = /status:\s*(\d{3})/i.exec(raw)?.[1];

  if (status === '401' || status === '403' || /invalid_grant|token (has been )?(expired|revoked)|unauthorized/i.test(raw)) {
    return new HttpError(409, `Your ${spec.toolkit} connection needs to be renewed. Reconnect the account and try again.`);
  }
  // Providers are inconsistent about whether a status code appears at all — GitHub sends
  // a bare "Not Found" for a repo that does not exist. That is still the caller's typo.
  if (status === '400' || status === '404' || status === '422' || /fields are missing|invalid request data|invalid value|required|not found|does not exist/i.test(raw)) {
    return new HttpError(400, `${spec.label} was refused: ${reason || 'the arguments were not accepted.'}`);
  }
  if (status === '429' || /rate limit/i.test(raw)) {
    return new HttpError(429, `${spec.toolkit} is rate limiting. Try again shortly.`);
  }
  return new HttpError(502, `${spec.label} did not complete. ${reason || 'The app did not say why.'}`);
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
    const raw = String(res.error ?? '');
    console.log(JSON.stringify({ event: 'composio.tool_failed', tool: opts.spec.slug, error: raw.slice(0, 300) }));
    throw toolFailure(opts.spec, raw);
  }
  return { data: res.data ?? null, logId: typeof res.log_id === 'string' ? res.log_id : undefined };
}
