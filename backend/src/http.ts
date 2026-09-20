import type { Env } from './env';

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function corsHeaders(env: Env): Record<string, string> {
  return {
    'access-control-allow-origin': env.ALLOWED_ORIGIN || '*',
    'access-control-allow-headers': 'content-type,authorization',
    'access-control-allow-methods': 'POST,OPTIONS',
    'access-control-max-age': '86400',
  };
}

export function json(data: unknown, env: Env, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders(env) },
  });
}

/** Constant-time compare so a wrong token can't be discovered a byte at a time. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function authorize(req: Request, env: Env): void {
  if (!env.TASKPILOT_TOKEN) return;
  const header = req.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!safeEqual(token, env.TASKPILOT_TOKEN)) throw new HttpError(401, 'Unauthorized');
}

export async function readJson<T>(req: Request): Promise<T> {
  const ct = req.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) throw new HttpError(415, 'Expected application/json');
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}
