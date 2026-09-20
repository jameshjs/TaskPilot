import type { Broadcast, BroadcastName, RpcEnvelope, RpcRequest, RpcResponse, RpcType } from '../shared/rpc';
import { reportTelemetry } from './api';
import { clearGuide, guide, guideTarget, insert, onHighlightActed, onHighlightGone, scanFields, suggest } from './navigator';
import { focusAction, registerFocusListeners } from './focus';
import { whatWasIDoing } from './memory';
import * as sessions from './sessions';
import { getActiveSession, getFocus, getHistory, getSettings, setSettings } from './store';
import { syncNow } from './sync';
import * as tabs from './tabs';
import * as workflow from './workflow';

type Handlers = { [K in RpcType]: (req: RpcRequest<K>, sender: chrome.runtime.MessageSender) => Promise<RpcResponse<K>> };

const handlers: Handlers = {
  'tabs.snapshot': () => tabs.snapshot(),
  'tabs.groupTabs': ({ tabIds, title, color }) => tabs.groupTabs(tabIds, title, color),
  'tabs.renameGroup': ({ groupId, title, color }) => tabs.renameGroup(groupId, title, color),
  'tabs.ungroup': ({ tabIds }) => tabs.ungroup(tabIds),
  'tabs.close': async ({ tabIds }) => ({ closed: await tabs.closeTabs(tabIds) }),
  'tabs.activate': async ({ tabId }) => {
    const t = await chrome.tabs.update(tabId, { active: true });
    if (t) await chrome.windows.update(t.windowId, { focused: true });
  },
  'tabs.organizePreview': () => tabs.organizePreview(),
  'tabs.organizeApply': ({ groups }) => tabs.organizeApply(groups),
  'tabs.classify': () => tabs.classifyTabs(),
  'tabs.cleanupAnalyze': () => tabs.cleanupAnalyze(),
  'tabs.archive': ({ tabIds, close, name }) => sessions.archiveTabs(tabIds, close ?? true, name),

  'session.active': () => getActiveSession(),
  'session.list': () => sessions.listSessions(),
  'session.start': ({ task }) => sessions.startSession(task),
  'session.setStep': ({ index }) => sessions.setStep(index),
  'session.toggleStep': ({ stepId }) => sessions.toggleStep(stepId),
  'session.replan': ({ note }) => sessions.replan(note),
  'session.save': ({ closeTabs }) => sessions.saveSession(!!closeTabs),
  'session.finish': ({ closeTabs }) => sessions.finishSession(!!closeTabs),
  'session.restore': ({ sessionId }) => sessions.restoreSession(sessionId),
  'session.delete': ({ sessionId }) => sessions.deleteSession(sessionId),
  'session.addNote': ({ text }) => sessions.addNote(text),
  'session.pause': ({ paused }) => sessions.setPaused(paused),
  'session.addTabs': ({ tabIds }) => sessions.addTabsToWorkspace(tabIds),

  'history.list': async (req) => {
    const all = await getHistory();
    return all.slice(-(req?.limit ?? 200)).reverse();
  },
  whatWasIDoing: () => whatWasIDoing(),

  'nav.guide': () => guide(),
  'nav.guideTarget': () => guideTarget(),
  'nav.clear': () => clearGuide(),
  'nav.scanFields': () => scanFields(),
  'nav.suggest': ({ field }) => suggest(field),
  'nav.insert': ({ fieldId, text }) => insert(fieldId, text),

  'focus.state': () => getFocus(),
  'focus.action': ({ action }) => focusAction(action),

  'settings.get': () => getSettings(),
  'settings.set': (patch) => setSettings(patch),
  'sync.now': () => syncNow(),
  'workflow.status': () => workflow.status(),
  'workflow.tools': () => workflow.listTools(),
  'workflow.connect': ({ integration }) => workflow.connect(integration),
  'workflow.reconcile': ({ notes }) => workflow.reconcile(notes),
  'workflow.read': ({ toolSlug, args }) => workflow.read(toolSlug, args ?? {}),
  'workflow.preview': ({ toolSlug, args }) => workflow.preview(toolSlug, args ?? {}),
  'workflow.pending': () => workflow.pending(),
  'workflow.reject': ({ previewId }) => workflow.reject(previewId),
  'workflow.execute': ({ previewId }) => workflow.execute(previewId),
};

// ── Message routing ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg: { type?: string; payload?: unknown; event?: string; [k: string]: unknown }, sender, sendResponse) => {
  if (msg?.type === 'content.event') {
    const tabId = sender.tab?.id;
    const elementId = String(msg.elementId ?? '');
    if (msg.event === 'highlight_acted' && tabId != null) {
      // The user actually did the thing we pointed at — the only signal that advances a step.
      void onHighlightActed(tabId, elementId);
    } else if (msg.event === 'highlight_dismissed' && tabId != null) {
      void onHighlightGone(tabId, elementId);
    } else if (msg.event === 'highlight_lost') {
      if (tabId != null) void onHighlightGone(tabId, elementId);
      reportTelemetry('dom_selection_failed', 'Highlighted element disappeared', { reason: 'element_detached' }, { url: String(msg.url ?? '').split(/[?#]/)[0] });
    }
    return false;
  }
  const handler = msg?.type ? (handlers as Record<string, (req: unknown, s: chrome.runtime.MessageSender) => Promise<unknown>>)[msg.type] : undefined;
  if (!handler) return false;

  handler(msg.payload, sender).then(
    (data) => sendResponse({ ok: true, data } satisfies RpcEnvelope<unknown>),
    (e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) } satisfies RpcEnvelope<unknown>),
  );
  return true; // keep the channel open for the async response
});

// ── Push updates to the side panel ─────────────────────────────────────────

const pendingBroadcasts = new Map<BroadcastName, ReturnType<typeof setTimeout>>();
function broadcast(name: BroadcastName): void {
  if (pendingBroadcasts.has(name)) return;
  pendingBroadcasts.set(
    name,
    setTimeout(() => {
      pendingBroadcasts.delete(name);
      // Rejects when no side panel is open; that's fine.
      chrome.runtime.sendMessage({ type: 'broadcast', name } satisfies Broadcast).catch(() => undefined);
    }, 120),
  );
}

for (const ev of [chrome.tabs.onCreated, chrome.tabs.onRemoved, chrome.tabs.onUpdated, chrome.tabs.onMoved, chrome.tabs.onAttached, chrome.tabs.onActivated, chrome.tabGroups.onCreated, chrome.tabGroups.onUpdated, chrome.tabGroups.onRemoved]) {
  (ev as chrome.events.Event<() => void>).addListener(() => broadcast('tabs'));
}
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'local') broadcast('state');
});

registerFocusListeners();

// ── Lifecycle ──────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  void getSettings(); // materialize userId
});
chrome.runtime.onStartup.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

// Chrome tab-group ids don't survive a browser restart; drop the stale pointer so we never act on the wrong group.
chrome.runtime.onStartup.addListener(async () => {
  const s = await getActiveSession();
  if (s?.groupId != null) {
    const ok = await chrome.tabGroups.get(s.groupId).then(() => true, () => false);
    if (!ok) await sessions.detachGroup(s.sessionId);
  }
});
