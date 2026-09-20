/**
 * The external-app action layer. The property these exist to hold down: a write cannot
 * reach a provider without a human approval recorded on the server, and a tool that is
 * not on the allowlist cannot be reached at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { approve, connect, execute, gatherContext, integrationStatus, preview, reconcile, reject, runRead, type StoredPreview } from '../backend/src/workflow';
import { resetAuthConfigCache } from '../backend/src/composio';
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
  resetAuthConfigCache(); // per-isolate in production; per-test here
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const composioOk = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ data, successful: true, log_id: 'l1' }), text: async () => '' });
/** Composio reports a connected GitHub account for the user. `user_id` is always present on a real row. */
const connections = () => ({ ok: true, status: 200, json: async () => ({ items: [{ id: 'ca_1', status: 'ACTIVE', toolkit: { slug: 'github' }, user_id: USER }] }), text: async () => '' });

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
    expect(() => preview(demoEnv, { toolSlug: 'GITHUB_CREATE_AN_ISSUE_COMMENT', args: { owner: 'a', repo: 'b', issue_number: 'twelve', body: 'x' } })).toThrow(/whole number/i);
  });

  it('reads a whole number out of a text field, since that is all the panel can send', () => {
    // Every side-panel argument arrives as a string. Refusing "12" made commenting on an
    // issue impossible from the UI rather than enforcing anything.
    const p = preview(demoEnv, { toolSlug: 'GITHUB_CREATE_AN_ISSUE_COMMENT', args: { owner: 'a', repo: 'b', issue_number: '12', body: 'x' } });
    expect(p.args.issue_number).toBe(12);
    expect(p.target).toBe('a/b#12');
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

describe('making a lookup readable', () => {
  const calConnected = () => ({ ok: true, status: 200, json: async () => ({ items: [{ id: 'ca_cal', status: 'ACTIVE', toolkit: { slug: 'googlecalendar' }, user_id: USER }] }), text: async () => '' });
  const ghConnected = () => connections();

  it('flattens calendar events and leaves the raw payload intact', async () => {
    fetchMock.mockResolvedValueOnce(calConnected()).mockResolvedValueOnce(
      composioOk({
        summary: 'someone@example.com',
        etag: '"abc"',
        items: [{ summary: 'Interview — Acme', start: { dateTime: '2026-09-20T14:00:00Z' }, location: 'Zoom', htmlLink: 'https://calendar.google.com/x' }],
      }),
    );

    const r = await runRead(liveEnv, { userId: USER, toolSlug: 'GOOGLECALENDAR_EVENTS_LIST', args: {} });
    expect(r.items).toEqual([{ source: 'googlecalendar', title: 'Interview — Acme', when: '2026-09-20T14:00:00Z', detail: 'Zoom', url: 'https://calendar.google.com/x' }]);
    expect((r.data as { etag: string }).etag).toBe('"abc"'); // raw still available
  });

  it('never mistakes the calendar envelope for an event', async () => {
    // The envelope's own `summary` is the account address. An empty calendar must read as
    // empty, not as one event named after the user.
    fetchMock.mockResolvedValueOnce(calConnected()).mockResolvedValueOnce(composioOk({ summary: 'someone@example.com', items: [] }));

    const r = await runRead(liveEnv, { userId: USER, toolSlug: 'GOOGLECALENDAR_EVENTS_LIST', args: {} });
    expect(r.items).toEqual([]);
  });

  it('summarises a single-record read, which has no list at all', async () => {
    fetchMock.mockResolvedValueOnce(ghConnected()).mockResolvedValueOnce(
      composioOk({ full_name: 'cloudflare/workers-sdk', description: 'Home to Wrangler', stargazers_count: 4549, html_url: 'https://github.com/cloudflare/workers-sdk' }),
    );

    const r = await runRead(liveEnv, { userId: USER, toolSlug: 'GITHUB_GET_A_REPOSITORY', args: { owner: 'cloudflare', repo: 'workers-sdk' } });
    expect(r.items).toHaveLength(1);
    expect(r.items![0]).toMatchObject({ source: 'github', title: 'cloudflare/workers-sdk', detail: '★ 4549 · Home to Wrangler' });
  });

  it('leaves an unrecognisable payload to the raw view', async () => {
    fetchMock.mockResolvedValueOnce(ghConnected()).mockResolvedValueOnce(composioOk({ unexpected: 'shape' }));
    const r = await runRead(liveEnv, { userId: USER, toolSlug: 'GITHUB_GET_A_REPOSITORY', args: { owner: 'a', repo: 'b' } });
    expect(r.items).toEqual([]);
  });

  it('shows more rows than the planner keeps', async () => {
    fetchMock.mockResolvedValueOnce(calConnected()).mockResolvedValueOnce(
      composioOk({ items: Array.from({ length: 30 }, (_, i) => ({ summary: `Event ${i}`, start: { dateTime: '2026-09-20T14:00:00Z' } })) }),
    );
    const r = await runRead(liveEnv, { userId: USER, toolSlug: 'GOOGLECALENDAR_EVENTS_LIST', args: {} });
    expect(r.items).toHaveLength(25); // vs the 5 gather passes to the model
  });
});

describe('calendar arguments the provider actually accepts', () => {
  const calendarConnected = () => ({ ok: true, status: 200, json: async () => ({ items: [{ id: 'ca_cal', status: 'ACTIVE', toolkit: { slug: 'googlecalendar' }, user_id: USER }] }), text: async () => '' });
  const sentArgs = () => JSON.parse((fetchMock.mock.calls[1]![1] as { body: string }).body).arguments;

  it('supplies calendarId, which composio rejects the call without', async () => {
    fetchMock.mockResolvedValueOnce(calendarConnected()).mockResolvedValueOnce(composioOk({ items: [] }));
    await runRead(liveEnv, { userId: USER, toolSlug: 'GOOGLECALENDAR_EVENTS_LIST', args: {} });
    expect(sentArgs()).toMatchObject({ calendarId: 'primary' });
  });

  it('lets the caller override the default', async () => {
    fetchMock.mockResolvedValueOnce(calendarConnected()).mockResolvedValueOnce(composioOk({ items: [] }));
    await runRead(liveEnv, { userId: USER, toolSlug: 'GOOGLECALENDAR_EVENTS_LIST', args: { calendarId: 'work@example.com' } });
    expect(sentArgs().calendarId).toBe('work@example.com');
  });

  it('turns on singleEvents whenever ordering by start time', async () => {
    fetchMock.mockResolvedValueOnce(calendarConnected()).mockResolvedValueOnce(composioOk({ items: [] }));
    await runRead(liveEnv, { userId: USER, toolSlug: 'GOOGLECALENDAR_EVENTS_LIST', args: { orderBy: 'startTime' } });
    // Google: "The requested ordering is not available for the particular query."
    expect(sentArgs()).toMatchObject({ orderBy: 'startTime', singleEvents: 'true' });
  });

  it('accepts a whole number typed into a text field', async () => {
    fetchMock.mockResolvedValueOnce(calendarConnected()).mockResolvedValueOnce(composioOk({ items: [] }));
    await runRead(liveEnv, { userId: USER, toolSlug: 'GOOGLECALENDAR_EVENTS_LIST', args: { maxResults: '5' } });
    expect(sentArgs().maxResults).toBe(5);
  });

  it('still rejects a number that is not one', async () => {
    await expect(runRead(liveEnv, { userId: USER, toolSlug: 'GOOGLECALENDAR_EVENTS_LIST', args: { maxResults: 'five' } })).rejects.toThrow(/whole number/i);
  });
});

describe('who is to blame for a failed tool call', () => {
  const githubConnected = () => connections();
  const providerSays = (error: string) => ({ ok: true, status: 200, json: async () => ({ successful: false, error }), text: async () => '' });

  const readGithub = () => runRead(liveEnv, { userId: USER, toolSlug: 'GITHUB_GET_A_REPOSITORY', args: { owner: 'a', repo: 'b' } });

  it('blames the arguments, not the connection, for a provider 400', async () => {
    fetchMock.mockResolvedValueOnce(githubConnected()).mockResolvedValueOnce(providerSays('Failed to list events. Status: 400. Response: {"error":{"message":"The requested ordering is not available for the particular query."}}'));
    await expect(readGithub()).rejects.toThrow(/refused: The requested ordering/i);
  });

  it('treats missing fields as a caller error', async () => {
    fetchMock.mockResolvedValueOnce(githubConnected()).mockResolvedValueOnce(providerSays("Invalid request data provided\n- Following fields are missing: {'calendarId'}"));
    await expect(readGithub()).rejects.toThrow(/refused:/i);
  });

  it('asks for a reconnect when the grant is gone', async () => {
    fetchMock.mockResolvedValueOnce(githubConnected()).mockResolvedValueOnce(providerSays('Status: 401. invalid_grant'));
    await expect(readGithub()).rejects.toThrow(/needs to be renewed/i);
  });

  it('keeps a genuine provider fault a 502', async () => {
    fetchMock.mockResolvedValueOnce(githubConnected()).mockResolvedValueOnce(providerSays('Status: 500. Response: {"error":{"message":"Backend error"}}'));
    await expect(readGithub()).rejects.toThrow(/did not complete/i);
  });

  it('treats a bare "Not Found" as a typo, not a gateway failure', async () => {
    // GitHub reports a missing repo with no status code at all.
    fetchMock.mockResolvedValueOnce(githubConnected()).mockResolvedValueOnce(providerSays('Not Found'));
    await expect(readGithub()).rejects.toThrow(/refused: Not Found/i);
  });

  it('strips identifiers out of whatever the provider said', async () => {
    fetchMock.mockResolvedValueOnce(githubConnected()).mockResolvedValueOnce(providerSays('Status: 400. Response: {"error":{"message":"No access for johndoe@example.com using ghp_abcdefghijklmnop"}}'));
    await expect(readGithub()).rejects.toThrow(/\[address\]/);
    await expect(readGithub()).rejects.not.toThrow(/johndoe@example\.com|ghp_abcdefghijklmnop/);
  });
});

describe('whose account is it', () => {
  /**
   * Composio accepts `user_id` and silently ignores it, returning every account in the
   * project. This mirrors that: the mock ignores the filter exactly like the real API did.
   */
  const everyAccount = () => ({
    ok: true,
    status: 200,
    json: async () => ({
      items: [
        { id: 'ca_someone_else', status: 'ACTIVE', toolkit: { slug: 'gmail' }, user_id: 'pg-test-other-tenant' },
        { id: 'ca_mine', status: 'ACTIVE', toolkit: { slug: 'github' }, user_id: USER },
      ],
    }),
    text: async () => '',
  });

  it('asks for one user with user_ids, since user_id is ignored', async () => {
    fetchMock.mockResolvedValue(everyAccount());
    await integrationStatus(liveEnv, { userId: USER });

    const [url] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('user_ids=' + USER);
    expect(String(url)).not.toMatch(/[?&]user_id=/);
  });

  it('never reports another user\'s account as connected', async () => {
    fetchMock.mockResolvedValue(everyAccount());

    const { integrations } = await integrationStatus(liveEnv, { userId: USER });
    const gmail = integrations.find((i) => i.name === 'gmail')!;
    expect(gmail.status).toBe('disconnected');
    expect(gmail.account).toBeUndefined();
    expect(integrations.find((i) => i.name === 'github')!.status).toBe('connected');
  });

  it('will not run a tool against an account the user does not own', async () => {
    fetchMock.mockResolvedValue(everyAccount());
    await expect(runRead(liveEnv, { userId: USER, toolSlug: 'GMAIL_FETCH_EMAILS', args: {} })).rejects.toThrow(/connect your gmail/i);
    // Refused before any execute call went out.
    expect(fetchMock.mock.calls.every(([u]) => String(u).includes('connected_accounts'))).toBe(true);
  });

  it('prefers the active account when reconnecting has left expired ones behind', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        items: [
          { id: 'ca_old', status: 'EXPIRED', toolkit: { slug: 'github' }, user_id: USER },
          { id: 'ca_older', status: 'EXPIRED', toolkit: { slug: 'github' }, user_id: USER },
          { id: 'ca_live', status: 'ACTIVE', toolkit: { slug: 'github' }, user_id: USER },
        ],
      }),
      text: async () => '',
    });

    const { integrations } = await integrationStatus(liveEnv, { userId: USER });
    const github = integrations.find((i) => i.name === 'github')!;
    expect(github.status).toBe('connected');
    expect(github.account).toBe('ca_live');
  });
});

describe('starting a sign-in', () => {
  /** An enabled, Composio-managed auth config for one toolkit. */
  const authConfigs = (slug: string, id = 'ac_1', status = 'ENABLED') => ({ ok: true, status: 200, json: async () => ({ items: [{ id, status, toolkit: { slug } }] }), text: async () => '' });
  const linkOk = () => ({ ok: true, status: 200, json: async () => ({ redirect_url: 'https://connect.composio.dev/s/abc' }), text: async () => '' });

  it('addresses the auth config by id, which is what the link endpoint requires', async () => {
    fetchMock.mockResolvedValueOnce(authConfigs('github')).mockResolvedValueOnce(linkOk());

    const r = await connect(liveEnv, { userId: USER, integration: 'github' });
    expect(r.redirectUrl).toBe('https://connect.composio.dev/s/abc');
    expect(r.simulated).toBe(false);

    const [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBe('https://composio.test/api/v3.1/connected_accounts/link');
    const body = JSON.parse((init as { body: string }).body);
    expect(body).toEqual({ auth_config_id: 'ac_1', user_id: USER });
    // The old payload shape; Composio rejects it with a validation error.
    expect(body).not.toHaveProperty('toolkit_slug');
  });

  it('resolves the auth config once and reuses it', async () => {
    fetchMock.mockResolvedValueOnce(authConfigs('github')).mockResolvedValue(linkOk());

    await connect(liveEnv, { userId: USER, integration: 'github' });
    await connect(liveEnv, { userId: 'user-2', integration: 'github' });

    const lookups = fetchMock.mock.calls.filter(([u]) => String(u).includes('/auth_configs'));
    expect(lookups).toHaveLength(1);
  });

  it('says sign-in is unconfigured rather than leaking a validation failure', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ items: [] }), text: async () => '' });
    await expect(connect(liveEnv, { userId: USER, integration: 'gmail' })).rejects.toThrow(/not configured yet/i);
  });

  it('ignores a disabled auth config', async () => {
    fetchMock.mockResolvedValueOnce(authConfigs('github', 'ac_off', 'DISABLED'));
    await expect(connect(liveEnv, { userId: USER, integration: 'github' })).rejects.toThrow(/not configured yet/i);
  });

  it('never calls out in demo mode', async () => {
    const r = await connect(demoEnv, { userId: USER, integration: 'github' });
    expect(r.simulated).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('gathering context from connected apps', () => {
  /** Composio says this toolkit is connected. */
  const connected = (slug: string) => ({ ok: true, status: 200, json: async () => ({ items: [{ id: 'ca_' + slug, status: 'ACTIVE', toolkit: { slug }, user_id: USER }] }), text: async () => '' });
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

  /** All three toolkits linked; listConnections picks the row matching the one it asked about. */
  const allConnected = () => ({
    ok: true,
    status: 200,
    json: async () => ({
      items: ['github', 'googlecalendar', 'gmail'].map((slug) => ({ id: 'ca_' + slug, status: 'ACTIVE', toolkit: { slug }, user_id: USER })),
    }),
    text: async () => '',
  });

  it('keeps the sources that worked when one toolkit fails', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('connected_accounts')) return allConnected();
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
