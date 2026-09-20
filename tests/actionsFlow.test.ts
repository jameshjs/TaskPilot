/**
 * External-app actions through the extension: side panel → service worker → Worker.
 *
 * The panel never holds the pending action itself, and never holds an approval token —
 * these check both, plus the privacy rules on what leaves the browser.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeChrome, type FakeChrome } from './fakeChrome';
import type { HistoryEvent } from '../src/shared/types';
import type { ActionPreview, ToolReadResponse } from '../shared/api';
import type { TaskSession } from '../src/shared/types';

let f: FakeChrome;
const rpc = <T,>(type: string, payload?: unknown) => f.rpc(type, payload) as Promise<T>;
const bodyOf = (path: string) => f.apiCalls.filter((c) => c.path === path).map((c) => c.body);
const history = () => rpc<HistoryEvent[]>('history.list', {});

const ISSUE = { owner: 'acme', repo: 'app', title: 'Token refresh fails' };

/** A prepared write, as the Worker would return it. */
const previewRow = (over: Partial<ActionPreview> = {}): ActionPreview => ({
  previewId: 'p1',
  toolSlug: 'GITHUB_CREATE_AN_ISSUE',
  effect: 'write',
  label: 'Create a GitHub issue',
  provider: 'github',
  title: ISSUE.title,
  body: '',
  target: 'acme/app',
  args: ISSUE,
  approvalRequired: true,
  status: 'pending',
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 900_000).toISOString(),
  simulated: false,
  ...over,
});

beforeEach(async () => {
  f = installFakeChrome();
  vi.resetModules();
  await import('../src/background/index');
  f.apiReplies = {
    '/integrations/status': { integrations: [{ name: 'github', status: 'connected', account: 'ca_1', scopes: [] }] },
    '/tools/list': { tools: [{ slug: 'GITHUB_CREATE_AN_ISSUE', toolkit: 'github', effect: 'write', label: 'Create a GitHub issue', args: {} }] },
    '/actions/preview': previewRow(),
    '/actions/approve': { preview: previewRow({ status: 'approved' }), approvalToken: 'server-minted-token' },
    '/actions/execute': { preview: previewRow({ status: 'executed', result: { url: 'https://github.com/acme/app/issues/7' } }), simulated: false },
    '/actions/reject': { preview: previewRow({ status: 'rejected' }) },
    '/tools/read': { toolSlug: 'GITHUB_GET_A_REPOSITORY', data: { full_name: 'acme/app' }, simulated: false },
  };
});

describe('preparing and approving a write', () => {
  it('holds the prepared action in storage, not in the panel', async () => {
    await rpc('workflow.preview', { toolSlug: 'GITHUB_CREATE_AN_ISSUE', args: ISSUE });

    // Survives the panel closing and the service worker being evicted.
    expect((f.storage.pendingAction as ActionPreview).previewId).toBe('p1');
    expect((await rpc<ActionPreview | null>('workflow.pending'))?.toolSlug).toBe('GITHUB_CREATE_AN_ISSUE');
  });

  it('approves and executes in one step, and never stores the approval token', async () => {
    await rpc('workflow.preview', { toolSlug: 'GITHUB_CREATE_AN_ISSUE', args: ISSUE });
    const r = await rpc<{ simulated: boolean }>('workflow.execute', { previewId: 'p1' });
    expect(r.simulated).toBe(false);

    // The token the Worker minted is used once, in flight, and not persisted anywhere.
    expect(bodyOf('/actions/execute')[0]!.approvalToken).toBe('server-minted-token');
    expect(JSON.stringify(f.storage)).not.toContain('server-minted-token');
    expect(f.storage.pendingAction).toBeNull();
  });

  it('records the executed action in history', async () => {
    await rpc('workflow.preview', { toolSlug: 'GITHUB_CREATE_AN_ISSUE', args: ISSUE });
    await rpc('workflow.execute', { previewId: 'p1' });
    expect((await history()).some((h) => h.kind === 'action_executed')).toBe(true);
  });

  it('cannot execute without the Worker approving first', async () => {
    await rpc('workflow.preview', { toolSlug: 'GITHUB_CREATE_AN_ISSUE', args: ISSUE });
    await rpc('workflow.execute', { previewId: 'p1' });
    // Approve is a separate server call; execute never fabricates a token.
    expect(bodyOf('/actions/approve')).toHaveLength(1);
    expect(bodyOf('/actions/execute')).toHaveLength(1);
  });
});

describe('rejecting', () => {
  it('tells the Worker and clears the pending action', async () => {
    await rpc('workflow.preview', { toolSlug: 'GITHUB_CREATE_AN_ISSUE', args: ISSUE });
    await rpc('workflow.reject', { previewId: 'p1' });

    expect(bodyOf('/actions/reject')[0]).toMatchObject({ previewId: 'p1' });
    expect(f.storage.pendingAction).toBeNull();
    expect((await history()).some((h) => h.kind === 'action_rejected')).toBe(true);
  });
});

describe('a failed execution', () => {
  it('clears the pending action rather than leaving a card that cannot be retried', async () => {
    await rpc('workflow.preview', { toolSlug: 'GITHUB_CREATE_AN_ISSUE', args: ISSUE });
    f.apiReplies['/actions/execute'] = new Error('Backend 502: provider rejected it');

    await expect(rpc('workflow.execute', { previewId: 'p1' })).rejects.toThrow();
    expect(f.storage.pendingAction).toBeNull();
  });
});

describe('reads', () => {
  it('runs without any approval step', async () => {
    const r = await rpc<ToolReadResponse>('workflow.read', { toolSlug: 'GITHUB_GET_A_REPOSITORY', args: { owner: 'acme', repo: 'app' } });
    expect(r.data).toEqual({ full_name: 'acme/app' });
    expect(bodyOf('/actions/preview')).toHaveLength(0);
    expect(bodyOf('/actions/approve')).toHaveLength(0);
    expect(f.storage.pendingAction ?? null).toBeNull();
  });
});

describe('connecting an account', () => {
  it('opens the hosted sign-in page and never sees a credential', async () => {
    f.apiReplies['/integrations/connect'] = { integration: 'github', redirectUrl: 'https://composio.test/link/abc', simulated: false };
    await rpc('workflow.connect', { integration: 'github' });

    expect(f.openedUrls).toContain('https://composio.test/link/abc');
    // Only TaskPilot's own backend settings are stored — no provider credential and no
    // Composio key ever reaches the browser.
    expect(Object.keys(f.storage)).toEqual(['settings']);
    expect(JSON.stringify(f.storage)).not.toMatch(/composio|access_token|ghp_/i);
  });

  it('does not open a non-https link', async () => {
    f.apiReplies['/integrations/connect'] = { integration: 'github', redirectUrl: 'demo://connect/github', simulated: true };
    await rpc('workflow.connect', { integration: 'github' });
    expect(f.openedUrls).toHaveLength(0);
  });
});

describe('what leaves the browser', () => {
  beforeEach(() => {
    f.tabs = [
      { id: 1, url: 'https://github.com/acme/app/issues?q=is%3Aopen+secret-query', title: 'Issues · acme/app', windowId: 10, active: true, groupId: -1 },
      { id: 2, url: 'https://mail.bank.example/inbox?token=abc123', title: 'Bank mail', windowId: 10, active: false, groupId: -1 },
    ];
  });

  it('strips query strings from the tabs it sends', async () => {
    await rpc('workflow.reconcile', {});
    const sent = JSON.stringify(bodyOf('/context/reconcile')[0]);
    expect(sent).not.toContain('secret-query');
    expect(sent).not.toContain('token=abc123');
  });

  it('drops excluded sites entirely', async () => {
    await rpc('settings.set', { excludedHosts: ['bank.example'] });
    await rpc('workflow.reconcile', {});

    const tabs = (bodyOf('/context/reconcile').at(-1) as { tabs: { url: string }[] }).tabs;
    expect(tabs.some((t) => t.url.includes('bank.example'))).toBe(false);
    expect(tabs.some((t) => t.url.includes('github.com'))).toBe(true);
  });
});

describe('starting a task with connected-app context', () => {
  it('feeds gathered items into the planner and records which apps contributed', async () => {
    f.apiReplies['/context/gather'] = {
      items: [
        { source: 'googlecalendar', title: 'Interview — Acme Corp', when: 'Tomorrow 2:00 PM' },
        { source: 'gmail', title: 'Your Acme take-home brief', detail: 'recruiting@acme.example' },
      ],
      sources: ['googlecalendar', 'gmail'],
      simulated: false,
    };

    const s = await rpc<TaskSession>('session.start', { task: 'Prepare for my interview with Acme tomorrow' });

    // The planner was given the real items, not just the sentence.
    const planBody = bodyOf('/plan')[0] as { goal: string; context?: { title: string }[] };
    expect(planBody.context?.map((c) => c.title)).toEqual(['Interview — Acme Corp', 'Your Acme take-home brief']);
    // …and the session remembers who contributed, so the UI can say so honestly.
    expect(s.contextSources).toEqual(['googlecalendar', 'gmail']);
  });

  it('still starts the task when the gather fails outright', async () => {
    f.apiReplies['/context/gather'] = new Error('Backend 502: connected-apps service failed');
    const s = await rpc<TaskSession>('session.start', { task: 'Prepare for my interview' });

    expect(s.taskPlan.length).toBeGreaterThan(0);
    expect(s.contextSources ?? []).toEqual([]);
    expect((bodyOf('/plan')[0] as { context?: unknown[] }).context).toBeUndefined();
  });

  it('claims no sources when nothing was connected', async () => {
    f.apiReplies['/context/gather'] = { items: [], sources: [], simulated: false };
    const s = await rpc<TaskSession>('session.start', { task: 'Prepare for my interview' });
    expect(s.contextSources ?? []).toEqual([]);
  });
});
