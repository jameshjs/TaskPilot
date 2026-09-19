import type { ContentRequest } from '../content';
import { isWebUrl } from '../shared/urlutil';

type Reply<T> = { ok: true; data: T } | { ok: false; error: string };

async function send<T>(tabId: number, msg: ContentRequest): Promise<T> {
  const res = (await chrome.tabs.sendMessage(tabId, msg)) as Reply<T> | undefined;
  if (!res) throw new Error('The page did not respond.');
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

/**
 * Talk to the content script in a tab, injecting it first if the tab was open before
 * TaskPilot was installed/reloaded. Restricted pages (chrome://, the Web Store) can't be scripted.
 */
export async function toContent<T>(tabId: number, msg: ContentRequest): Promise<T> {
  const tab = await chrome.tabs.get(tabId);
  if (!isWebUrl(tab.url)) throw new Error("TaskPilot can't run on this kind of page.");
  try {
    return await send<T>(tabId, msg);
  } catch (e) {
    if (!/Receiving end does not exist|Could not establish connection/i.test((e as Error).message)) throw e;
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch {
    throw new Error("TaskPilot can't run on this page (it may be a protected site).");
  }
  return send<T>(tabId, msg);
}

export async function activeTabId(): Promise<number> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id == null) throw new Error('No active tab.');
  return tab.id;
}
