/**
 * A Chrome extension environment small enough to run the service worker under vitest.
 *
 * The guided-mode loop only exists as the conversation between the side panel, the
 * service worker, the content script and the backend, so unit-testing the pure helpers
 * proves almost nothing about it. This fakes the four sides well enough to drive the
 * real code: storage that persists and fires onChanged, tabs that answer sendMessage,
 * an onMessage router with Chrome's sendResponse protocol, and a scripted backend.
 */
import type { ContentRequest, ExtractResult } from '../src/content';
import type { NavigateResponse, PageElement } from '../shared/api';

type Listener = (...args: unknown[]) => unknown;

function makeEvent() {
  const listeners: Listener[] = [];
  return {
    addListener: (fn: Listener) => listeners.push(fn),
    removeListener: (fn: Listener) => listeners.splice(listeners.indexOf(fn), 1),
    hasListener: (fn: Listener) => listeners.includes(fn),
    emit: (...args: unknown[]) => listeners.map((fn) => fn(...args)),
    listeners,
  };
}

export interface FakeTab {
  id: number;
  url: string;
  title: string;
  windowId: number;
  active: boolean;
  groupId: number;
}

export interface FakeChrome {
  storage: Record<string, unknown>;
  tabs: FakeTab[];
  /** Replies the fake backend hands back to POST /navigate, in order. */
  navigateQueue: NavigateResponse[];
  /** Every request the service worker made of the backend. */
  apiCalls: { path: string; body: Record<string, unknown> }[];
  /** Every message the service worker sent a tab's content script. */
  contentCalls: { tabId: number; msg: ContentRequest }[];
  /** Elements the fake page offers to the extractor. */
  elements: PageElement[];
  /** Canned backend replies for the external-app routes, by path. */
  apiReplies: Record<string, unknown>;
  /** Tabs the extension opened with chrome.tabs.create (e.g. an OAuth sign-in page). */
  openedUrls: string[];
  /** When set, the fake backend 401s any request that doesn't carry this bearer token. */
  requireToken: string | null;
  /** Send an RPC the way the side panel does, through the real onMessage router. */
  rpc: (type: string, payload?: unknown) => Promise<unknown>;
  /** Report a content-script event, the way a highlighted page does. */
  contentEvent: (tabId: number, event: string, extra?: Record<string, unknown>) => void;
  /** Wait for the service worker's fire-and-forget work to settle. */
  settle: () => Promise<void>;
  events: Record<string, ReturnType<typeof makeEvent>>;
}

export function installFakeChrome(): FakeChrome {
  const storage: Record<string, unknown> = {};
  const events: Record<string, ReturnType<typeof makeEvent>> = {};
  const event = (name: string) => (events[name] ??= makeEvent());

  const f: FakeChrome = {
    storage,
    tabs: [{ id: 1, url: 'https://example.com/apply', title: 'Apply', windowId: 10, active: true, groupId: -1 }],
    navigateQueue: [],
    apiCalls: [],
    contentCalls: [],
    requireToken: null,
    apiReplies: {},
    openedUrls: [],
    elements: [
      { id: 'tp-1', type: 'button', text: 'Apply now' },
      { id: 'tp-2', type: 'link', text: 'Next' },
    ],
    rpc: async () => undefined,
    contentEvent: () => undefined,
    settle: async () => {
      // Let queued microtasks and the 0ms timers in the worker drain.
      for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
    },
    events,
  };

  const tabById = (id: number) => f.tabs.find((t) => t.id === id);

  const chrome = {
    storage: {
      local: {
        get: async (key: string | string[] | Record<string, unknown> | null) => {
          if (typeof key === 'string') return key in storage ? { [key]: storage[key] } : {};
          if (Array.isArray(key)) return Object.fromEntries(key.filter((k) => k in storage).map((k) => [k, storage[k]]));
          return { ...storage };
        },
        set: async (obj: Record<string, unknown>) => {
          const changes = Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, { oldValue: storage[k], newValue: v }]));
          Object.assign(storage, obj);
          event('storage.onChanged').emit(changes, 'local');
        },
        remove: async (key: string) => void delete storage[key],
      },
      onChanged: event('storage.onChanged'),
    },

    tabs: {
      query: async (q: { active?: boolean; groupId?: number; lastFocusedWindow?: boolean }) =>
        f.tabs.filter((t) => (q.active == null || t.active === q.active) && (q.groupId == null || t.groupId === q.groupId)),
      get: async (id: number) => {
        const t = tabById(id);
        if (!t) throw new Error('No tab with id: ' + id);
        return t;
      },
      sendMessage: async (tabId: number, msg: ContentRequest) => {
        f.contentCalls.push({ tabId, msg });
        const tab = tabById(tabId);
        if (!tab) return { ok: false, error: 'No tab' };
        switch (msg.type) {
          case 'cs.extract':
            return { ok: true, data: { url: tab.url, title: tab.title, elements: f.elements } satisfies ExtractResult };
          case 'cs.highlight':
            return f.elements.some((e) => e.id === msg.elementId)
              ? { ok: true, data: undefined }
              : { ok: false, error: 'That element is no longer on the page.' };
          default:
            return { ok: true, data: undefined };
        }
      },
      create: async (props: { url?: string; windowId?: number }) => {
        if (props.url) f.openedUrls.push(props.url);
        const t: FakeTab = { id: Math.max(0, ...f.tabs.map((x) => x.id)) + 1, url: props.url ?? 'about:blank', title: 'New', windowId: props.windowId ?? 10, active: false, groupId: -1 };
        f.tabs.push(t);
        return t;
      },
      update: async (id: number, props: { active?: boolean }) => Object.assign(tabById(id) ?? {}, props),
      remove: async () => undefined,
      move: async () => undefined,
      group: async () => 99,
      ungroup: async () => undefined,
      onCreated: event('tabs.onCreated'),
      onRemoved: event('tabs.onRemoved'),
      onUpdated: event('tabs.onUpdated'),
      onMoved: event('tabs.onMoved'),
      onAttached: event('tabs.onAttached'),
      onActivated: event('tabs.onActivated'),
    },

    tabGroups: {
      query: async () => [],
      get: async (id: number) => ({ id, title: 'Task', color: 'blue', windowId: 10 }),
      update: async () => undefined,
      onCreated: event('tabGroups.onCreated'),
      onUpdated: event('tabGroups.onUpdated'),
      onRemoved: event('tabGroups.onRemoved'),
    },

    windows: {
      getLastFocused: async () => ({ id: 10 }),
      update: async () => undefined,
    },

    scripting: { executeScript: async () => [{ result: null }] },

    runtime: {
      onMessage: event('runtime.onMessage'),
      onInstalled: event('runtime.onInstalled'),
      onStartup: event('runtime.onStartup'),
      sendMessage: async () => undefined, // broadcasts to a side panel nobody opened
      lastError: undefined,
    },

    alarms: { create: () => undefined, onAlarm: event('alarms.onAlarm') },
    sidePanel: { setPanelBehavior: async () => undefined },
  };

  (globalThis as { chrome?: unknown }).chrome = chrome;

  // The side panel's rpc(), routed through whatever index.ts registered.
  f.rpc = (type: string, payload?: unknown) =>
    new Promise((resolve, reject) => {
      const [listener] = event('runtime.onMessage').listeners;
      if (!listener) return reject(new Error('No onMessage listener registered'));
      const kept = listener({ type, payload }, {}, (res: { ok: boolean; data?: unknown; error?: string }) =>
        res.ok ? resolve(res.data) : reject(new Error(res.error)),
      );
      if (kept !== true) reject(new Error(`No handler for ${type}`));
    });

  f.contentEvent = (tabId, eventName, extra) => {
    const [listener] = event('runtime.onMessage').listeners;
    listener?.({ type: 'content.event', event: eventName, ...extra }, { tab: { id: tabId } }, () => undefined);
  };

  // The backend.
  (globalThis as { fetch?: unknown }).fetch = async (url: string, init: { body: string; headers: Record<string, string> }) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(init.body) as Record<string, unknown>;
    f.apiCalls.push({ path, body });
    const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });

    // The deployed Worker rejects every unauthenticated call when TASKPILOT_TOKEN is set.
    if (f.requireToken && init.headers?.authorization !== `Bearer ${f.requireToken}`) {
      return { ok: false, status: 401, statusText: 'Unauthorized', json: async () => ({ error: 'Unauthorized' }), text: async () => '{"error":"Unauthorized"}' };
    }

    switch (path) {
      case '/plan':
        return json({ title: 'Applications', steps: [{ title: 'Open the application', done: false }, { title: 'Fill in your details', done: false }, { title: 'Submit', done: false }] });
      case '/navigate':
        return json(f.navigateQueue.shift() ?? { action: 'highlight', elementId: 'tp-1', instruction: 'Click Apply now', confidence: 0.9 });
      case '/focus':
        return json({ status: 'on_task', confidence: 0.9, reason: '' });
      default:
        // External-app routes are scripted per test; anything else answers emptily.
        if (path in f.apiReplies) {
          const reply = f.apiReplies[path];
          if (reply instanceof Error) return { ok: false, status: 400, statusText: 'Bad Request', json: async () => ({}), text: async () => reply.message };
          return json(typeof reply === 'function' ? (reply as (b: Record<string, unknown>) => unknown)(body) : reply);
        }
        return json({});
    }
  };

  return f;
}
