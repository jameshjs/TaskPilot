import type { PlanResponse } from '../../shared/api';
import { colorFor, formatDuration } from './tabLogic';
import type { HistoryEvent, PlanStep, SessionSummary, TaskSession } from './types';

export const TASK_EMOJI = '📁';

export function newId(): string {
  return crypto.randomUUID().slice(0, 8);
}

export function sessionGroupTitle(s: Pick<TaskSession, 'emoji' | 'title'>): string {
  return `${s.emoji} ${s.title}`;
}

/** Used when the planner backend is unreachable, so starting a task never hard-fails. */
export function fallbackPlan(task: string): PlanResponse {
  const words = task.replace(/[.!?]+$/, '').split(/\s+/).slice(0, 4).join(' ');
  return {
    title: words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Task',
    steps: [
      { title: 'Clarify what "done" looks like', done: false },
      { title: 'Gather the pages and information you need', done: false },
      { title: 'Do the main work', done: false },
      { title: 'Review and finish', done: false },
    ],
  };
}

export function toSteps(plan: PlanResponse['steps']): PlanStep[] {
  return plan.map((s) => ({ id: newId(), title: s.title, done: s.done }));
}

export function createSession(task: string, plan: PlanResponse, now = new Date()): TaskSession {
  const iso = now.toISOString();
  const steps = toSteps(plan.steps);
  const s: TaskSession = {
    sessionId: crypto.randomUUID(),
    task,
    title: plan.title,
    emoji: TASK_EMOJI,
    status: 'active',
    color: colorFor(plan.title),
    tabs: [],
    taskPlan: steps,
    completedSteps: [],
    currentStep: 0,
    notes: [],
    startedAt: iso,
    lastActiveAt: iso,
    activeMs: 0,
    activeSince: iso,
    relevantUrls: [],
  };
  syncStepPointers(s);
  return s;
}

export function progressOf(s: Pick<TaskSession, 'taskPlan'>): { done: number; total: number } {
  return { done: s.taskPlan.filter((p) => p.done).length, total: s.taskPlan.length };
}

export function progressLabel(s: Pick<TaskSession, 'taskPlan'>): string {
  const { done, total } = progressOf(s);
  return `${done} / ${total}`;
}

/** Recompute completedSteps and point currentStep at the first unfinished step (or past the end when all done). */
export function syncStepPointers(s: TaskSession): void {
  s.completedSteps = s.taskPlan.filter((p) => p.done).map((p) => p.id);
  const first = s.taskPlan.findIndex((p) => !p.done);
  s.currentStep = first === -1 ? s.taskPlan.length : first;
}

export function currentStepTitle(s: Pick<TaskSession, 'taskPlan' | 'currentStep'>): string | null {
  return s.taskPlan[s.currentStep]?.title ?? null;
}

/** Keep step ids stable across a replan where the title survives, so history and UI state stay coherent. */
export function mergeReplan(existing: PlanStep[], revised: PlanResponse['steps']): PlanStep[] {
  const byTitle = new Map(existing.map((p) => [p.title.trim().toLowerCase(), p]));
  return revised.map((r) => {
    const prior = byTitle.get(r.title.trim().toLowerCase());
    return { id: prior?.id ?? newId(), title: r.title, done: r.done || prior?.done === true };
  });
}

/** Wall-clock active time including the currently running stretch. */
export function activeMsNow(s: Pick<TaskSession, 'activeMs' | 'activeSince'>, now = Date.now()): number {
  return s.activeMs + (s.activeSince ? Math.max(0, now - Date.parse(s.activeSince)) : 0);
}

export function pauseClock(s: TaskSession, now = Date.now()): void {
  s.activeMs = activeMsNow(s, now);
  s.activeSince = undefined;
}

export function buildLocalSummary(s: TaskSession, now = Date.now()): SessionSummary {
  const seen = new Set<string>();
  const important: string[] = [];
  for (const t of s.tabs) {
    const title = t.title.trim();
    if (!title || seen.has(title)) continue;
    seen.add(title);
    important.push(title);
    if (important.length === 5) break;
  }
  const next = currentStepTitle(s);
  return {
    goal: s.task,
    timeLabel: formatDuration(activeMsNow(s, now)),
    progressLabel: progressLabel(s),
    completed: s.taskPlan.filter((p) => p.done).map((p) => p.title),
    importantTabs: important,
    continueWith: next ?? 'Nothing left — review your work.',
  };
}

/** Meaningful events only, oldest first, for the "what was I doing" narrative. */
export function historyForSession(all: HistoryEvent[], sessionId: string, limit = 40): HistoryEvent[] {
  return all.filter((h) => h.sessionId === sessionId).slice(-limit);
}
