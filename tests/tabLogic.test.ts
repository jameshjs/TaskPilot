import { describe, expect, it } from 'vitest';
import { buildCleanupReport, findDuplicateSets, heuristicGroups, formatAgo, formatDuration } from '../src/shared/tabLogic';
import { normalizeUrl, redactTitle, redactUrl, matchesHost } from '../src/shared/urlutil';
import type { TabInfo } from '../src/shared/types';

const NOW = Date.parse('2026-09-19T12:00:00Z');
const H = 3600_000;

function tab(id: number, url: string, over: Partial<TabInfo> = {}): TabInfo {
  return { id, windowId: 1, title: `t${id}`, url, groupId: -1, active: false, pinned: false, index: id, lastAccessed: NOW - H, ...over };
}

describe('urlutil', () => {
  it('normalizes tracking params, www, hash and trailing slash', () => {
    expect(normalizeUrl('https://www.Stripe.com/jobs/?utm_source=x&b=2&a=1#top')).toBe('https://stripe.com/jobs?a=1&b=2');
  });
  it('redacts query/hash before sending to a model', () => {
    expect(redactUrl('https://x.com/reset?token=SECRET#frag')).toBe('https://x.com/reset');
  });
  it('hides mail subjects', () => {
    expect(redactTitle('Your offer letter - me@x.com', 'https://mail.google.com/mail/u/0/#inbox')).toBe('Gmail');
    expect(redactTitle('Docs', 'https://example.com')).toBe('Docs');
  });
  it('matches excluded hosts incl. subdomains', () => {
    expect(matchesHost('app.bank.com', ['bank.com'])).toBe(true);
    expect(matchesHost('notbank.com', ['bank.com'])).toBe(false);
  });
});

describe('duplicates', () => {
  it('finds the spec example: two identical Stripe SWE tabs', () => {
    const tabs = [
      tab(1, 'https://stripe.com/careers'),
      tab(2, 'https://stripe.com/jobs/swe', { lastAccessed: NOW - 5 * H }),
      tab(3, 'https://www.stripe.com/jobs/swe/?utm_campaign=z', { lastAccessed: NOW - H }),
      tab(4, 'https://stripe.com/jobs'),
    ];
    const sets = findDuplicateSets(tabs);
    expect(sets).toHaveLength(1);
    expect(sets[0]!.tabIds).toEqual([3, 2]); // newest first → keeper is index 0
  });
  it('never treats the active tab as a removable extra', () => {
    const sets = findDuplicateSets([tab(1, 'https://a.com/x', { lastAccessed: NOW }), tab(2, 'https://a.com/x', { active: true, lastAccessed: NOW - 9 * H })]);
    expect(sets[0]!.tabIds[0]).toBe(2);
  });
  it('ignores pinned and internal pages', () => {
    expect(findDuplicateSets([tab(1, 'chrome://newtab/'), tab(2, 'chrome://newtab/'), tab(3, 'https://a.com', { pinned: true }), tab(4, 'https://a.com', { pinned: true })])).toEqual([]);
  });
});

describe('cleanup report', () => {
  it('puts every tab in exactly one bucket', () => {
    const tabs = [
      tab(1, 'https://a.com/1', { active: true }),
      tab(2, 'https://a.com/2'),
      tab(3, 'https://b.com/x'),
      tab(4, 'https://b.com/x'),
      tab(5, 'https://c.com/old', { lastAccessed: NOW - 10 * 24 * H }),
      tab(6, 'https://d.com/recent-other'),
      tab(7, 'chrome://extensions/'),
    ];
    const labels = {
      1: { label: 'CURRENT_TASK' as const, reason: '' },
      2: { label: 'POSSIBLY_RELATED' as const, reason: '' },
      3: { label: 'OTHER_TASK' as const, reason: '' },
      4: { label: 'OTHER_TASK' as const, reason: '' },
      5: { label: 'OTHER_TASK' as const, reason: '' },
      6: { label: 'DISTRACTION' as const, reason: '' },
    };
    const r = buildCleanupReport(tabs, labels, NOW, 'ai');
    const all = [...r.related, ...r.inactive, ...r.duplicates, ...r.stale];
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBe(r.total);
    expect(r.total).toBe(6); // chrome:// excluded
    expect(r.related.sort()).toEqual([1, 2]);
    expect(r.duplicates).toHaveLength(1);
    expect(r.stale.sort()).toEqual([5, 6]);
  });
  it('falls back to recency when there is no active task', () => {
    const r = buildCleanupReport([tab(1, 'https://a.com', { lastAccessed: NOW - H }), tab(2, 'https://b.com', { lastAccessed: NOW - 2 * 24 * H })], null, NOW, 'offline');
    expect(r.related).toEqual([1]);
    expect(r.inactive).toEqual([2]);
  });
});

describe('heuristic grouping', () => {
  it('groups by category and falls back to Other', () => {
    const g = heuristicGroups([
      { id: 1, url: 'https://github.com/x/y' },
      { id: 2, url: 'https://stackoverflow.com/q/1' },
      { id: 3, url: 'https://boards.greenhouse.io/datadog' },
      { id: 4, url: 'https://random-site.org' },
    ]);
    expect(g.find((x) => x.name === 'Coding')!.tabIds).toEqual([1, 2]);
    expect(g.find((x) => x.name === 'Job Applications')!.tabIds).toEqual([3]);
    expect(g.find((x) => x.name === 'Other')!.tabIds).toEqual([4]);
  });
});

describe('formatting', () => {
  it('formats relative times and durations', () => {
    expect(formatAgo(new Date(NOW - 15 * 60_000).toISOString(), NOW)).toBe('15 minutes ago');
    expect(formatAgo(new Date(NOW - 26 * H).toISOString(), NOW)).toBe('yesterday');
    expect(formatDuration(136 * 60_000)).toBe('2h 16m');
  });
});
