import type { PlanResponse, SummaryRequest, SummaryResponse } from '../../shared/api';
import {
  activeMsNow,
  buildLocalSummary,
  createSession,
  currentStepTitle,
  fallbackPlan,
  historyForSession,
  mergeReplan,
  pauseClock,
  sessionGroupTitle,
  syncStepPointers,
} from '../shared/sessionLogic';
import { isManageable } from '../shared/tabLogic';
import type { ResumeInfo, SavedTab, SessionSummary, TabInfo, TaskSession } from '../shared/types';
import { isWebUrl, normalizeUrl } from '../shared/urlutil';
import { callApi } from './api';
import { classifyTabs, closeTabs, groupTabs, snapshot } from './tabs';
import {
  getActiveSession,
  getHistory,
  getSessions,
  logEvent,
  putSession,
  removeSession,
  setActiveSessionId,
  setFocus,
  updateActiveSession,
} from './store';
import { deleteRemote, pushSession } from './sync';

async function persist(s: TaskSession): Promise<void> {
  await putSession(s);
  void pushSession(s);
}

// ── Planning ───────────────────────────────────────────────────────────────

async function plan(task: string): Promise<PlanResponse> {
  try {
    return await callApi<PlanResponse>('/plan', { goal: task });
  } catch {
    return fallbackPlan(task);
  }
}

// ── Workspace ↔ session ────────────────────────────────────────────────────

/** Live tabs in this session's Chrome group. Empty if the group no longer exists. */
async function liveGroupTabs(s: TaskSession): Promise<TabInfo[]> {
  if (s.groupId == null || s.groupId < 0) return [];
  const snap = await snapshot();
  return snap.tabs.filter((t) => t.groupId === s.groupId);
}

function toSavedTab(t: TabInfo, s: TaskSession, groupColor: TaskSession['color']): SavedTab {
  return {
    url: t.url,
    title: t.title,
    category: s.title,
    groupTitle: sessionGroupTitle(s),
    groupColor,
    favIconUrl: t.favIconUrl,
  };
}

/** Refresh session.tabs from the live group. Keeps the previous snapshot if the group is gone. */
async function snapshotTabs(s: TaskSession): Promise<void> {
  const live = (await liveGroupTabs(s)).filter(isManageable);
  if (live.length === 0) return;
  s.tabs = live.map((t) => toSavedTab(t, s, s.color));
  const mostRecent = [...live].sort((a, b) => Number(b.active) - Number(a.active) || (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
  if (mostRecent) s.lastActiveUrl = mostRecent.url;
}

/** Add tabs to the active session's workspace group, creating the group on first use. */
export async function addTabsToWorkspace(tabIds: number[]): Promise<TaskSession> {
  const s = await getActiveSession();
  if (!s) throw new Error('No active task.');
  const { groupId } = await groupTabs(tabIds, sessionGroupTitle(s), s.color);
  return updateActiveSession((x) => {
    x.groupId = groupId;
  });
}

// ── Lifecycle ──────────────────────────────────────────────────────────────

export async function startSession(task: string): Promise<TaskSession> {
  const trimmed = task.trim();
  if (!trimmed) throw new Error('Describe what you want to get done.');

  const current = await getActiveSession();
  if (current) await deactivate(current, { closeTabs: false });

  // Planning and tab classification are independent: run them together.
  const [planned, classified] = await Promise.all([plan(trimmed), classifyTabs(trimmed)]);
  const session = createSession(trimmed, planned);
  await persist(session);
  await setActiveSessionId(session.sessionId);
  await setFocus({ status: 'idle' });

  const relevant = Object.entries(classified.labels)
    .filter(([, c]) => c.label === 'CURRENT_TASK')
    .map(([id]) => Number(id));
  if (relevant.length) {
    try {
      await addTabsToWorkspace(relevant);
    } catch {
      /* pinned/closed tabs: the workspace group is created lazily on the next relevant tab */
    }
  }
  await logEvent('session_started', `Started "${session.title}"`, session.sessionId);
  return (await getActiveSession()) ?? session;
}

async function deactivate(s: TaskSession, opts: { closeTabs: boolean }): Promise<void> {
  await snapshotTabs(s);
  pauseClock(s);
  s.status = 'saved';
  s.paused = false;
  const liveIds = opts.closeTabs ? (await liveGroupTabs(s)).map((t) => t.id) : [];
  s.groupId = undefined;
  s.windowId = undefined;
  s.lastActiveAt = new Date().toISOString();
  await persist(s);
  await setActiveSessionId(null);
  await setFocus({ status: 'idle' });
  if (liveIds.length) await closeTabs(liveIds);
}

/** Snapshot the workspace. With closeTabs the session is parked; otherwise it stays active. */
export async function saveSession(closeTabsToo: boolean): Promise<TaskSession> {
  const s = await getActiveSession();
  if (!s) throw new Error('No active task to save.');
  if (closeTabsToo) {
    await deactivate(s, { closeTabs: true });
    await logEvent('session_saved', `Saved "${s.title}" (${s.tabs.length} tabs) and closed its tabs`, s.sessionId);
  } else {
    const saved = await updateActiveSession((x) => {
      x.lastActiveAt = new Date().toISOString();
    });
    await snapshotTabs(saved);
    await persist(saved);
    await logEvent('session_saved', `Saved "${saved.title}" (${saved.tabs.length} tabs)`, saved.sessionId);
    void refreshHint(saved.sessionId);
    return saved;
  }
  void refreshHint(s.sessionId);
  return (await getSessions())[s.sessionId] ?? s;
}

export async function finishSession(closeTabsToo: boolean): Promise<{ session: TaskSession; summary: SessionSummary }> {
  const s = await getActiveSession();
  if (!s) throw new Error('No active task to finish.');
  await snapshotTabs(s);
  pauseClock(s);
  const history = historyForSession(await getHistory(), s.sessionId);
  const local = buildLocalSummary(s);
  let summary = local;
  try {
    const ai = await callApi<SummaryResponse>('/summary', summaryRequest(s, history));
    summary = {
      ...local,
      completed: ai.completed.length ? ai.completed : local.completed,
      importantTabs: ai.importantTabs.length ? ai.importantTabs : local.importantTabs,
      continueWith: ai.continueWith || local.continueWith,
    };
    s.nextStepHint = ai.nextStepHint || s.nextStepHint;
  } catch {
    /* the local summary is built from real state and is good enough */
  }
  s.status = 'finished';
  s.summary = summary;
  s.endedAt = new Date().toISOString();
  s.lastActiveAt = s.endedAt;
  const ids = closeTabsToo ? (await liveGroupTabs(s)).map((t) => t.id) : [];
  s.groupId = undefined;
  await persist(s);
  await setActiveSessionId(null);
  await setFocus({ status: 'idle' });
  if (ids.length) await closeTabs(ids);
  await logEvent('session_finished', `Finished "${s.title}"`, s.sessionId);
  return { session: s, summary };
}

function summaryRequest(s: TaskSession, history: { at: string; text: string }[]): SummaryRequest {
  return {
    task: s.task,
    steps: s.taskPlan.map((p) => ({ title: p.title, done: p.done })),
    currentStep: currentStepTitle(s),
    tabs: s.tabs.slice(0, 30).map((t) => ({ title: t.title, url: t.url.split(/[?#]/)[0] ?? t.url })),
    history: history.map((h) => ({ at: h.at, text: h.text })),
    activeMinutes: Math.round(activeMsNow(s) / 60_000),
  };
}

/** Best-effort: ask the model for a concrete "next step" sentence to show on resume. */
async function refreshHint(sessionId: string): Promise<void> {
  try {
    const s = (await getSessions())[sessionId];
    if (!s) return;
    const history = historyForSession(await getHistory(), sessionId);
    const ai = await callApi<SummaryResponse>('/summary', summaryRequest(s, history));
    const fresh = (await getSessions())[sessionId];
    if (!fresh || !ai.nextStepHint) return;
    fresh.nextStepHint = ai.nextStepHint;
    await persist(fresh);
  } catch {
    /* hint is optional */
  }
}

// ── Restore / resume ───────────────────────────────────────────────────────

export async function restoreSession(sessionId: string): Promise<ResumeInfo> {
  const sessions = await getSessions();
  const s = sessions[sessionId];
  if (!s) throw new Error('That session no longer exists.');

  const isArchive = s.status === 'archived';
  const current = await getActiveSession();
  if (!isArchive && current && current.sessionId !== sessionId) await deactivate(current, { closeTabs: false });

  const open = await snapshot();
  const idByUrl = new Map<string, number>();
  for (const t of open.tabs) if (isManageable(t)) idByUrl.set(normalizeUrl(t.url), t.id);

  const win = await chrome.windows.getLastFocused().catch(() => null);
  const windowId = win?.id;
  let reopened = 0;
  let reused = 0;
  const tabIds = new Set<number>();
  let lastActiveTabId: number | undefined;

  for (const saved of s.tabs) {
    if (!isWebUrl(saved.url)) continue;
    const key = normalizeUrl(saved.url);
    let id = idByUrl.get(key);
    if (id != null) {
      if (tabIds.has(id)) continue; // two saved tabs collapsed to one page
      reused++;
    } else {
      const created = await chrome.tabs.create({ url: saved.url, active: false, ...(windowId != null ? { windowId } : {}) });
      id = created.id;
      if (id == null) continue;
      idByUrl.set(key, id);
      reopened++;
    }
    tabIds.add(id);
    if (s.lastActiveUrl && key === normalizeUrl(s.lastActiveUrl)) lastActiveTabId = id;
  }

  if (isArchive) {
    // A tab archive is a bookmark-like bundle, not a task: reopen and group, leave the active task alone.
    if (tabIds.size) await groupTabs([...tabIds], sessionGroupTitle(s), s.color);
    await logEvent('session_restored', `Reopened "${s.title}" (${reopened} reopened, ${reused} already open)`, s.sessionId);
    return { session: s, stoppedAt: null, nextStepHint: null, reopened, reused };
  }

  s.status = 'active';
  s.paused = false;
  s.endedAt = undefined;
  s.activeSince = new Date().toISOString();
  s.relevantUrls ??= [];
  await persist(s);
  await setActiveSessionId(s.sessionId);
  await setFocus({ status: 'idle' });

  if (tabIds.size) {
    const { groupId } = await groupTabs([...tabIds], sessionGroupTitle(s), s.color);
    await updateActiveSession((x) => {
      x.groupId = groupId;
      x.windowId = windowId;
    });
  }
  if (lastActiveTabId != null) await chrome.tabs.update(lastActiveTabId, { active: true });

  await logEvent('session_restored', `Restored "${s.title}" (${reopened} reopened, ${reused} already open)`, s.sessionId);
  const fresh = (await getActiveSession()) ?? s;
  return { session: fresh, stoppedAt: currentStepTitle(fresh), nextStepHint: fresh.nextStepHint ?? null, reopened, reused };
}

export async function archiveTabs(tabIds: number[], close = true, name?: string): Promise<{ sessionId: string; closed: number }> {
  const snap = await snapshot();
  const chosen = snap.tabs.filter((t) => tabIds.includes(t.id) && isManageable(t) && !t.pinned);
  if (!chosen.length) throw new Error('Nothing to archive.');
  const now = new Date();
  const iso = now.toISOString();
  const s: TaskSession = {
    ...createSession('Archived tabs', { title: name?.trim() || `Archive ${now.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`, steps: [] }, now),
    sessionId: crypto.randomUUID(),
    status: 'archived',
    emoji: '🗄️',
    tabs: chosen.map((t) => ({ url: t.url, title: t.title, category: 'Archived', favIconUrl: t.favIconUrl })),
    activeSince: undefined,
    lastActiveAt: iso,
  };
  await persist(s);
  await logEvent(close ? 'tabs_closed' : 'session_saved', `${close ? 'Archived' : 'Saved'} ${chosen.length} tabs as "${s.title}"`, s.sessionId);
  const closed = close ? await closeTabs(chosen.map((t) => t.id)) : 0;
  return { sessionId: s.sessionId, closed };
}

export async function deleteSession(sessionId: string): Promise<void> {
  await removeSession(sessionId);
  void deleteRemote(sessionId);
}

// ── Plan editing ───────────────────────────────────────────────────────────

export async function toggleStep(stepId: string): Promise<TaskSession> {
  let label = '';
  let nowDone = false;
  const s = await updateActiveSession((x) => {
    const step = x.taskPlan.find((p) => p.id === stepId);
    if (!step) throw new Error('Unknown step.');
    step.done = !step.done;
    label = step.title;
    nowDone = step.done;
    syncStepPointers(x);
  });
  await logEvent(nowDone ? 'step_done' : 'step_undone', `${nowDone ? 'Completed' : 'Reopened'}: ${label}`, s.sessionId);
  return s;
}

export async function setStep(index: number): Promise<TaskSession> {
  return updateActiveSession((x) => {
    if (index < 0 || index >= x.taskPlan.length) throw new Error('No such step.');
    x.currentStep = index;
  });
}

export async function replan(note?: string): Promise<TaskSession> {
  const s = await getActiveSession();
  if (!s) throw new Error('No active task.');
  const revised = await callApi<PlanResponse>('/plan', {
    goal: s.task,
    existing: { steps: s.taskPlan.map((p) => ({ title: p.title, done: p.done })) },
    note,
  });
  const updated = await updateActiveSession((x) => {
    x.taskPlan = mergeReplan(x.taskPlan, revised.steps);
    syncStepPointers(x);
  });
  await logEvent('plan_updated', note ? `Updated plan: ${note}` : 'Updated plan', updated.sessionId);
  return updated;
}

export async function addNote(text: string): Promise<TaskSession> {
  const t = text.trim();
  if (!t) throw new Error('Note is empty.');
  const s = await updateActiveSession((x) => {
    x.notes.push({ at: new Date().toISOString(), text: t.slice(0, 1000) });
  });
  await logEvent('note', t.slice(0, 120), s.sessionId);
  return s;
}

export async function setPaused(paused: boolean): Promise<TaskSession> {
  const s = await updateActiveSession((x) => {
    x.paused = paused;
  });
  await setFocus({ status: paused ? 'paused' : 'idle' });
  return s;
}

export async function listSessions(): Promise<TaskSession[]> {
  const all = Object.values(await getSessions());
  return all.sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
}


/** The browser restarted and the live Chrome group is gone; keep the saved tabs, forget the group id. */
export async function detachGroup(sessionId: string): Promise<void> {
  const s = (await getSessions())[sessionId];
  if (!s) return;
  s.groupId = undefined;
  s.windowId = undefined;
  await persist(s);
}
