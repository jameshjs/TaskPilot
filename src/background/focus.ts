import type { FocusResponse } from '../../shared/api';
import { currentStepTitle } from '../shared/sessionLogic';
import type { FocusState, TaskSession } from '../shared/types';
import { hostOf, isWebUrl, matchesHost, matchesUrlPattern, normalizeUrl, redactTitle, redactUrl } from '../shared/urlutil';
import { callApi } from './api';
import { toContent } from './content';
import { addTabsToWorkspace, setPaused } from './sessions';
import { getActiveSession, getFocus, getSettings, logEvent, setFocus, updateActiveSession } from './store';

const NUDGE_ALARM = 'taskpilot-focus-nudge';
const NUDGE_EVERY_MS = 5 * 60_000;
const CACHE_TTL_MS = 10 * 60_000;
const AUTO_ADD_CONFIDENCE = 0.8;

const cache = new Map<string, { at: number; res: FocusResponse }>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const loggedAdds = new Set<number>();

export function registerFocusListeners(): void {
  chrome.tabs.onActivated.addListener(({ tabId }) => scheduleEvaluate(tabId, 400));

  chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (tab.active && (info.status === 'complete' || info.title)) scheduleEvaluate(tabId, 1500);
    if (info.status === 'complete') void logWorkspaceArrival(tabId, tab);
  });

  // A tab opened from a workspace tab (link click, target=_blank) belongs to the task.
  chrome.tabs.onCreated.addListener((tab) => void adoptOpenedTab(tab));

  chrome.alarms.create(NUDGE_ALARM, { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener((a) => {
    if (a.name === NUDGE_ALARM) void nudge();
  });
}

function scheduleEvaluate(tabId: number, delay: number): void {
  clearTimeout(timers.get(tabId));
  timers.set(
    tabId,
    setTimeout(() => {
      timers.delete(tabId);
      void evaluateTab(tabId).catch(() => undefined);
    }, delay),
  );
}

async function adoptOpenedTab(tab: chrome.tabs.Tab): Promise<void> {
  const [session, settings] = await Promise.all([getActiveSession(), getSettings()]);
  if (!session || session.paused || !settings.autoAddRelevantTabs || tab.id == null || tab.openerTabId == null) return;
  if (session.groupId == null || session.groupId < 0) return;
  if (matchesUrlPattern(tab.pendingUrl ?? tab.url ?? '', settings.distractingUrls)) return;
  const opener = await chrome.tabs.get(tab.openerTabId).catch(() => null);
  if (opener?.groupId === session.groupId) await addTabsToWorkspace([tab.id]).catch(() => undefined);
}

async function logWorkspaceArrival(tabId: number, tab: chrome.tabs.Tab): Promise<void> {
  const session = await getActiveSession();
  if (!session || session.groupId == null || tab.groupId !== session.groupId || loggedAdds.has(tabId) || !isWebUrl(tab.url)) return;
  loggedAdds.add(tabId);
  await logEvent('tab_added', `Opened ${tab.title || hostOf(tab.url)}`, session.sessionId);
}

function inWorkspace(session: TaskSession, tab: chrome.tabs.Tab): boolean {
  return session.groupId != null && session.groupId >= 0 && tab.groupId === session.groupId;
}

/** The user pressed "This Is Relevant" on this exact page; outranks every other rule. */
function markedRelevant(session: TaskSession, tab: chrome.tabs.Tab): boolean {
  return !!tab.url && session.relevantUrls.includes(normalizeUrl(tab.url));
}

async function classify(session: TaskSession, tab: chrome.tabs.Tab): Promise<FocusResponse> {
  const step = currentStepTitle(session) ?? session.task;
  const key = `${session.sessionId}|${session.currentStep}|${normalizeUrl(tab.url!)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.res;

  const summary = await toContent<string>(tab.id!, { type: 'cs.summary' }).catch(() => undefined);
  const group = session.groupId != null && session.groupId >= 0 ? await chrome.tabs.query({ groupId: session.groupId }).catch(() => []) : [];
  const res = await callApi<FocusResponse>('/focus', {
    goal: session.task,
    currentStep: step,
    page: { url: redactUrl(tab.url!), title: redactTitle(tab.title ?? '', tab.url!), summary },
    taskTabs: group.slice(0, 8).map((t) => ({ title: redactTitle(t.title ?? '', t.url ?? ''), url: redactUrl(t.url ?? '') })),
  });
  cache.set(key, { at: Date.now(), res });
  return res;
}

/** Compare the page the user is on against their task, and warn (never block) if they've drifted. */
export async function evaluateTab(tabId: number): Promise<void> {
  const [session, settings, prev] = await Promise.all([getActiveSession(), getSettings(), getFocus()]);
  if (!session) return;
  if (session.paused) return setFocus({ ...prev, status: 'paused' });
  if (!settings.focusEnabled) return;

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !tab.active || !isWebUrl(tab.url)) return;
  if (matchesHost(hostOf(tab.url), settings.excludedHosts)) return;

  const base = { pageTitle: tab.title, pageUrl: tab.url, tabId };

  if (markedRelevant(session, tab)) {
    await markOnTask(prev, { ...base, classification: 'RELEVANT', confidence: 1, reason: 'You marked this page as relevant.' }, session);
    return;
  }

  // The user's own call, so it beats both the workspace group and the model.
  if (matchesUrlPattern(tab.url, settings.distractingUrls)) {
    await markDrifting(prev, { ...base, classification: 'DISTRACTING', confidence: 1, reason: 'You listed this site as a distraction.' }, session, tab);
    return;
  }

  if (inWorkspace(session, tab)) {
    await markOnTask(prev, { ...base, classification: 'RELEVANT', confidence: 1, reason: 'Part of your task workspace.' }, session);
    return;
  }

  let res: FocusResponse;
  try {
    res = await classify(session, tab);
  } catch {
    return; // Focus is best-effort; never surface backend errors while the user is just browsing.
  }
  // The user may have moved on while the model was thinking.
  const [now] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (now?.id !== tabId) return;
  const state = { ...base, classification: res.classification, confidence: res.confidence, reason: res.reason };

  if (res.classification === 'RELEVANT' || res.classification === 'POSSIBLY_RELEVANT') {
    await markOnTask(prev, state, session);
    if (settings.autoAddRelevantTabs && res.classification === 'RELEVANT' && res.confidence >= AUTO_ADD_CONFIDENCE) {
      await addTabsToWorkspace([tabId]).catch(() => undefined);
    }
    return;
  }

  if (res.confidence < settings.driftThreshold) {
    await markOnTask(prev, state, session); // not sure enough to nag
    return;
  }

  await markDrifting(prev, state, session, tab);
}

async function markDrifting(prev: FocusState, state: Omit<FocusState, 'status'>, session: TaskSession, tab: chrome.tabs.Tab): Promise<void> {
  const wasDrifting = prev.status === 'drifting';
  const driftSince = wasDrifting && prev.driftSince ? prev.driftSince : new Date().toISOString();
  const next: FocusState = { ...state, status: 'drifting', driftSince, lastNudgeAt: prev.lastNudgeAt, dismissedUrl: prev.dismissedUrl };
  await setFocus(next);
  if (!wasDrifting) await logEvent('drift', `Opened ${tab.title || hostOf(tab.url!)}`, session.sessionId);
  if (prev.dismissedUrl !== normalizeUrl(tab.url!)) await showWarning(next, session);
}

async function markOnTask(prev: FocusState, state: Omit<FocusState, 'status'>, session: TaskSession): Promise<void> {
  if (prev.status === 'drifting') {
    await logEvent('returned', 'Returned to task', session.sessionId);
    if (prev.tabId != null && prev.tabId !== state.tabId) await toContent(prev.tabId, { type: 'cs.hideBanner' }).catch(() => undefined);
  }
  await setFocus({ ...state, status: 'on_task' });
}

async function showWarning(state: FocusState, session: TaskSession): Promise<void> {
  if (state.tabId == null) return;
  const minutesAway = state.driftSince ? Math.floor((Date.now() - Date.parse(state.driftSince)) / 60_000) : null;
  await toContent(state.tabId, {
    type: 'cs.banner',
    data: { goal: session.task, step: currentStepTitle(session), minutesAway, reason: state.reason },
  }).catch(() => undefined);
  await setFocus({ ...state, lastNudgeAt: new Date().toISOString() });
}

async function nudge(): Promise<void> {
  const [state, session] = await Promise.all([getFocus(), getActiveSession()]);
  if (!session || session.paused || state.status !== 'drifting' || state.tabId == null) return;
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active?.id !== state.tabId || (active.url && state.dismissedUrl === normalizeUrl(active.url))) return;
  const since = Date.parse(state.lastNudgeAt ?? state.driftSince ?? new Date().toISOString());
  if (Date.now() - since >= NUDGE_EVERY_MS) await showWarning(state, session);
}

// ── User responses to the warning (from the in-page card or the side panel) ──

export async function focusAction(action: 'return' | 'relevant' | 'pause' | 'dismiss'): Promise<void> {
  const [state, session] = await Promise.all([getFocus(), getActiveSession()]);
  if (!session) return;
  const tabId = state.tabId;
  const hide = () => (tabId != null ? toContent(tabId, { type: 'cs.hideBanner' }).catch(() => undefined) : Promise.resolve());

  switch (action) {
    case 'dismiss':
      await hide();
      await setFocus({ ...state, dismissedUrl: state.pageUrl ? normalizeUrl(state.pageUrl) : undefined });
      return;

    case 'pause':
      await hide();
      await setPaused(true);
      return;

    case 'relevant': {
      await hide();
      if (state.pageUrl) {
        const url = normalizeUrl(state.pageUrl);
        await updateActiveSession((s) => {
          if (!s.relevantUrls.includes(url)) s.relevantUrls.push(url);
        });
      }
      if (tabId != null) await addTabsToWorkspace([tabId]).catch(() => undefined);
      await setFocus({ ...state, status: 'on_task', classification: 'RELEVANT', driftSince: undefined });
      return;
    }

    case 'return': {
      await hide();
      const target = await pickReturnTab(session, tabId);
      if (target != null) {
        await chrome.tabs.update(target, { active: true });
        const t = await chrome.tabs.get(target);
        await chrome.windows.update(t.windowId, { focused: true }).catch(() => undefined);
      } else if (session.lastActiveUrl) {
        await chrome.tabs.create({ url: session.lastActiveUrl, active: true });
      }
      await logEvent('returned', 'Returned to task', session.sessionId);
      await setFocus({ status: 'on_task' });
    }
  }
}

/** Most recently used workspace tab that isn't the one we're leaving. */
async function pickReturnTab(session: TaskSession, leaving: number | undefined): Promise<number | null> {
  if (session.groupId == null || session.groupId < 0) return null;
  const tabs = (await chrome.tabs.query({ groupId: session.groupId }).catch(() => [])).filter((t) => t.id != null && t.id !== leaving);
  const best = tabs.sort((a, b) => ((b as { lastAccessed?: number }).lastAccessed ?? 0) - ((a as { lastAccessed?: number }).lastAccessed ?? 0))[0];
  return best?.id ?? null;
}
