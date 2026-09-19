import { GROUP_COLORS, type GroupColor, type SuggestedGroup, type TabLabel } from '../../shared/api';
import type { CleanupReport, DuplicateSet, TabClassification, TabInfo } from './types';
import { hostOf, isWebUrl, normalizeUrl } from './urlutil';

export const STALE_AFTER_MS = 3 * 24 * 60 * 60 * 1000;
export const RECENT_MS = 24 * 60 * 60 * 1000;

export function groupTitle(g: { emoji?: string; name: string }): string {
  return `${g.emoji ? `${g.emoji} ` : ''}${g.name}`.trim();
}

export function colorFor(name: string): GroupColor {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return GROUP_COLORS[h % GROUP_COLORS.length]!;
}

/** Tabs we never touch: browser-internal pages and the extension's own pages. */
export function isManageable(tab: Pick<TabInfo, 'url'>): boolean {
  return isWebUrl(tab.url);
}

// ── Offline grouping (Phase 2 fallback; also used when the backend is unreachable) ──

interface Category {
  name: string;
  emoji: string;
  color: GroupColor;
  hosts: RegExp;
}

const CATEGORIES: Category[] = [
  { name: 'Job Applications', emoji: '💼', color: 'blue', hosts: /(linkedin|greenhouse|lever\.co|workday|myworkdayjobs|ashbyhq|indeed|glassdoor|wellfound|handshake|careers|jobs\.)/ },
  { name: 'Coding', emoji: '💻', color: 'green', hosts: /(github|gitlab|stackoverflow|stackexchange|developer\.mozilla|developer\.chrome|npmjs|pypi|docs\.python|leetcode|codesandbox|replit|vercel|cloudflare|openai|anthropic)/ },
  { name: 'Study', emoji: '📚', color: 'purple', hosts: /(coursera|edx|khanacademy|quizlet|brightspace|canvas|learn\.uwaterloo|wikipedia|arxiv|scholar\.google)/ },
  { name: 'Personal', emoji: '🎬', color: 'pink', hosts: /(youtube|netflix|twitch|reddit|twitter|x\.com|instagram|facebook|tiktok|espn|nba\.com)/ },
  { name: 'Other', emoji: '📦', color: 'grey', hosts: /(mail\.google|outlook|calendar\.google|docs\.google|sheets\.google|drive\.google|notion|slack)/ },
];

export function heuristicGroups(tabs: Pick<TabInfo, 'id' | 'url'>[]): SuggestedGroup[] {
  const buckets = new Map<string, SuggestedGroup>();
  for (const t of tabs) {
    const host = hostOf(t.url);
    const cat = CATEGORIES.find((c) => c.hosts.test(host));
    const name = cat?.name ?? 'Other';
    const existing = buckets.get(name);
    if (existing) existing.tabIds.push(t.id);
    else
      buckets.set(name, {
        name,
        emoji: cat?.emoji ?? '📦',
        color: cat?.color ?? 'grey',
        tabIds: [t.id],
      });
  }
  return [...buckets.values()].sort((a, b) => b.tabIds.length - a.tabIds.length);
}

// ── Duplicates ─────────────────────────────────────────────────────────────

function recency(t: TabInfo): number {
  return t.lastAccessed ?? t.id;
}

/** Sets of tabs pointing at the same normalized URL, each ordered newest → oldest. */
export function findDuplicateSets(tabs: TabInfo[]): DuplicateSet[] {
  const byKey = new Map<string, TabInfo[]>();
  for (const t of tabs) {
    if (!isManageable(t) || t.pinned) continue;
    const key = normalizeUrl(t.url);
    const list = byKey.get(key);
    if (list) list.push(t);
    else byKey.set(key, [t]);
  }
  const sets: DuplicateSet[] = [];
  for (const [key, list] of byKey) {
    if (list.length < 2) continue;
    list.sort((a, b) => Number(b.active) - Number(a.active) || recency(b) - recency(a));
    sets.push({ key, title: list[0]!.title, tabIds: list.map((t) => t.id) });
  }
  return sets;
}

// ── Cleanup ────────────────────────────────────────────────────────────────

/**
 * Buckets every manageable tab exactly once, in priority order:
 * duplicates (extras) → related to active work → stale → useful-but-inactive.
 * `labels` comes from the Tab Agent when there is an active task; without it,
 * recency stands in for "active".
 */
export function buildCleanupReport(
  tabs: TabInfo[],
  labels: Record<number, TabClassification> | null,
  now: number,
  source: 'ai' | 'offline',
): CleanupReport {
  const manageable = tabs.filter((t) => isManageable(t) && !t.pinned);
  const duplicateSets = findDuplicateSets(manageable);
  const dupExtras = new Set(duplicateSets.flatMap((s) => s.tabIds.slice(1)));

  const related: number[] = [];
  const inactive: number[] = [];
  const stale: number[] = [];

  for (const t of manageable) {
    if (dupExtras.has(t.id)) continue;
    const last = t.lastAccessed ?? now;
    const age = now - last;
    const label: TabLabel | undefined = labels?.[t.id]?.label;
    const isRelated = labels
      ? label === 'CURRENT_TASK' || label === 'POSSIBLY_RELATED'
      : t.active || age < RECENT_MS;
    if (t.active || isRelated) related.push(t.id);
    else if (age > STALE_AFTER_MS || label === 'DISTRACTION') stale.push(t.id);
    else inactive.push(t.id);
  }

  return {
    total: manageable.length,
    related,
    inactive,
    duplicates: [...dupExtras],
    stale,
    duplicateSets,
    source,
  };
}

export function formatAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const ms = now - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return 'yesterday';
  return `${d} days ago`;
}

export function formatDuration(ms: number): string {
  const totalMin = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}
