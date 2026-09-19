import { GROUP_COLORS, type ClassifyResponse, type GroupColor, type OrganizeResponse, type SuggestedGroup, type TabMeta } from '../../shared/api';
import { sessionGroupTitle } from '../shared/sessionLogic';
import { buildCleanupReport, colorFor, groupTitle, heuristicGroups, isManageable } from '../shared/tabLogic';
import type { CleanupReport, GroupInfo, OrganizePreview, TabClassification, TabInfo, TabsSnapshot } from '../shared/types';
import { hostOf, matchesHost, redactTitle, redactUrl } from '../shared/urlutil';
import { ApiError, callApi } from './api';
import { getActiveSession, getSettings, logEvent, updateActiveSession } from './store';

// ── Reading ────────────────────────────────────────────────────────────────

function toTabInfo(t: chrome.tabs.Tab): TabInfo | null {
  if (t.id == null) return null;
  return {
    id: t.id,
    windowId: t.windowId,
    title: t.title || t.url || 'Untitled',
    url: t.url || t.pendingUrl || '',
    favIconUrl: t.favIconUrl,
    groupId: t.groupId ?? -1,
    active: t.active,
    pinned: t.pinned,
    lastAccessed: (t as chrome.tabs.Tab & { lastAccessed?: number }).lastAccessed,
    index: t.index,
  };
}

export async function snapshot(): Promise<TabsSnapshot> {
  const [tabs, groups, win] = await Promise.all([
    chrome.tabs.query({}),
    chrome.tabGroups.query({}),
    chrome.windows.getLastFocused().catch(() => null),
  ]);
  return {
    tabs: tabs.map(toTabInfo).filter((t): t is TabInfo => t !== null),
    groups: groups.map(
      (g): GroupInfo => ({ id: g.id, windowId: g.windowId, title: g.title ?? '', color: g.color as GroupColor, collapsed: g.collapsed }),
    ),
    currentWindowId: win?.id ?? null,
  };
}

// ── Grouping ───────────────────────────────────────────────────────────────

function asColor(c: string | undefined, fallbackName: string): GroupColor {
  return (GROUP_COLORS as readonly string[]).includes(c ?? '') ? (c as GroupColor) : colorFor(fallbackName);
}

/**
 * Put tabs into a single Chrome tab group, reusing an existing group with the same
 * title in the target window. Pinned tabs cannot be grouped and are skipped.
 */
export async function groupTabs(tabIds: number[], title: string, color?: string): Promise<{ groupId: number; skipped: number }> {
  const tabs = (await Promise.all(tabIds.map((id) => chrome.tabs.get(id).catch(() => null)))).filter(
    (t): t is chrome.tabs.Tab => !!t && t.id != null,
  );
  const usable = tabs.filter((t) => !t.pinned);
  const skipped = tabIds.length - usable.length;
  if (usable.length === 0) throw new Error('None of those tabs can be grouped (pinned or closed).');

  // A group lives in one window: pick the window holding most of the tabs.
  const counts = new Map<number, number>();
  for (const t of usable) counts.set(t.windowId, (counts.get(t.windowId) ?? 0) + 1);
  const windowId = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];

  const ids = usable.map((t) => t.id!) ;
  const foreign = usable.filter((t) => t.windowId !== windowId).map((t) => t.id!);
  if (foreign.length) await chrome.tabs.move(foreign, { windowId, index: -1 });

  const existing = (await chrome.tabGroups.query({ windowId })).find((g) => g.title === title);
  const groupId = existing
    ? await chrome.tabs.group({ tabIds: ids, groupId: existing.id })
    : await chrome.tabs.group({ tabIds: ids, createProperties: { windowId } });
  await chrome.tabGroups.update(groupId, { title, ...(existing ? {} : { color: asColor(color, title) }) });
  return { groupId, skipped };
}

export async function renameGroup(groupId: number, title: string, color?: string): Promise<void> {
  await chrome.tabGroups.update(groupId, { title, ...(color ? { color: asColor(color, title) } : {}) });
}

export async function ungroup(tabIds: number[]): Promise<void> {
  await chrome.tabs.ungroup(tabIds as [number, ...number[]]);
}

/** Close tabs. If that would empty a window, open a fresh tab first so the window survives. */
export async function closeTabs(tabIds: number[]): Promise<number> {
  if (!tabIds.length) return 0;
  const all = await chrome.tabs.query({});
  const closing = new Set(tabIds);
  const byWindow = new Map<number, { total: number; closing: number }>();
  for (const t of all) {
    const w = byWindow.get(t.windowId) ?? { total: 0, closing: 0 };
    w.total++;
    if (t.id != null && closing.has(t.id)) w.closing++;
    byWindow.set(t.windowId, w);
  }
  for (const [windowId, w] of byWindow) {
    if (w.closing > 0 && w.closing === w.total) await chrome.tabs.create({ windowId, active: true });
  }
  await chrome.tabs.remove(tabIds);
  return tabIds.length;
}

// ── Tab Agent (AI) ─────────────────────────────────────────────────────────

/** Tab metadata safe to send to a model: no query strings, mail subjects hidden, excluded hosts dropped. */
export async function toTabMeta(tabs: TabInfo[]): Promise<TabMeta[]> {
  const { excludedHosts } = await getSettings();
  return tabs
    .filter((t) => isManageable(t) && !matchesHost(hostOf(t.url), excludedHosts))
    .map((t) => ({ id: t.id, title: redactTitle(t.title, t.url), url: redactUrl(t.url) }));
}

async function candidateTabs(): Promise<TabInfo[]> {
  const snap = await snapshot();
  return snap.tabs.filter((t) => isManageable(t) && !t.pinned);
}

export async function organizePreview(): Promise<OrganizePreview> {
  const tabs = await candidateTabs();
  if (tabs.length === 0) return { groups: [], source: 'offline', error: 'No groupable tabs.' };
  const session = await getActiveSession();
  const metas = await toTabMeta(tabs);
  const excluded = new Set(tabs.map((t) => t.id).filter((id) => !metas.some((m) => m.id === id)));
  try {
    const res = await callApi<OrganizeResponse>('/tabs/organize', { activeTask: session?.task, tabs: metas });
    return { groups: reconcileGroups(res.groups, tabs, excluded), source: 'ai' };
  } catch (e) {
    return {
      groups: heuristicGroups(tabs.filter((t) => !excluded.has(t.id))),
      source: 'offline',
      error: e instanceof ApiError ? e.message : String(e),
    };
  }
}

/**
 * Trust nothing from the model: keep only real tab ids, place each tab in at most one group,
 * and put anything the model forgot into "Other".
 */
export function reconcileGroups(groups: SuggestedGroup[], tabs: Pick<TabInfo, 'id'>[], excluded: Set<number> = new Set()): SuggestedGroup[] {
  const valid = new Set(tabs.map((t) => t.id).filter((id) => !excluded.has(id)));
  const seen = new Set<number>();
  const out: SuggestedGroup[] = [];
  for (const g of groups) {
    const ids = g.tabIds.filter((id) => valid.has(id) && !seen.has(id));
    ids.forEach((id) => seen.add(id));
    if (ids.length) out.push({ ...g, name: g.name.trim().slice(0, 40) || 'Group', tabIds: ids, color: asColor(g.color, g.name) });
  }
  const missing = [...valid].filter((id) => !seen.has(id));
  if (missing.length) {
    const other = out.find((g) => g.name === 'Other');
    if (other) other.tabIds.push(...missing);
    else out.push({ name: 'Other', emoji: '📦', color: 'grey', tabIds: missing });
  }
  return out;
}

export async function organizeApply(groups: SuggestedGroup[]): Promise<{ created: number; skipped: number }> {
  let created = 0;
  let skipped = 0;
  const session = await getActiveSession();
  for (const g of groups) {
    if (!g.tabIds.length) continue;
    // The group the model marked as the active task IS the session's workspace group.
    const isWorkspace = !!session && !!g.isActiveTask;
    const r = await groupTabs(g.tabIds, isWorkspace ? sessionGroupTitle(session) : groupTitle(g), isWorkspace ? session.color : g.color);
    if (isWorkspace) await updateActiveSession((s) => { s.groupId = r.groupId; });
    created++;
    skipped += r.skipped;
  }
  await logEvent('tabs_organized', `Organized tabs into ${created} group${created === 1 ? '' : 's'}`, session?.sessionId);
  return { created, skipped };
}

export async function classifyTabs(task?: string): Promise<{ labels: Record<number, TabClassification>; source: 'ai' | 'offline' }> {
  const activeTask = task ?? (await getActiveSession())?.task;
  if (!activeTask) return { labels: {}, source: 'offline' };
  const tabs = await candidateTabs();
  const metas = await toTabMeta(tabs);
  try {
    const res = await callApi<ClassifyResponse>('/tabs/classify', { activeTask, tabs: metas });
    const labels: Record<number, TabClassification> = {};
    const valid = new Set(metas.map((m) => m.id));
    for (const r of res.tabs) if (valid.has(r.id)) labels[r.id] = { label: r.label, reason: r.reason };
    return { labels, source: 'ai' };
  } catch {
    return { labels: {}, source: 'offline' };
  }
}

export async function cleanupAnalyze(): Promise<CleanupReport> {
  const snap = await snapshot();
  const { labels, source } = await classifyTabs();
  const hasLabels = source === 'ai';
  return buildCleanupReport(snap.tabs, hasLabels ? labels : null, Date.now(), source);
}

/** Tab ids in the active task's workspace (its live Chrome group), if any. */
export async function taskTabIds(groupId: number | undefined): Promise<number[]> {
  if (groupId == null || groupId < 0) return [];
  const tabs = await chrome.tabs.query({ groupId }).catch(() => []);
  return tabs.map((t) => t.id).filter((id): id is number => id != null);
}
