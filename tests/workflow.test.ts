import { describe, expect, it } from 'vitest';
import { preview, reconcile } from '../backend/src/workflow';

const env = { OPENAI_API_KEY: '', OPENAI_MODEL: 'test', ALLOWED_ORIGIN: '*', SESSIONS: {} } as never;

describe('engineering workflow', () => {
  it('returns deterministic messy demo evidence without an OpenAI key', async () => {
    const result = await reconcile(env, { task: 'Fix authentication', tabs: [{ id: 1, title: 'Auth bug report', url: 'https://github.com/acme/app/issues/42' }] });
    expect(result.source).toBe('demo');
    expect(result.nextAction).toBe('ask_user');
    expect(result.facts.some((f) => f.status === 'conflicting')).toBe(true);
  });
  it('refuses an action preview when the reconciliation is ambiguous', () => {
    expect(() => preview(env, { task: 'Fix auth', reconciliation: { facts: [], conflicts: ['two repositories'], missing: ['repository'], recommendation: 'Choose a repository', nextAction: 'ask_user' } })).toThrow('Resolve missing');
  });
  it('creates an explicit approval preview for a selected action', () => {
    const result = preview(env, { task: 'Fix auth', action: 'create_issue', reconciliation: { facts: [], conflicts: [], missing: [], recommendation: 'Create an issue', nextAction: 'ask_user' }, fields: { target: 'acme/app', title: 'Auth refresh fails', body: 'Reproduce and fix token refresh.' } });
    expect(result.provider).toBe('github');
    expect(result.approvalRequired).toBe(true);
    expect(result.simulated).toBe(true);
    expect(result.status).toBe('pending');
  });
});
