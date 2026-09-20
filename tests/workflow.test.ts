/**
 * The external-app action layer. The property these exist to hold down: a write cannot
 * reach a provider without a human approval recorded on the server, and a tool that is
 * not on the allowlist cannot be reached at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { approve, execute, gatherContext, preview, reconcile, reject, runRead, type StoredPreview } from '../backend/src/workflow';
import { TOOLS } from '../backend/src/tools';

const demoEnv = { OPENAI_API_KEY: '', OPENAI_MODEL: 'test', ALLOWED_ORIGIN: '*', SESSIONS: {} } as never;
const liveEnv = { ...(demoEnv as object), COMPOSIO_API_KEY: 'k', COMPOSIO_BASE_URL: 'https://composio.test/api' } as never;

const USER = 'user-1';
const issueArgs = { owner: 'acme', repo: 'app', title: 'Token refresh fails', body: 'Steps to reproduce…' };

/** The Durable Object, reduced to the two calls workflow.ts actually makes. */
function store() {
  const rows = new Map<string, StoredPreview>();
  return {
    rows,
    get: async (id: string) => rows.get(id) ?? null,
    save: async (p: StoredPreview) => void rows.set(p.preview.previewId, p),
  };
}

/** Put an approved, ready-to-run write in the store and hand back its token. */
async function approved(env = demoEnv) {
  const db = store();
  const p = preview(env, { toolSlug: 'GITHUB_CREATE_AN_ISSUE', args: issueArgs });
  await db.save({ preview: p });
  const { approvalToken } = await approve(env, { previewId: p.previewId }, db.get, db.save);
  return { db, previewId: p.previewId, approvalToken };
}

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const composioOk = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ data, successful: true, log_id: 'l1' }), text: async () => '' });
/** Composio reports a connected GitHub account for the user. */
const connections = () => ({ ok: true, status: 200, json: async () => ({ items: [{ id: 'ca_1', status: 'ACTIVE', toolkit: { slug: 'github' } }] }), text: async () => '' });

describe('the tool allowlist', () => {
  it('refuses a tool it does not know, before any network call', async () => {
    await expect(runRead(demoEnv, { userId: USER, toolSlug: 'GITHUB_DELETE_A_REPOSITORY' })).rejects.toThrow(/not one TaskPilot is allowed/i);
    await expect(runRead(demoEnv, { userId: USER, toolSlug: 'anything' })).rejects.toThrow(/not one TaskPilot is allowed/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses to run a write through the read path', async () => {
    await expect(runRead(demoEnv, { userId: USER, toolSlug: 'GITHUB_CREATE_AN_ISSUE', args: issueArgs })).rejects.toThrow(/previewed and approved/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects missing and mistyped arguments', () => {
    expect(() => preview(demoEnv, { toolSlug: 'GITHUB_CREATE_AN_ISSUE', args: { owner: 'acme', repo: 'app' } })).toThrow(/needs title/i);
    expect(() => preview(demoEnv, { toolSlug: 'GITHUB_CREATE_AN_ISSUE_COMMENT', args: { owner: 'a', repo: 'b', issue_number: '12', body: 'x' } })).toThrow(/whole number/i);
  });

  it('drops arguments the tool did not declare, so nothing rides along to the provider', () => {
    const p = preview(demoEnv, { toolSlug: 'GITHUB_CREATE_AN_ISSUE', args: { ...issueArgs, assignees: ['someone'], admin: true } });
    expect(Object.keys(p.args).sort()).toEqual(['body', 'owner', 'repo', 'title']);
  });

  it('classifies every allowlisted tool as read or write', () => {
    for (const spec of Object.values(TOOLS)) expect(['read', 'write']).toContain(spec.effect);
  });
});

describe('preparing a write', () => {
  it('prepares without touching the provider', () => {
    const p = preview(demoEnv, { toolSlug: 'GITHUB_CREATE_AN_ISSUE', args: issueArgs });
    expect(p.status).toBe('pending');
    expect(p.approvalRequired).toBe(true);
    expect(p.target).toBe('acme/app');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never invents a target', () => {
    // The old implementation defaulted to the literal string 'Unresolved repository'.
    expect(() => preview(demoEnv, { toolSlug: 'GITHUB_CREATE_AN_ISSUE', args: { title: 'x' } })).toThrow(/needs owner/i);
  });
});

describe('the approval gate', () => {
  it('refuses to execute a merely-prepared action', async () => {
    const db = store();
    const p = preview(demoEnv, { toolSlug: 'GITHUB_CREATE_AN_ISSUE', args: issueArgs });
    await db.save({ preview: p });

    await expect(execute(demoEnv, { userId: USER, previewId: p.previewId, approvalToken: p.previewId }, db.get, db.save)).rejects.toThrow(/not been approved/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a token that is not the one minted at approval', async () => {
    const { db, previewId } = await approved();
    await expect(execute(demoEnv, { userId: USER, previewId, approvalToken: previewId }, db.get, db.save)).rejects.toThrow(/does not match/i);
    await expect(execute(demoEnv, { userId: USER, previewId, approvalToken: 'guessed' }, db.get, db.save)).rejects.toThrow(/does not match/i);
  });

  it('mints an unguessable token that is not the preview id', async () => {
    const { previewId, approvalToken } = await approved();
    expect(approvalToken).not.toBe(previewId);
    expect(approvalToken.length).toBeGreaterThan(16);
  });

  it('runs once the real token is presented', async () => {
    const { db, previewId, approvalToken } = await approved();
    const r = await execute(demoEnv, { userId: USER, previewId, approvalToken }, db.get, db.save);
    expect(r.preview.status).toBe('executed');
    expect(r.simulated).toBe(true);
  });

  it('will not run the same approval twice', async () => {
    const { db, previewId, approvalToken } = await approved();
    await execute(demoEnv, { userId: USER, previewId, approvalToken }, db.get, db.save);
    await expect(execute(demoEnv, { userId: USER, previewId, approvalToken }, db.get, db.save)).rejects.toThrow(/already executed/i);
  });

  it('cannot re-approve an executed action', async () => {
    const { db, previewId, approvalToken } = await approved();
    await execute(demoEnv, { userId: USER, previewId, approvalToken }, db.get, db.save);
    await expect(approve(demoEnv, { previewId }, db.get, db.save)).rejects.toThrow(/already executed/i);
  });

  it('refuses an unknown or expired preview', async () => {
    const db = store();
    await expect(execute(demoEnv, { userId: USER, previewId: 'nope', approvalToken: 't' }, db.get, db.save)).rejects.toThrow(/not found/i);

    const stale = preview(demoEnv, { toolSlug: 'GITHUB_CREATE_AN_ISSUE', args: issueArgs });
    await db.save({ preview: { ...stale, expiresAt: new Date(Date.now() - 1000).toISOString() } });
    await expect(approve(demoEnv, { previewId: stale.previewId }, db.get, db.save)).rejects.toThrow(/expired/i);
  });
});

describe('rejecting', () => {
  it('records the rejection server-side and blocks execution', async () => {
    const { db, previewId, approvalToken } = await approved();
    const r = await reject(demoEnv, { previewId }, db.get, db.save);
    expect(r.preview.status).toBe('rejected');
    await expect(execute(demoEnv, { userId: USER, previewId, approvalToken }, db.get, db.save)).rejects.toThrow(/already rejected/i);
  });
});

describe('demo mode', () => {
  it('makes no network call at all', async () => {
    const { db, previewId, approvalToken } = await approved();
    await execute(demoEnv, { userId: USER, previewId, approvalToken }, db.get, db.save);
    const read = await runRead(demoEnv, { userId: USER, toolSlug: 'GITHUB_GET_A_REPOSITORY', args: { owner: 'a', repo: 'b' } });
    expect(read.simulated).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still reconciles deterministically without an OpenAI key', async () => {
    const result = await reconcile(demoEnv, { task: 'Fix authentication', tabs: [{ id: 1, title: 'Auth bug report', url: 'https://github.com/acme/app/issues/42' }] });
    expect(result.source).toBe('demo');
    expect(result.facts.some((f) => f.status === 'conflicting')).toBe(true);
  });
});

describe('live mode', () => {
  it('sends the allowlisted slug, the user and the connected account', async () => {
    fetchMock.mockResolvedValueOnce(connections()).mockResolvedValueOnce(composioOk({ html_url: 'https://github.com/acme/app/issues/7' }));
    const { db, previewId, approvalToken } = await approved(liveEnv);

    const r = await execute(liveEnv, { userId: USER, previewId, approvalToken }, db.get, db.save);
    expect(r.simulated).toBe(false);
    expect(r.preview.result?.url).toBe('https://github.com/acme/app/issues/7');

    const [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBe('https://composio.test/api/v3/tools/execute/GITHUB_CREATE_AN_ISSUE');
    expect((init as { headers: Record<string, string> }).headers['x-api-key']).toBe('k');
    const body = JSON.parse((init as { body: string }).body);
    expect(body).toMatchObject({ user_id: USER, connected_account_id: 'ca_1', arguments: issueArgs });
  });

  it('refuses to act when the account is not connected', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ items: [] }), text: async () => '' });
    await expect(runRead(liveEnv, { userId: USER, toolSlug: 'GITHUB_GET_A_REPOSITORY', args: { owner: 'a', repo: 'b' } })).rejects.toThrow(/connect your github/i);
  });

  it('marks the action failed when the provider rejects it, so it is not retried forever', async () => {
    fetchMock.mockResolvedValueOnce(connections()).mockResolvedValueOnce({ ok: false, status: 422, json: async () => ({}), text: async () => '{"error":"secret-ish detail"}' });
    const { db, previewId, approvalToken } = await approved(liveEnv);

    await expect(execute(liveEnv, { userId: USER, previewId, approvalToken }, db.get, db.save)).rejects.toThrow();
    expect(db.rows.get(previewId)!.preview.status).toBe('failed');
    await expect(execute(liveEnv, { userId: USER, previewId, approvalToken }, db.get, db.save)).rejects.toThrow(/already failed/i);
  });

  it('never returns the provider payload to the caller', async () => {
    fetchMock.mockResolvedValueOnce(connections()).mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}), text: async () => '{"token":"ghp_verysecret"}' });
    const { db, previewId, approvalToken } = await approved(liveEnv);

    await expect(execute(liveEnv, { userId: USER, previewId, approvalToken }, db.get, db.save)).rejects.toThrow(/failed to handle that request/i);
    await expect(execute(liveEnv, { userId: USER, previewId, approvalToken }, db.get, db.save)).rejects.not.toThrow(/ghp_verysecret/);
  });
});

describe('gathering context from connected apps', () => {
  /** Composio says this toolkit is connected. */
  const connected = (slug: string) => ({ ok: true, status: 200, json: async () => ({ items: [{ id: 'ca_' + slug, status: 'ACTIVE', toolkit: { slug } }] }), text: async () => '' });
  const none = () => ({ ok: true, status: 200, json: async () => ({ items: [] }), text: async () => '' });
  const events = (n: number) => composioOk({ items: Array.from({ length: n }, (_, i) => ({ summary: `Event ${i}`, start: { dateTime: '2026-09-20T14:00:00Z' }, location: 'Zoom' })) });

  it('runs entirely on read-only tools', async () => {
    // Every tool gather uses must be effect:'read' — it executes without any approval.
    for (const slug of ['GOOGLECALENDAR_EVENTS_LIST', 'GMAIL_FETCH_EMAILS', 'GITHUB_SEARCH_ISSUES_AND_PULL_REQUESTS']) {
      expect(TOOLS[slug]?.effect).toBe('read');
    }
  });

  it('returns labelled sample context in demo mode without any network call', async () => {
    const r = await gatherContext(demoEnv, { userId: USER, task: 'Prepare for my interview' });
    expect(r.simulated).toBe(true);
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items.every((i) => i.title.startsWith('[demo]'))).toBe(true); // never passed off as real
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the sources that worked when one toolkit fails', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('connected_accounts')) return connected(new URL(url).searchParams.get('user_id') ? 'googlecalendar' : 'github');
      if (url.includes('GOOGLECALENDAR')) return events(2);
      return { ok: false, status: 500, json: async () => ({}), text: async () => 'boom' }; // gmail + github fail
    });

    const r = await gatherContext(liveEnv, { userId: USER, task: 'Prepare for my interview' });
    expect(r.sources).toEqual(['googlecalendar']);
    expect(r.items).toHaveLength(2);
    expect(r.simulated).toBe(false);
  });

  it('skips toolkits the user has not connected, without calling them', async () => {
    fetchMock.mockImplementation(async (url: string) => (url.includes('connected_accounts') ? none() : composioOk({ items: [] })));
    const r = await gatherContext(liveEnv, { userId: USER, task: 'Prepare' });
    expect(r.items).toEqual([]);
    expect(r.sources).toEqual([]);
    expect(fetchMock.mock.calls.every(([u]) => String(u).includes('connected_accounts'))).toBe(true);
  });

  it('caps how much of each source reaches the planner', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('connected_accounts')) return connected('googlecalendar');
      if (url.includes('GOOGLECALENDAR')) return events(50);
      return composioOk({ items: [] });
    });
    const r = await gatherContext(liveEnv, { userId: USER, task: 'Prepare' });
    expect(r.items.length).toBeLessThanOrEqual(5);
  });

  it('normalises a provider payload into titled items', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('connected_accounts')) return connected('googlecalendar');
      if (url.includes('GOOGLECALENDAR')) return events(1);
      return composioOk({ items: [] });
    });
    const r = await gatherContext(liveEnv, { userId: USER, task: 'Prepare' });
    expect(r.items[0]).toMatchObject({ source: 'googlecalendar', title: 'Event 0', detail: 'Zoom' });
  });

  it('survives a garbage payload rather than poisoning the plan', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('connected_accounts')) return connected('googlecalendar');
      return composioOk({ unexpected: 'shape' });
    });
    const r = await gatherContext(liveEnv, { userId: USER, task: 'Prepare' });
    expect(r.items).toEqual([]);
  });
});
