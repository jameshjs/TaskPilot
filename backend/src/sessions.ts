import type { SyncedSession } from '../../shared/api';
import type { StoredPreview } from './workflow';

const MAX_SESSIONS = 200;

/**
 * One Durable Object per user id: the authoritative copy of their saved sessions.
 * Content is stored opaquely — the backend never needs to understand a session's shape.
 */
export class SessionStore {
  constructor(private state: DurableObjectState) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    switch (url.pathname) {
      case '/preview/put': {
        const stored = (await req.json()) as StoredPreview;
        if (!stored?.preview?.previewId) return new Response('previewId required', { status: 400 });
        await this.state.storage.put('p:' + stored.preview.previewId, stored);
        await this.sweepPreviews();
        return Response.json({ ok: true });
      }
      case '/preview/get': {
        const stored = await this.state.storage.get<StoredPreview>('p:' + url.searchParams.get('id'));
        return Response.json({ stored: stored ?? null });
      }
      case '/put': {
        const { session } = (await req.json()) as { session: SyncedSession };
        if (!session?.sessionId) return new Response('sessionId required', { status: 400 });
        await this.state.storage.put(`s:${session.sessionId}`, session);
        await this.evict();
        return Response.json({ ok: true });
      }
      case '/list': {
        const map = await this.state.storage.list<SyncedSession>({ prefix: 's:' });
        return Response.json({ sessions: [...map.values()] });
      }
      case '/delete': {
        const { sessionId } = (await req.json()) as { sessionId: string };
        await this.state.storage.delete(`s:${sessionId}`);
        return Response.json({ ok: true });
      }
      default:
        return new Response('Not found', { status: 404 });
    }
  }

  /**
   * Previews are short-lived by design, so drop the ones that can never be acted on
   * again. Without this they accumulate forever — the session cap below never saw them.
   */
  private async sweepPreviews(): Promise<void> {
    const map = await this.state.storage.list<StoredPreview>({ prefix: 'p:' });
    const now = Date.now();
    const dead = [...map.entries()]
      .filter(([, s]) => s.preview.status === 'executed' || s.preview.status === 'rejected' || now > Date.parse(s.preview.expiresAt))
      .map(([k]) => k);
    if (dead.length) await this.state.storage.delete(dead);
  }

  /** Keep storage bounded: drop the least recently active sessions past the cap. */
  private async evict(): Promise<void> {
    const map = await this.state.storage.list<SyncedSession>({ prefix: 's:' });
    if (map.size <= MAX_SESSIONS) return;
    const sorted = [...map.entries()].sort((a, b) => String(a[1].lastActiveAt ?? '').localeCompare(String(b[1].lastActiveAt ?? '')));
    await this.state.storage.delete(sorted.slice(0, map.size - MAX_SESSIONS).map(([k]) => k));
  }
}
