import type { WhatWasIDoingRequest, WhatWasIDoingResponse } from '../../shared/api';
import { localWhatWasIDoing } from '../shared/memory';
import { currentStepTitle, progressLabel } from '../shared/sessionLogic';
import type { WhatWasIDoing } from '../shared/types';
import { isWebUrl, redactTitle, redactUrl } from '../shared/urlutil';
import { callApi } from './api';
import { listSessions } from './sessions';
import { getHistory } from './store';
import { snapshot, toTabMeta } from './tabs';

export async function whatWasIDoing(): Promise<WhatWasIDoing> {
  const [snap, sessions, history] = await Promise.all([snapshot(), listSessions(), getHistory()]);
  const local = () => localWhatWasIDoing(snap.tabs, snap.groups, sessions);

  const allowed = new Set((await toTabMeta(snap.tabs.filter((t) => isWebUrl(t.url)))).map((m) => m.id));
  const groupTitle = new Map(snap.groups.map((g) => [g.id, g.title]));
  const req: WhatWasIDoingRequest = {
    now: new Date().toISOString(),
    tabs: snap.tabs
      .filter((t) => allowed.has(t.id))
      .slice(0, 80)
      .map((t) => ({
        id: t.id,
        title: redactTitle(t.title, t.url),
        url: redactUrl(t.url),
        groupTitle: groupTitle.get(t.groupId) || undefined,
        lastAccessed: t.lastAccessed ? new Date(t.lastAccessed).toISOString() : undefined,
      })),
    sessions: sessions
      .filter((s) => s.status !== 'archived')
      .slice(0, 12)
      .map((s) => ({
        id: s.sessionId,
        task: s.task,
        status: s.status,
        progress: progressLabel(s),
        tabCount: s.tabs.length,
        lastActiveAt: s.lastActiveAt,
        currentStep: currentStepTitle(s),
      })),
    history: history.slice(-40).map((h) => ({ at: h.at, text: h.text })),
  };

  try {
    const res = await callApi<WhatWasIDoingResponse>('/what-was-i-doing', req);
    return { ...res, source: 'ai' };
  } catch {
    return local();
  }
}
