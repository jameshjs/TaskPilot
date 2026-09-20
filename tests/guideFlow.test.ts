/**
 * "Guide me on this page", end to end: side panel → service worker → content script →
 * backend, through the real RPC router.
 *
 * The bug these cover: TaskPilot told the user to click something, the user clicked it,
 * and nothing happened — the click was never reported, so the plan never moved.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeChrome, type FakeChrome } from './fakeChrome';
import type { GuideTarget, HistoryEvent, NavigatorResult, TaskSession } from '../src/shared/types';

let f: FakeChrome;

const rpc = <T,>(type: string, payload?: unknown) => f.rpc(type, payload) as Promise<T>;
const guide = () => rpc<NavigatorResult>('nav.guide');
const session = () => rpc<TaskSession>('session.active');
const history = () => rpc<HistoryEvent[]>('history.list', {});
const target = () => rpc<GuideTarget | null>('nav.guideTarget');
/** The step each Navigator call was told to work on. */
const stepsAsked = () => f.apiCalls.filter((c) => c.path === '/navigate').map((c) => c.body.currentStep);

/** The user acts on the highlighted element, the way the content script reports it. */
async function userActs(elementId = 'tp-1', tabId = 1) {
  f.contentEvent(tabId, 'highlight_acted', { elementId, url: 'https://example.com/apply' });
  await f.settle();
}

beforeEach(async () => {
  f = installFakeChrome();
  vi.resetModules(); // the worker registers its listeners at import time, once per module registry
  await import('../src/background/index');
  await rpc('session.start', { task: 'Apply to an internship' });
  // The fake planner returns: Open the application / Fill in your details / Submit.
});

describe('a guide waits for the user, then advances', () => {
  it('highlights and waits — the recommendation alone changes nothing', async () => {
    const r = await guide();
    expect(r.highlighted).toBe(true);
    expect(r.awaitingAct).toBe(true);
    expect(r.stepTitle).toBe('Open the application');

    const s = await session();
    expect(s.taskPlan.some((p) => p.done)).toBe(false);
    expect(s.completedSteps).toEqual([]);
    expect(s.currentStep).toBe(0);
    expect((await target())?.elementId).toBe('tp-1');
  });

  it('completes the step when the user actually clicks the target', async () => {
    await guide();
    await userActs();

    const s = await session();
    expect(s.taskPlan[0]!.done).toBe(true);
    expect(s.completedSteps).toEqual([s.taskPlan[0]!.id]);
    expect(s.currentStep).toBe(1);
    expect(await target()).toBeNull(); // no longer waiting
  });

  it('names the step it is guiding, so the panel can tell done from stalled', async () => {
    const s = await session();
    const r = await guide();
    expect(r.stepId).toBe(s.taskPlan[0]!.id);
    expect((await target())?.stepId).toBe(s.taskPlan[0]!.id);
  });

  it('uses the next step on the next guide, not the previous instruction', async () => {
    await guide();
    await userActs();
    const second = await guide();

    expect(second.stepTitle).toBe('Fill in your details');
    expect(stepsAsked()).toEqual(['Open the application', 'Fill in your details']);
  });

  it('walks a whole plan, one click per step', async () => {
    for (const expected of ['Open the application', 'Fill in your details', 'Submit']) {
      const r = await guide();
      expect(r.stepTitle).toBe(expected);
      await userActs();
    }
    expect(stepsAsked()).toEqual(['Open the application', 'Fill in your details', 'Submit']);

    const s = await session();
    expect(s.taskPlan.every((p) => p.done)).toBe(true);
    expect(s.completedSteps).toHaveLength(3);
  });

  it('reports the completion state and stops calling the Navigator once everything is done', async () => {
    for (let i = 0; i < 3; i++) {
      await guide();
      await userActs();
    }
    const calls = stepsAsked().length;
    const after = await guide();

    expect(after.allDone).toBe(true);
    expect(after.instruction).toMatch(/every step/i);
    expect(stepsAsked()).toHaveLength(calls); // no further Navigator call
    expect(f.contentCalls.filter((c) => c.msg.type === 'cs.extract')).toHaveLength(3); // nor another page read
  });

  it('skips a current step that is already complete', async () => {
    const s = await session();
    await rpc('session.toggleStep', { stepId: s.taskPlan[0]!.id });
    await rpc('session.setStep', { index: 0 }); // clicking a finished step title leaves the pointer here
    expect((await session()).currentStep).toBe(0);

    expect((await guide()).stepTitle).toBe('Fill in your details');
    expect(stepsAsked()).toEqual(['Fill in your details']);
  });
});

describe('clicks that must not advance the plan', () => {
  const nothingHappened = async () => {
    const s = await session();
    expect(s.taskPlan.some((p) => p.done)).toBe(false);
    expect(s.completedSteps).toEqual([]);
    expect(s.currentStep).toBe(0);
  };

  it('ignores a click on some other element', async () => {
    await guide();
    await userActs('tp-2'); // the user clicked something else on the page
    await nothingHappened();
    expect((await target())?.elementId).toBe('tp-1'); // still waiting for the real one
  });

  it('ignores a click reported by a different tab', async () => {
    await guide();
    await userActs('tp-1', 77);
    await nothingHappened();
  });

  it('ignores a click when no guide is waiting', async () => {
    await userActs();
    await nothingHappened();
    expect((await history()).some((h) => h.kind === 'step_done')).toBe(false);
  });

  it('ignores a stale click after the highlight was dismissed', async () => {
    await guide();
    f.contentEvent(1, 'highlight_dismissed', { elementId: 'tp-1' });
    await f.settle();
    expect(await target()).toBeNull();

    await userActs();
    await nothingHappened();
  });

  it('ignores a click after the highlight was cleared from the side panel', async () => {
    await guide();
    await rpc('nav.clear');
    await userActs();
    await nothingHappened();
  });

  it('does not wait on anything when the Navigator finds nothing to point at', async () => {
    f.navigateQueue.push({ action: 'none', elementId: null, instruction: 'Nothing to do here', confidence: 0.2 });
    const r = await guide();
    expect(r.awaitingAct).toBe(false);
    expect(await target()).toBeNull();
    await userActs();
    await nothingHappened();
  });

  it('does not wait on a low-confidence guess', async () => {
    f.navigateQueue.push({ action: 'highlight', elementId: 'tp-1', instruction: 'Maybe this one', confidence: 0.3 });
    const r = await guide();
    expect(r.highlighted).toBe(false);
    expect(r.awaitingAct).toBe(false);
    expect(await target()).toBeNull();
    await userActs();
    await nothingHappened();
  });

  it('does not wait when the model names an element that is not on the page', async () => {
    f.navigateQueue.push({ action: 'highlight', elementId: 'tp-999', instruction: 'Click the thing', confidence: 0.95 });
    await guide();
    expect(await target()).toBeNull();
    await userActs('tp-999');
    await nothingHappened();
  });
});

describe('repeat clicks', () => {
  it('logs one completion, not two, when the same click is reported twice', async () => {
    await guide();
    await userActs();
    await userActs(); // a duplicate report, e.g. a retried message

    const completions = (await history()).filter((h) => h.kind === 'step_done');
    expect(completions).toHaveLength(1);

    const s = await session();
    expect(s.completedSteps).toEqual([s.taskPlan[0]!.id]);
    expect(s.taskPlan.filter((p) => p.done)).toHaveLength(1);
  });

  it('records one completion per step across a full plan', async () => {
    for (let i = 0; i < 3; i++) {
      await guide();
      await userActs();
    }
    const completions = (await history()).filter((h) => h.kind === 'step_done');
    expect(completions).toHaveLength(3);
    expect(new Set(completions.map((h) => h.text)).size).toBe(3);
  });
});
