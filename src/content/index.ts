import { createRegistry, extractElements, insertText, pageSummary, rectOf, resolve, scanFields } from './extract';
import { clearHighlight, hideBanner, showBanner, showHighlight, type BannerData } from './overlay';
import type { FormField } from '../shared/types';
import type { PageElement } from '../../shared/api';

/** Messages the service worker sends to this page. */
export type ContentRequest =
  | { type: 'cs.ping' }
  | { type: 'cs.extract' }
  | { type: 'cs.highlight'; elementId: string; instruction: string; confidence: number }
  | { type: 'cs.clear' }
  | { type: 'cs.banner'; data: BannerData }
  | { type: 'cs.hideBanner' }
  | { type: 'cs.fields' }
  | { type: 'cs.insert'; fieldId: string; text: string }
  | { type: 'cs.summary' };

export interface ExtractResult {
  url: string;
  title: string;
  elements: PageElement[];
}

type Reply<T> = { ok: true; data: T } | { ok: false; error: string };

const w = window as Window & { __taskpilot?: boolean };

if (!w.__taskpilot) {
  w.__taskpilot = true;
  const reg = createRegistry();

  const reportLost = (elementId: string) =>
    void chrome.runtime.sendMessage({ type: 'content.event', event: 'highlight_lost', elementId, url: location.href }).catch(() => undefined);

  const handle = (msg: ContentRequest): unknown => {
    switch (msg.type) {
      case 'cs.ping':
        return true;
      case 'cs.extract':
        return { url: location.href, title: document.title, elements: extractElements(document, reg) } satisfies ExtractResult;
      case 'cs.highlight': {
        const el = resolve(reg, msg.elementId);
        if (!el) throw new Error('That element is no longer on the page.');
        showHighlight(el, rectOf, msg.instruction, msg.confidence, () => reportLost(msg.elementId));
        return true;
      }
      case 'cs.clear':
        clearHighlight();
        return true;
      case 'cs.banner':
        showBanner(msg.data, (action) => {
          void chrome.runtime.sendMessage({ type: 'focus.action', payload: { action } }).catch(() => undefined);
        });
        return true;
      case 'cs.hideBanner':
        hideBanner();
        return true;
      case 'cs.fields':
        return scanFields(document, reg) satisfies FormField[];
      case 'cs.insert':
        insertText(reg, msg.fieldId, msg.text);
        return true;
      case 'cs.summary':
        return pageSummary(document);
    }
  };

  chrome.runtime.onMessage.addListener((msg: ContentRequest, _sender, sendResponse) => {
    if (typeof msg?.type !== 'string' || !msg.type.startsWith('cs.')) return false;
    try {
      sendResponse({ ok: true, data: handle(msg) } satisfies Reply<unknown>);
    } catch (e) {
      sendResponse({ ok: false, error: (e as Error).message } satisfies Reply<unknown>);
    }
    return false;
  });
}
