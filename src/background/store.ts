import type { FocusState, HistoryEvent, Settings, TaskSession } from '../shared/types';

declare const __DEFAULT_API_URL__: string;

export const DEFAULT_SETTINGS: Settings = {
  apiUrl: typeof __DEFAULT_API_URL__ === 'string' ? __DEFAULT_API_URL__ : 'http://localhost:8787',
  apiToken: '',
  focusEnabled: true,
  autoAddRelevantTabs: true,
  driftThreshold: 0.75,
  profile: '',
  excludedHosts: [],
  distractingUrls: [],
  syncEnabled: false,
  userId: '',
};

const HISTORY_CAP = 500;

// A service worker can be handling several events at once; serialize read-modify-write.
let chain: Promise<unknown> = Promise.resolve();
export function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

async function get<T>(key: string, fallback: T): Promise<T> {
  const got = await chrome.storage.local.get(key);
  return (got[key] as T | undefined) ?? fallback;
}

export async function getSettings(): Promise<Settings> {
  const stored = await get<Partial<Settings>>('settings', {});
  const s = { ...DEFAULT_SETTINGS, ...stored };
  if (!s.userId) {
    s.userId = crypto.randomUUID();
    await chrome.storage.local.set({ settings: s });
  }
  return s;
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  return withLock(async () => {
    const next = { ...(await getSettings()), ...patch };
    await chrome.storage.local.set({ settings: next });
    return next;
  });
}

export async function getSessions(): Promise<Record<string, TaskSession>> {
  return get('sessions', {});
}

export async function putSession(session: TaskSession): Promise<void> {
  await withLock(async () => {
    const all = await getSessions();
    all[session.sessionId] = session;
    await chrome.storage.local.set({ sessions: all });
  });
}

export async function removeSession(sessionId: string): Promise<void> {
  await withLock(async () => {
    const all = await getSessions();
    delete all[sessionId];
    const active = await getActiveSessionId();
    await chrome.storage.local.set({ sessions: all, ...(active === sessionId ? { activeSessionId: null } : {}) });
  });
}

export async function getActiveSessionId(): Promise<string | null> {
  return get<string | null>('activeSessionId', null);
}

export async function setActiveSessionId(id: string | null): Promise<void> {
  await chrome.storage.local.set({ activeSessionId: id });
}

export async function getActiveSession(): Promise<TaskSession | null> {
  const id = await getActiveSessionId();
  if (!id) return null;
  return (await getSessions())[id] ?? null;
}

/** Read-modify-write the active session atomically. Throws if there is none. */
export async function updateActiveSession(fn: (s: TaskSession) => void): Promise<TaskSession> {
  return withLock(async () => {
    const id = await getActiveSessionId();
    const all = await getSessions();
    const s = id ? all[id] : undefined;
    if (!s) throw new Error('No active task. Start one first.');
    fn(s);
    s.lastActiveAt = new Date().toISOString();
    all[s.sessionId] = s;
    await chrome.storage.local.set({ sessions: all });
    return s;
  });
}

export async function getHistory(): Promise<HistoryEvent[]> {
  return get('history', []);
}

export async function logEvent(kind: HistoryEvent['kind'], text: string, sessionId?: string): Promise<void> {
  await withLock(async () => {
    const history = await getHistory();
    history.push({ id: crypto.randomUUID(), at: new Date().toISOString(), kind, text, sessionId });
    await chrome.storage.local.set({ history: history.slice(-HISTORY_CAP) });
  });
}

export async function getFocus(): Promise<FocusState> {
  return get<FocusState>('focus', { status: 'idle' });
}

export async function setFocus(next: FocusState): Promise<void> {
  await chrome.storage.local.set({ focus: next });
}
