import type { WhatWasIDoing, GroupInfo, TabInfo, TaskSession } from './types';
import { currentStepTitle, progressLabel } from './sessionLogic';
import { formatAgo } from './tabLogic';
import { isWebUrl } from './urlutil';

/** Offline answer to "What was I doing?" built purely from local state. */
export function localWhatWasIDoing(
  tabs: TabInfo[],
  groups: GroupInfo[],
  sessions: TaskSession[],
  now = Date.now(),
): WhatWasIDoing {
  const projects: WhatWasIDoing['projects'] = [];
  const claimed = new Set<number>();

  for (const s of sessions.filter((x) => x.status === 'active' || x.status === 'saved')) {
    const live = s.groupId != null && s.groupId >= 0 ? tabs.filter((t) => t.groupId === s.groupId) : [];
    live.forEach((t) => claimed.add(t.id));
    const step = currentStepTitle(s);
    projects.push({
      name: s.title,
      tabCount: live.length || s.tabs.length,
      lastActiveAt: s.lastActiveAt,
      sessionId: s.sessionId,
      note: `${s.status === 'active' ? 'Active' : 'Saved'} · ${progressLabel(s)} steps${step ? ` · next: ${step}` : ''}`,
    });
  }

  for (const g of groups) {
    const members = tabs.filter((t) => t.groupId === g.id && !claimed.has(t.id));
    if (!g.title || members.length === 0) continue;
    const last = Math.max(...members.map((t) => t.lastAccessed ?? 0));
    projects.push({
      name: g.title,
      tabCount: members.length,
      lastActiveAt: last ? new Date(last).toISOString() : null,
      sessionId: null,
      note: 'Open tab group',
    });
    members.forEach((t) => claimed.add(t.id));
  }

  const loose = tabs.filter((t) => !claimed.has(t.id) && isWebUrl(t.url));
  if (loose.length) {
    const last = Math.max(...loose.map((t) => t.lastAccessed ?? 0));
    projects.push({ name: 'Ungrouped tabs', tabCount: loose.length, lastActiveAt: last ? new Date(last).toISOString() : null, sessionId: null, note: 'Not part of any task yet' });
  }

  projects.sort((a, b) => (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? ''));
  const named = projects.filter((p) => p.sessionId || p.name !== 'Ungrouped tabs');
  const narrative = named.length
    ? `You appear to have ${named.length} active project${named.length === 1 ? '' : 's'}: ${named.map((p) => `${p.name} (last worked on ${formatAgo(p.lastActiveAt, now)})`).join('; ')}.`
    : 'No organized projects yet — start a task or organize your tabs.';
  return { narrative, projects, source: 'offline' };
}
