import type { SyncedSession } from '../../shared/api';
import type { TaskSession } from '../shared/types';
import { callApi } from './api';
import { getSessions, getSettings, putSession } from './store';

/** Opt-in mirror of saved sessions to the backend Durable Object. Failures are silent by design. */
export async function pushSession(s: TaskSession): Promise<void> {
  const { syncEnabled, userId } = await getSettings();
  if (!syncEnabled) return;
  await callApi('/sync/put', { userId, session: stripLive(s) }).catch(() => undefined);
}

export async function deleteRemote(sessionId: string): Promise<void> {
  const { syncEnabled, userId } = await getSettings();
  if (!syncEnabled) return;
  await callApi('/sync/delete', { userId, sessionId }).catch(() => undefined);
}

/** Chrome tab/group ids are meaningless on another machine or after restart. */
function stripLive(s: TaskSession): TaskSession {
  return { ...s, groupId: undefined, windowId: undefined };
}

/** Two-way merge, newest lastActiveAt wins. Pulled sessions never steal the active slot. */
export async function syncNow(): Promise<{ pushed: number; pulled: number }> {
  const { userId } = await getSettings();
  const local = await getSessions();
  const remote = await callApi<{ sessions: SyncedSession[] }>('/sync/list', { userId });
  const remoteById = new Map(remote.sessions.map((r) => [r.sessionId, r]));
  let pushed = 0;
  let pulled = 0;

  for (const s of Object.values(local)) {
    const r = remoteById.get(s.sessionId);
    if (!r || r.lastActiveAt < s.lastActiveAt) {
      await callApi('/sync/put', { userId, session: stripLive(s) });
      pushed++;
    }
  }
  for (const r of remote.sessions) {
    const l = local[r.sessionId];
    if (!l || l.lastActiveAt < r.lastActiveAt) {
      const incoming = r as unknown as TaskSession;
      await putSession({ ...incoming, status: incoming.status === 'active' ? 'saved' : incoming.status, activeSince: undefined });
      pulled++;
    }
  }
  return { pushed, pulled };
}
