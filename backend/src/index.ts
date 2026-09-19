import * as agents from './agents';
import type { Env } from './env';
import { authorize, corsHeaders, HttpError, json, readJson } from './http';
import { SessionStore } from './sessions';
import { optStr, str as reqStr } from './validate';

export { SessionStore };

type Handler = (env: Env, body: Record<string, unknown>) => Promise<unknown>;

const ROUTES: Record<string, Handler> = {
  '/plan': agents.plan,
  '/tabs/organize': agents.organize,
  '/tabs/classify': agents.classify,
  '/navigate': agents.navigate,
  '/focus': agents.focus,
  '/suggest': agents.suggest,
  '/summary': agents.summary,
  '/what-was-i-doing': agents.whatWasIDoing,

  '/sync/put': async (env, body) => syncCall(env, body, '/put', { session: body.session }),
  '/sync/list': async (env, body) => syncCall(env, body, '/list', {}),
  '/sync/delete': async (env, body) => syncCall(env, body, '/delete', { sessionId: reqStr(body.sessionId, 'sessionId', 80) }),

  '/telemetry': async (_env, body) => {
    // Surfaced in Workers logs and, when a DSN is set, in Sentry via the wrapper below.
    console.warn('taskpilot.telemetry', JSON.stringify({ kind: optStr(body.kind, 40), message: optStr(body.message, 400), tags: body.tags }));
    return { ok: true };
  },
};

async function syncCall(env: Env, body: Record<string, unknown>, path: string, payload: unknown): Promise<unknown> {
  const userId = reqStr(body.userId, 'userId', 80);
  const stub = env.SESSIONS.get(env.SESSIONS.idFromName(userId));
  const res = await stub.fetch(`https://do${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new HttpError(502, `Session store error: ${await res.text()}`);
  return res.json();
}

const worker: ExportedHandler<Env> = {
  async fetch(req, env): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(env) });

    const path = new URL(req.url).pathname.replace(/\/+$/, '') || '/';
    if (path === '/' || path === '/health') return json({ ok: true, service: 'taskpilot' }, env);

    const handler = ROUTES[path];
    if (!handler) return json({ error: 'Not found' }, env, 404);
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, env, 405);

    const started = Date.now();
    try {
      authorize(req, env);
      const body = await readJson<Record<string, unknown>>(req);
      const data = await handler(env, body);
      console.log('taskpilot.request', JSON.stringify({ path, ms: Date.now() - started, ok: true }));
      return json(data, env);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      const message = e instanceof Error ? e.message : 'Unexpected error';
      console.error('taskpilot.error', JSON.stringify({ path, ms: Date.now() - started, status, message }));
      return json({ error: message }, env, status);
    }
  },
};

/**
 * Sentry wraps the Worker only when a DSN is configured, so the default deployment
 * sends nothing anywhere. It captures agent errors and LLM latency via the traces above.
 */
const handler: ExportedHandler<Env> = {
  async fetch(req, env, ctx) {
    if (!env.SENTRY_DSN) return worker.fetch!(req, env, ctx);
    const Sentry = await import('@sentry/cloudflare');
    const wrapped = Sentry.withSentry(
      (e: Env) => ({ dsn: e.SENTRY_DSN!, tracesSampleRate: 0.2, sendDefaultPii: false }),
      worker,
    );
    return wrapped.fetch!(req, env, ctx);
  },
};

export default handler;
