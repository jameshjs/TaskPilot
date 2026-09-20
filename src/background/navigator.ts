import type { NavigateResponse, SuggestResponse } from '../../shared/api';
import type { ExtractResult } from '../content';
import { nextIncompleteStep } from '../shared/sessionLogic';
import type { FormField, InputSuggestion, NavigatorResult, PlanStep, TaskSession } from '../shared/types';
import { hostOf, matchesHost, redactTitle, redactUrl } from '../shared/urlutil';
import { callApi, reportTelemetry } from './api';
import { activeTabId, toContent } from './content';
import { completeStep } from './sessions';
import { getActiveSession, getGuideTarget, getSettings, setGuideTarget } from './store';

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

/** Shape a Navigator answer into a result. Pointing at something is never, by itself, progress. */
function partial(r: Omit<NavigatorResult, 'stepId' | 'stepTitle' | 'awaitingAct' | 'allDone'>, step: PlanStep | null): NavigatorResult {
  return { ...r, stepId: step?.id ?? null, stepTitle: step?.title ?? null, awaitingAct: false, allDone: false };
}

/**
 * Read the page and highlight the next action for one plan step. Never clicks anything.
 *
 * Split out from {@link guide} so the decision about what to do with the answer is made
 * in one place rather than at each of these early returns.
 */
async function pointAtStep(session: TaskSession, step: PlanStep, tabId: number): Promise<NavigatorResult> {
  const page = await toContent<ExtractResult>(tabId, { type: 'cs.extract' });
  await assertAllowed(page.url);

  if (page.elements.length === 0) {
    return partial({ action: 'none', elementId: null, instruction: 'I don’t see anything to click on this page yet.', confidence: 0, highlighted: false }, step);
  }

  const res = await callApi<NavigateResponse>('/navigate', {
    goal: session.task,
    currentStep: step.title,
    page: { url: redactUrl(page.url), title: redactTitle(page.title, page.url) },
    elements: page.elements,
  });

  const result = partial({ ...res, highlighted: false }, step);
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

/**
 * One press of "Guide me on this page": point at the next action for the step the user
 * is actually on, then wait.
 *
 * Pointing is a recommendation, not progress. The step is ticked off in
 * {@link onHighlightActed}, once the user really does the thing. What this records is
 * which element, in which tab, stands for which step, so that click can be matched up.
 */
export async function guide(): Promise<NavigatorResult> {
  const session = await requireSession();

  const target = nextIncompleteStep(session);
  if (!target) {
    // Nothing left to guide: don't read the page or bill a Navigator call.
    await setGuideTarget(null);
    return { action: 'done', elementId: null, instruction: 'Every step in this plan is done.', confidence: 1, highlighted: false, stepId: null, stepTitle: null, awaitingAct: false, allDone: true };
  }

  const tabId = await activeTabId();
  const result = await pointAtStep(session, target.step, tabId);
  if (!result.highlighted || !result.elementId) {
    await setGuideTarget(null); // nothing to wait for; the next press retries this step
    return result;
  }

  await setGuideTarget({ tabId, elementId: result.elementId, stepId: target.step.id, instruction: result.instruction, at: new Date().toISOString() });
  return { ...result, awaitingAct: true };
}

/**
 * The user did the thing we highlighted: tick that step off and move to the next one.
 *
 * This is the only path by which guidance completes a step. The click is matched against
 * the recorded target, so a click on another element, in another tab, or left over from
 * an older highlight cannot advance the plan.
 */
export async function onHighlightActed(tabId: number, elementId: string): Promise<void> {
  const target = await getGuideTarget();
  if (!target || target.tabId !== tabId || target.elementId !== elementId) return;
  await setGuideTarget(null);
  await completeStep(target.stepId);
}

/** The highlight was dismissed or vanished: stop waiting on it, but change nothing else. */
export async function onHighlightGone(tabId: number, elementId: string): Promise<void> {
  const target = await getGuideTarget();
  if (!target || target.tabId !== tabId || target.elementId !== elementId) return;
  await setGuideTarget(null);
}

/** What the current highlight is waiting for, if anything. */
export async function guideTarget(): Promise<import('../shared/types').GuideTarget | null> {
  return getGuideTarget();
}

export async function clearGuide(): Promise<void> {
  await setGuideTarget(null);
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
