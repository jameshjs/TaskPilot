import { describe, expect, it } from 'vitest';
import { buildLocalSummary, createSession, fallbackPlan, mergeReplan, nextIncompleteStep, progressLabel, syncStepPointers, activeMsNow, pauseClock } from '../src/shared/sessionLogic';

const plan = {
  title: 'SWE Applications',
  steps: ['Find positions', 'Review requirements', 'Prepare resume', 'Complete application #1'].map((title) => ({ title, done: false })),
};

describe('sessions', () => {
  it('starts at step 0 with 0 / N progress', () => {
    const s = createSession('Apply to internships', plan);
    expect(progressLabel(s)).toBe('0 / 4');
    expect(s.currentStep).toBe(0);
    expect(s.status).toBe('active');
  });

  it('advances currentStep to the first unfinished step, even out of order', () => {
    const s = createSession('t', plan);
    s.taskPlan[0]!.done = true;
    s.taskPlan[2]!.done = true;
    syncStepPointers(s);
    expect(s.currentStep).toBe(1);
    expect(s.completedSteps).toHaveLength(2);
    s.taskPlan.forEach((p) => (p.done = true));
    syncStepPointers(s);
    expect(s.currentStep).toBe(4); // past the end == all done
  });

  it('replan keeps ids and completion of steps that survive', () => {
    const s = createSession('t', plan);
    s.taskPlan[0]!.done = true;
    const merged = mergeReplan(s.taskPlan, [
      { title: 'find positions', done: false }, // case-insensitive match, model forgot done flag
      { title: 'Tailor resume', done: false },
    ]);
    expect(merged[0]!.id).toBe(s.taskPlan[0]!.id);
    expect(merged[0]!.done).toBe(true);
    expect(merged[1]!.done).toBe(false);
  });

  it('tracks active time only while the clock runs', () => {
    const s = createSession('t', plan, new Date('2026-09-19T10:00:00Z'));
    const t1 = Date.parse('2026-09-19T11:00:00Z');
    expect(activeMsNow(s, t1)).toBe(3600_000);
    pauseClock(s, t1);
    expect(activeMsNow(s, Date.parse('2026-09-20T11:00:00Z'))).toBe(3600_000);
  });

  it('builds the local summary from real state', () => {
    const s = createSession('Build TaskPilot', plan, new Date('2026-09-19T10:00:00Z'));
    s.taskPlan[0]!.done = true;
    syncStepPointers(s);
    s.tabs = [
      { url: 'https://a', title: 'Chrome Tabs API', category: 'x' },
      { url: 'https://b', title: 'Chrome Tabs API', category: 'x' },
      { url: 'https://c', title: 'OpenAI docs', category: 'x' },
    ];
    const sum = buildLocalSummary(s, Date.parse('2026-09-19T12:16:00Z'));
    expect(sum.timeLabel).toBe('2h 16m');
    expect(sum.progressLabel).toBe('1 / 4');
    expect(sum.completed).toEqual(['Find positions']);
    expect(sum.importantTabs).toEqual(['Chrome Tabs API', 'OpenAI docs']);
    expect(sum.continueWith).toBe('Review requirements');
  });

  it('fallback plan is usable', () => {
    const p = fallbackPlan('apply to three software engineering internships.');
    expect(p.title).toBe('Apply to three software');
    expect(p.steps.length).toBeGreaterThanOrEqual(3);
  });
});

describe('nextIncompleteStep', () => {
  it('picks the step the pointer is on while it is unfinished', () => {
    const s = createSession('t', plan);
    s.currentStep = 2;
    expect(nextIncompleteStep(s)?.index).toBe(2);
    expect(nextIncompleteStep(s)?.step.title).toBe('Prepare resume');
  });

  it('skips past a current step that is already done', () => {
    const s = createSession('t', plan);
    s.taskPlan[0]!.done = true;
    s.currentStep = 0; // clicking a finished step title can leave the pointer here
    expect(nextIncompleteStep(s)?.index).toBe(1);
  });

  it('finds the first unfinished step even when completions are out of order', () => {
    const s = createSession('t', plan);
    s.taskPlan[0]!.done = true;
    s.taskPlan[1]!.done = true;
    s.taskPlan[3]!.done = true;
    s.currentStep = 0;
    expect(nextIncompleteStep(s)?.step.title).toBe('Prepare resume');
  });

  it('returns null when the plan is finished, so nothing asks the Navigator again', () => {
    const s = createSession('t', plan);
    s.taskPlan.forEach((p) => (p.done = true));
    syncStepPointers(s);
    expect(nextIncompleteStep(s)).toBeNull();
  });

  it('returns null for an empty plan rather than inventing a step', () => {
    const s = createSession('t', { title: 'Empty', steps: [] });
    expect(nextIncompleteStep(s)).toBeNull();
  });
});
