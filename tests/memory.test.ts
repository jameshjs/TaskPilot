import { describe, expect, it } from 'vitest';
import { localWhatWasIDoing } from '../src/shared/memory';
import { createSession } from '../src/shared/sessionLogic';
import type { TabInfo } from '../src/shared/types';

const NOW = Date.parse('2026-09-19T12:00:00Z');
const tab = (id: number, groupId: number, ago: number): TabInfo => ({ id, windowId: 1, title: `t${id}`, url: `https://x.com/${id}`, groupId, active: false, pinned: false, index: id, lastAccessed: NOW - ago });

describe('localWhatWasIDoing', () => {
  it('lists sessions and groups, most recent first, with ungrouped leftovers', () => {
    const s = createSession('Build TaskPilot', { title: 'TaskPilot', steps: [{ title: 'Implement Tab Agent', done: false }] }, new Date(NOW - 3600_000));
    s.groupId = 7;
    s.lastActiveAt = new Date(NOW - 15 * 60_000).toISOString();
    const old = createSession('Datadog Interview', { title: 'Datadog Interview', steps: [] }, new Date(NOW - 86400_000));
    old.status = 'saved';
    old.lastActiveAt = new Date(NOW - 26 * 3600_000).toISOString();
    old.tabs = new Array(7).fill({ url: 'https://d', title: 'd', category: 'x' });
    const tabs = [tab(1, 7, 1000), tab(2, 7, 2000), tab(3, 9, 5000), tab(4, -1, 9000)];
    const r = localWhatWasIDoing(tabs, [{ id: 9, windowId: 1, title: '💻 Coding', color: 'green', collapsed: false }], [s, old], NOW);
    // Ordered by most recent activity: the Coding group's tabs were touched seconds ago.
    expect(r.projects.map((p) => [p.name, p.tabCount])).toEqual([
      ['💻 Coding', 1],
      ['Ungrouped tabs', 1],
      ['TaskPilot', 2],
      ['Datadog Interview', 7],
    ]);
    expect(r.narrative).toMatch(/TaskPilot \(last worked on 15 minutes ago\)/);
    expect(r.narrative).toMatch(/Datadog Interview \(last worked on yesterday\)/);
  });
});
