import type { NavigateResponse, SuggestResponse } from '../../shared/api';
import type { ExtractResult } from '../content';
import { currentStepTitle } from '../shared/sessionLogic';
import type { FormField, InputSuggestion, NavigatorResult } from '../shared/types';
import { hostOf, matchesHost, redactTitle, redactUrl } from '../shared/urlutil';
import { callApi, reportTelemetry } from './api';
import { activeTabId, toContent } from './content';
import { getActiveSession, getSettings } from './store';

const MIN_HIGHLIGHT_CONFIDENCE = 0.5;

async function requireSession() {
  const s = await getActiveSession();
  if (!s) throw new Error('Start a task first so TaskPilot knows what you are trying to do.');
  return s;
}

async function assertAllowed(url: string): Promise<void> {
  const { excludedHosts } = await getSettings();
  if (matchesHost(hostOf(url), excludedHosts)) throw new Error('This site is on your exclude list, so TaskPilot will not read it.');
}

/** Read the page, ask the Navigator for the next action, and highlight the answer. Never clicks anything. */
export async function guide(): Promise<NavigatorResult> {
  const session = await requireSession();
  const tabId = await activeTabId();
  const page = await toContent<ExtractResult>(tabId, { type: 'cs.extract' });
  await assertAllowed(page.url);

  if (page.elements.length === 0) {
    return { action: 'none', elementId: null, instruction: 'I don’t see anything to click on this page yet.', confidence: 0, highlighted: false };
  }

  const res = await callApi<NavigateResponse>('/navigate', {
    goal: session.task,
    currentStep: currentStepTitle(session) ?? session.task,
    page: { url: redactUrl(page.url), title: redactTitle(page.title, page.url) },
    elements: page.elements,
  });

  const result: NavigatorResult = { ...res, highlighted: false };
  if (res.action !== 'highlight') return result;

  // The model may only point at elements we actually sent it.
  const known = page.elements.some((e) => e.id === res.elementId);
  if (!res.elementId || !known) {
    reportTelemetry('dom_selection_failed', 'Navigator chose an element that was not on the page', { reason: 'unknown_id', host: hostOf(page.url) }, { elementId: res.elementId, offered: page.elements.length });
    return { ...result, action: 'none', elementId: null, instruction: 'I couldn’t find a reliable next click on this page.', confidence: 0 };
  }
  if (res.confidence < MIN_HIGHLIGHT_CONFIDENCE) {
    return { ...result, instruction: `${res.instruction} (I’m not sure about this one.)` };
  }

  try {
    await toContent(tabId, { type: 'cs.highlight', elementId: res.elementId, instruction: res.instruction, confidence: res.confidence });
    return { ...result, highlighted: true };
  } catch (e) {
    reportTelemetry('dom_selection_failed', 'Highlight failed', { reason: 'highlight_error', host: hostOf(page.url) }, { error: (e as Error).message });
    return { ...result, instruction: `${res.instruction} (I couldn’t highlight it — the page may have changed.)` };
  }
}

export async function clearGuide(): Promise<void> {
  const tabId = await activeTabId().catch(() => null);
  if (tabId != null) await toContent(tabId, { type: 'cs.clear' }).catch(() => undefined);
}

// ── Suggested inputs ───────────────────────────────────────────────────────

export async function scanFields(): Promise<FormField[]> {
  const tabId = await activeTabId();
  const tab = await chrome.tabs.get(tabId);
  await assertAllowed(tab.url ?? '');
  return toContent<FormField[]>(tabId, { type: 'cs.fields' });
}

export async function suggest(field: FormField): Promise<InputSuggestion> {
  const session = await requireSession();
  const tabId = await activeTabId();
  const tab = await chrome.tabs.get(tabId);
  const { profile } = await getSettings();
  const res = await callApi<SuggestResponse>('/suggest', {
    goal: session.task,
    page: { url: redactUrl(tab.url ?? ''), title: redactTitle(tab.title ?? '', tab.url ?? '') },
    field: { label: field.label, type: field.type, placeholder: field.placeholder, maxLength: field.maxLength },
    profile: profile || undefined,
  });
  return { field, suggestion: res.suggestion, note: res.note };
}

/** Only ever called from an explicit click on [Insert]. Fills one empty field; never submits. */
export async function insert(fieldId: string, text: string): Promise<void> {
  const tabId = await activeTabId();
  await toContent(tabId, { type: 'cs.insert', fieldId, text });
}
