import { FOCUS_CLASSES, GROUP_COLORS, TAB_LABELS, type ClassifyResponse, type FocusResponse, type NavigateResponse, type OrganizeResponse, type PlanResponse, type SuggestResponse, type SummaryResponse, type WhatWasIDoingResponse } from '../../shared/api';
import type { Env } from './env';
import { arr, ask, bool, enumOf, int, num, obj, str } from './openai';
import { arrayOf, clamp01, oneOf, optStr, str as reqStr, tabList } from './validate';

const NEVER = `TaskPilot never submits forms, never sends messages, never makes purchases, and never enters passwords or payment details. You only observe and advise.`;

// ── Planner ────────────────────────────────────────────────────────────────

export async function plan(env: Env, body: Record<string, unknown>): Promise<PlanResponse> {
  const goal = reqStr(body.goal, 'goal', 500);
  const existing = body.existing as { steps?: { title: string; done: boolean }[] } | undefined;
  const note = optStr(body.note, 400);
  const prior = existing?.steps?.slice(0, 30) ?? [];

  // Real items read from the user's connected apps, if any were gathered.
  const context = arrayOf(body.context ?? [], 'context', 15, (x) => {
    const c = (x ?? {}) as Record<string, unknown>;
    return { source: optStr(c.source, 30) ?? '', title: optStr(c.title, 200) ?? '', detail: optStr(c.detail, 200), when: optStr(c.when, 40) };
  }).filter((c) => c.title);
  const contextBlock = context.length
    ? `\n\nContext from the user's connected apps:\n${context.map((c) => `- [${c.source}]${c.when ? ` ${c.when} ·` : ''} ${c.title}${c.detail ? ` — ${c.detail}` : ''}`).join('\n')}`
    : '';

  const user = prior.length
    ? `Goal: ${goal}\n\nCurrent plan:\n${prior.map((s, i) => `${i + 1}. [${s.done ? 'x' : ' '}] ${s.title}`).join('\n')}${note ? `\n\nWhat changed: ${note}` : ''}${contextBlock}\n\nRevise the plan. Keep completed steps and reuse the exact wording of steps that still apply.`
    : `Goal: ${goal}${contextBlock}\n\nWrite the plan.`;

  return ask<PlanResponse>(env, {
    system: `You plan browser tasks. Produce 3-8 concrete, checkable steps a person completes in a web browser, in the order they would do them.

Rules:
- A step is a visible outcome ("Complete application #1"), not an instruction to the app.
- If the goal names a count ("three internships"), give each one its own step.
- "title" is a 2-4 word workspace name for the browser tab group, e.g. "SWE Applications". No emoji.
- When revising, preserve the exact title of any step that still applies so progress is not lost, and keep done:true for finished work.
- When context from connected apps is given, ground the steps in those specific items: name the actual meeting, email or issue rather than writing a generic step. Never invent an event, message, repository or person that is not listed — if the context is thin, write ordinary steps instead.`,
    user,
    schemaName: 'task_plan',
    schema: obj({
      title: str('2-4 word workspace name, no emoji'),
      steps: arr(obj({ title: str('concrete, checkable step'), done: bool() }), 8),
    }),
    parse: (raw) => {
      const r = raw as Record<string, unknown>;
      const steps = arrayOf(r.steps, 'steps', 12, (s) => {
        const x = s as Record<string, unknown>;
        return { title: reqStr(x.title, 'step.title', 120), done: x.done === true };
      });
      if (!steps.length) throw new Error('plan has no steps');
      return { title: reqStr(r.title, 'title', 40), steps };
    },
  });
}

// ── Tab Agent: grouping ────────────────────────────────────────────────────

export async function organize(env: Env, body: Record<string, unknown>): Promise<OrganizeResponse> {
  const activeTask = optStr(body.activeTask, 300);
  const tabs = tabList(body.tabs, 'tabs');
  if (!tabs.length) return { groups: [] };

  return ask<OrganizeResponse>(env, {
    system: `You organize browser tabs into workspaces by USER INTENT, not by website.

Rules:
- Group by the project or task a tab serves. Two YouTube videos belong in different groups if one is a React tutorial for a coding project and the other is NBA highlights.
- Never group by domain alone. "GitHub", "Google", "Documentation" are bad names; "Build TaskPilot", "Datadog Interview", "CS Assignment", "Personal" are good ones.
- Name each group 1-3 words, in the user's own terms. Add one fitting emoji.
- 2-6 groups. Put every tab in exactly one group. Use "Other" only for genuine leftovers.
- If an active task is given, exactly one group covers it: set isActiveTask true on that group and no other.
- color must be one of: ${GROUP_COLORS.join(', ')}.`,
    user: `${activeTask ? `Active task: ${activeTask}\n\n` : ''}Open tabs:\n${tabs.map((t) => `#${t.id} ${t.title} — ${t.url}`).join('\n')}`,
    maxTokens: 1400,
    schemaName: 'tab_groups',
    schema: obj({
      groups: arr(
        obj({
          name: str('1-3 words naming the intent'),
          emoji: str('one emoji'),
          color: enumOf(GROUP_COLORS),
          tabIds: arr(int()),
          isActiveTask: bool('true only for the group matching the active task'),
        }),
        8,
      ),
    }),
    parse: (raw) => {
      const r = raw as Record<string, unknown>;
      let taskSeen = false;
      const groups = arrayOf(r.groups, 'groups', 10, (g) => {
        const x = g as Record<string, unknown>;
        const isActiveTask = !!activeTask && x.isActiveTask === true && !taskSeen;
        if (isActiveTask) taskSeen = true;
        return {
          name: reqStr(x.name, 'group.name', 40),
          emoji: (optStr(x.emoji, 8) ?? '📁').slice(0, 4),
          color: oneOf(x.color, GROUP_COLORS, 'grey'),
          tabIds: arrayOf(x.tabIds, 'tabIds', 200, (n) => {
            if (typeof n !== 'number' || !Number.isInteger(n)) throw new Error('tabIds must be integers');
            return n;
          }),
          isActiveTask,
        };
      });
      return { groups };
    },
  });
}

// ── Tab Agent: relevance ───────────────────────────────────────────────────

export async function classify(env: Env, body: Record<string, unknown>): Promise<ClassifyResponse> {
  const activeTask = reqStr(body.activeTask, 'activeTask', 300);
  const tabs = tabList(body.tabs, 'tabs');
  if (!tabs.length) return { tabs: [] };

  return ask<ClassifyResponse>(env, {
    system: `Label each tab by how it relates to the user's current task.

CURRENT_TASK — directly used to do this task right now.
POSSIBLY_RELATED — a general tool that might serve it (email, calendar, a notes doc, a spreadsheet).
OTHER_TASK — real work, but a different project.
DISTRACTION — entertainment or idle browsing unrelated to any work.

Judge by content and intent, never by site. A YouTube tutorial on the task's topic is CURRENT_TASK; NBA highlights are DISTRACTION. A subreddit about the task's subject is POSSIBLY_RELATED; r/memes is DISTRACTION.
Give a reason of at most 8 words. Label every tab exactly once.`,
    user: `Task: ${activeTask}\n\nTabs:\n${tabs.map((t) => `#${t.id} ${t.title} — ${t.url}${t.summary ? ` — ${t.summary}` : ''}`).join('\n')}`,
    maxTokens: 1600,
    schemaName: 'tab_labels',
    schema: obj({
      tabs: arr(obj({ id: int(), label: enumOf(TAB_LABELS), reason: str('at most 8 words') })),
    }),
    parse: (raw) => {
      const r = raw as Record<string, unknown>;
      return {
        tabs: arrayOf(r.tabs, 'tabs', 200, (t) => {
          const x = t as Record<string, unknown>;
          if (typeof x.id !== 'number') throw new Error('tab.id must be a number');
          return { id: x.id, label: oneOf(x.label, TAB_LABELS, 'OTHER_TASK'), reason: optStr(x.reason, 80) ?? '' };
        }),
      };
    },
  });
}

// ── Navigator ──────────────────────────────────────────────────────────────

export async function navigate(env: Env, body: Record<string, unknown>): Promise<NavigateResponse> {
  const goal = reqStr(body.goal, 'goal', 400);
  const currentStep = reqStr(body.currentStep, 'currentStep', 300);
  const page = (body.page ?? {}) as { url?: unknown; title?: unknown };
  const elements = arrayOf(body.elements, 'elements', 200, (e) => {
    const x = e as Record<string, unknown>;
    return {
      id: reqStr(x.id, 'element.id', 20),
      type: optStr(x.type, 20) ?? 'other',
      text: optStr(x.text, 120),
      label: optStr(x.label, 120),
      inputType: optStr(x.inputType, 20),
      required: x.required === true,
      filled: x.filled === true,
      disabled: x.disabled === true,
      sensitive: x.sensitive === true,
    };
  });
  if (!elements.length) throw new Error('no elements to consider');
  const ids = new Set(elements.map((e) => e.id));

  const describe = (e: (typeof elements)[number]) =>
    `${e.id} [${e.type}${e.inputType && e.inputType !== e.type ? `:${e.inputType}` : ''}] ${e.text ?? e.label ?? '(no label)'}` +
    `${e.required ? ' *required' : ''}${e.filled ? ' (filled)' : ''}${e.disabled ? ' (disabled)' : ''}${e.sensitive ? ' (SENSITIVE — never direct the user here)' : ''}`;

  return ask<NavigateResponse>(env, {
    system: `You guide a person through a web page toward their current step. You point; they click. ${NEVER}

Pick the ONE element that best advances the current step, and return its exact id from the list.

- action "highlight": the element to interact with next. instruction is one short imperative sentence, e.g. "Click Apply Now" or "Enter your email".
- action "done": this step already looks complete on this page (the target is filled, or a confirmation is visible).
- action "scroll": the right control is likely further down and not in the list.
- action "none": nothing here advances the step (wrong page).
- Prefer a required empty field over a submit button. Never choose a disabled or sensitive element, and never choose a final submit/pay/send control — stop at the step before and tell the user to review it themselves.
- confidence is your honest probability that this is the right next action. Below 0.5 means unsure.
- elementId must be null unless action is "highlight".`,
    user: `Goal: ${goal}\nCurrent step: ${currentStep}\nPage: ${optStr(page.title, 160) ?? ''} — ${optStr(page.url, 300) ?? ''}\n\nElements:\n${elements.map(describe).join('\n')}`,
    maxTokens: 300,
    schemaName: 'navigator_action',
    schema: obj({
      action: enumOf(['highlight', 'scroll', 'wait', 'done', 'none']),
      elementId: { type: ['string', 'null'] },
      instruction: str('one short imperative sentence'),
      confidence: num('0 to 1'),
    }),
    parse: (raw) => {
      const r = raw as Record<string, unknown>;
      const action = oneOf(r.action, ['highlight', 'scroll', 'wait', 'done', 'none'] as const, 'none');
      const elementId = typeof r.elementId === 'string' && ids.has(r.elementId) ? r.elementId : null;
      return {
        action: action === 'highlight' && !elementId ? 'none' : action,
        elementId: action === 'highlight' ? elementId : null,
        instruction: optStr(r.instruction, 200) ?? 'No clear next action on this page.',
        confidence: clamp01(r.confidence),
      };
    },
  });
}

// ── Focus Agent ────────────────────────────────────────────────────────────

export async function focus(env: Env, body: Record<string, unknown>): Promise<FocusResponse> {
  const goal = reqStr(body.goal, 'goal', 400);
  const currentStep = reqStr(body.currentStep, 'currentStep', 300);
  const page = (body.page ?? {}) as Record<string, unknown>;
  const taskTabs = arrayOf(body.taskTabs ?? [], 'taskTabs', 10, (t) => {
    const x = t as Record<string, unknown>;
    return `${optStr(x.title, 120) ?? ''} — ${optStr(x.url, 200) ?? ''}`;
  });

  return ask<FocusResponse>(env, {
    system: `Decide whether the page someone is looking at serves their current task.

RELEVANT — directly advances the task.
POSSIBLY_RELEVANT — plausibly supports it (reference material, a tool they'd use, background reading on the topic).
UNRELATED — legitimate but different work.
DISTRACTING — entertainment or idle browsing.

Judge content against intent, never the site itself: a React tutorial on YouTube is RELEVANT to "Learn React" while NBA highlights are DISTRACTING; r/chrome_extensions is POSSIBLY_RELEVANT to building an extension while r/memes is DISTRACTING.
Be conservative: when the connection is uncertain, prefer POSSIBLY_RELEVANT and low confidence. A false interruption is worse than a missed one.
reason is at most 12 words, addressed to the user.`,
    user: `Goal: ${goal}\nCurrent step: ${currentStep}\n${taskTabs.length ? `Already in this workspace:\n${taskTabs.join('\n')}\n` : ''}\nPage now: ${optStr(page.title, 160) ?? ''} — ${optStr(page.url, 300) ?? ''}${optStr(page.summary, 500) ? `\nPage summary: ${optStr(page.summary, 500)}` : ''}`,
    maxTokens: 200,
    schemaName: 'focus_check',
    schema: obj({
      classification: enumOf(FOCUS_CLASSES),
      confidence: num('0 to 1'),
      reason: str('at most 12 words'),
    }),
    parse: (raw) => {
      const r = raw as Record<string, unknown>;
      return {
        classification: oneOf(r.classification, FOCUS_CLASSES, 'POSSIBLY_RELEVANT'),
        confidence: clamp01(r.confidence),
        reason: optStr(r.reason, 120) ?? '',
      };
    },
  });
}

// ── Suggested inputs ───────────────────────────────────────────────────────

const SENSITIVE_FIELD = /(passw|card|cvv|cvc|iban|routing|ssn|social security|security code|one.?time|otp|account number)/i;

export async function suggest(env: Env, body: Record<string, unknown>): Promise<SuggestResponse> {
  const goal = reqStr(body.goal, 'goal', 400);
  const field = (body.field ?? {}) as Record<string, unknown>;
  const label = reqStr(field.label, 'field.label', 300);
  const page = (body.page ?? {}) as Record<string, unknown>;
  const profile = optStr(body.profile, 2000);
  const maxLength = typeof field.maxLength === 'number' && field.maxLength > 0 ? Math.min(field.maxLength, 5000) : undefined;

  // Refuse credentials and payment data outright — no model call.
  if (SENSITIVE_FIELD.test(label)) {
    return { suggestion: '', note: 'TaskPilot never fills passwords, payment or security fields.' };
  }

  return ask<SuggestResponse>(env, {
    system: `You draft an answer for one form field. The person reviews and edits it before anything is entered; nothing is ever submitted for them. ${NEVER}

- Write in the person's first-person voice, plain and specific. No preamble, no quotes around the answer.
- Use ONLY facts from their profile. Never invent an employer, school, date, metric or project.
- If the profile lacks what the field needs, return an empty suggestion and say what you need in "note".
- Never produce a password, payment detail, government id or security answer: return an empty suggestion with a note instead.
${maxLength ? `- Stay under ${maxLength} characters.` : '- A short paragraph at most, unless the field clearly wants an essay.'}`,
    user: `Their goal: ${goal}\nPage: ${optStr(page.title, 160) ?? ''} — ${optStr(page.url, 300) ?? ''}\nField: ${label}${optStr(field.placeholder, 200) ? `\nPlaceholder: ${optStr(field.placeholder, 200)}` : ''}\nField type: ${optStr(field.type, 30) ?? 'text'}\n\nAbout them:\n${profile || '(no profile provided)'}`,
    temperature: 0.5,
    maxTokens: 700,
    schemaName: 'input_suggestion',
    schema: obj({ suggestion: str('the drafted answer, or empty'), note: str('why it is empty, or empty string') }),
    parse: (raw) => {
      const r = raw as Record<string, unknown>;
      const suggestion = (optStr(r.suggestion, maxLength ?? 4000) ?? '').trim();
      const note = optStr(r.note, 300);
      return { suggestion, note: suggestion ? note : note ?? 'Add details to “About me” in Settings so TaskPilot can draft this.' };
    },
  });
}

// ── Summaries ──────────────────────────────────────────────────────────────

export async function summary(env: Env, body: Record<string, unknown>): Promise<SummaryResponse> {
  const task = reqStr(body.task, 'task', 400);
  const steps = arrayOf(body.steps ?? [], 'steps', 40, (s) => {
    const x = s as Record<string, unknown>;
    return { title: optStr(x.title, 200) ?? '', done: x.done === true };
  });
  const tabs = arrayOf(body.tabs ?? [], 'tabs', 40, (t) => {
    const x = t as Record<string, unknown>;
    return `${optStr(x.title, 140) ?? ''} — ${optStr(x.url, 200) ?? ''}`;
  });
  const history = arrayOf(body.history ?? [], 'history', 60, (h) => {
    const x = h as Record<string, unknown>;
    return `${optStr(x.at, 40) ?? ''} ${optStr(x.text, 200) ?? ''}`;
  });
  const currentStep = optStr(body.currentStep, 200);
  const minutes = typeof body.activeMinutes === 'number' ? Math.max(0, Math.round(body.activeMinutes)) : 0;

  return ask<SummaryResponse>(env, {
    system: `Summarize a work session for the person who did it, so they can pick it up later.

- "completed": the steps actually finished, in their own words. Only what the data shows.
- "importantTabs": up to 5 page titles worth returning to. Titles only.
- "continueWith": the next unfinished step, restated plainly.
- "nextStepHint": ONE concrete sentence naming the specific next action, e.g. "Connect chrome.tabs.query() to the tab classifier." Ground it in what they were doing. No filler.
Invent nothing.`,
    user: `Goal: ${task}\nActive time: ${minutes} minutes\nCurrent step: ${currentStep ?? '(none)'}\n\nPlan:\n${steps.map((s) => `[${s.done ? 'x' : ' '}] ${s.title}`).join('\n')}\n\nTabs:\n${tabs.join('\n')}\n\nEvents:\n${history.join('\n')}`,
    maxTokens: 700,
    schemaName: 'session_summary',
    schema: obj({
      completed: arr(str(), 12),
      importantTabs: arr(str(), 5),
      continueWith: str(),
      nextStepHint: str('one concrete sentence'),
    }),
    parse: (raw) => {
      const r = raw as Record<string, unknown>;
      const list = (v: unknown, max: number) => arrayOf(v ?? [], 'list', max, (s) => optStr(s, 200) ?? '').filter(Boolean);
      return {
        completed: list(r.completed, 12),
        importantTabs: list(r.importantTabs, 5),
        continueWith: optStr(r.continueWith, 300) ?? '',
        nextStepHint: optStr(r.nextStepHint, 300) ?? '',
      };
    },
  });
}

// ── What was I doing? ──────────────────────────────────────────────────────

export async function whatWasIDoing(env: Env, body: Record<string, unknown>): Promise<WhatWasIDoingResponse> {
  const tabs = arrayOf(body.tabs ?? [], 'tabs', 80, (t) => {
    const x = t as Record<string, unknown>;
    return `${optStr(x.title, 140) ?? ''} — ${optStr(x.url, 200) ?? ''}${optStr(x.groupTitle, 60) ? ` [group: ${optStr(x.groupTitle, 60)}]` : ''}${optStr(x.lastAccessed, 40) ? ` (last seen ${optStr(x.lastAccessed, 40)})` : ''}`;
  });
  const sessions = arrayOf(body.sessions ?? [], 'sessions', 12, (s) => {
    const x = s as Record<string, unknown>;
    return {
      id: optStr(x.id, 60) ?? '',
      line: `${optStr(x.task, 200) ?? ''} — ${optStr(x.status, 20) ?? ''}, ${optStr(x.progress, 20) ?? ''} steps, ${typeof x.tabCount === 'number' ? x.tabCount : 0} tabs, last active ${optStr(x.lastActiveAt, 40) ?? ''}${optStr(x.currentStep, 200) ? `, next: ${optStr(x.currentStep, 200)}` : ''} [id:${optStr(x.id, 60) ?? ''}]`,
    };
  });
  const history = arrayOf(body.history ?? [], 'history', 40, (h) => {
    const x = h as Record<string, unknown>;
    return `${optStr(x.at, 40) ?? ''} ${optStr(x.text, 200) ?? ''}`;
  });
  const validIds = new Set(sessions.map((s) => s.id));

  return ask<WhatWasIDoingResponse>(env, {
    system: `Someone has lost track of what they were working on. Read their open tabs, saved sessions and recent events, and tell them what they are in the middle of.

- Cluster tabs into the 2-5 real projects they represent, named by intent ("TaskPilot", "Datadog Interview", "CS Assignment"), never by site.
- Order by how recently each was worked on.
- sessionId: copy the exact [id:...] of the matching saved session, or "" if none matches.
- lastActiveAt: copy the most recent timestamp you saw for that project, or "".
- note: at most 12 words on where they left off.
- narrative: 1-2 sentences, second person, e.g. "You appear to have three active projects…". State only what the data supports.`,
    user: `Now: ${optStr(body.now, 40) ?? ''}\n\nSaved sessions:\n${sessions.map((s) => s.line).join('\n') || '(none)'}\n\nOpen tabs:\n${tabs.join('\n') || '(none)'}\n\nRecent events:\n${history.join('\n') || '(none)'}`,
    maxTokens: 900,
    schemaName: 'what_was_i_doing',
    schema: obj({
      narrative: str('1-2 sentences'),
      projects: arr(
        obj({
          name: str('project name by intent'),
          tabCount: int(),
          lastActiveAt: str('ISO timestamp or empty'),
          sessionId: str('matching saved session id, or empty'),
          note: str('at most 12 words'),
        }),
        6,
      ),
    }),
    parse: (raw) => {
      const r = raw as Record<string, unknown>;
      const projects = arrayOf(r.projects ?? [], 'projects', 8, (p) => {
        const x = p as Record<string, unknown>;
        const id = optStr(x.sessionId, 60);
        const at = optStr(x.lastActiveAt, 40);
        return {
          name: optStr(x.name, 60) ?? 'Untitled',
          tabCount: typeof x.tabCount === 'number' ? Math.max(0, Math.round(x.tabCount)) : 0,
          lastActiveAt: at && !Number.isNaN(Date.parse(at)) ? at : null,
          sessionId: id && validIds.has(id) ? id : null,
          note: optStr(x.note, 140) ?? '',
        };
      });
      return { narrative: optStr(r.narrative, 400) ?? '', projects };
    },
  });
}
