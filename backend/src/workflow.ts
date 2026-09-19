import type { ActionPreview, ActionPreviewRequest, ReconcileRequest, ReconcileResponse, WorkflowAction } from '../../shared/api';
import { arr, ask, enumOf, num, obj, str } from './openai';
import { ComposioAdapter } from './composio';
import type { Env } from './env';
import { HttpError } from './http';
import { arrayOf, clamp01, optStr, str as reqStr } from './validate';

const DEMO_FACTS = [
  { claim: 'Authentication failure is reproducible in the browser workflow.', sources: ['Chrome tab: Auth bug report'], confidence: 0.93, status: 'confirmed' as const },
  { claim: 'Expected token refresh behavior differs between sources.', sources: ['GitHub issue #42', 'Discord discussion'], confidence: 0.84, status: 'conflicting' as const },
  { claim: 'The target repository has not been explicitly selected.', sources: ['Task context'], confidence: 0.99, status: 'missing' as const },
];
export async function integrationStatus(env: Env) { return { integrations: new ComposioAdapter(env).status() }; }
export async function connect(env: Env, body: Record<string, unknown>) {
  const integration = body.integration === 'discord' ? 'discord' : 'github';
  return { integration, ...new ComposioAdapter(env).status().find((x) => x.name === integration), authorizationUrl: env.COMPOSIO_API_KEY ? undefined : 'demo://connect' };
}
export async function reconcile(env: Env, body: Record<string, unknown>): Promise<ReconcileResponse> {
  const input = body as unknown as ReconcileRequest;
  const task = reqStr(input.task, 'task', 500);
  const tabs = arrayOf(input.tabs, 'tabs', 80, (x) => x as { id: number; title: string; url: string; summary?: string });
  if (!env.OPENAI_API_KEY) return { facts: DEMO_FACTS, conflicts: ['GitHub and Discord describe token refresh differently.'], missing: ['repository'], recommendation: 'Confirm the repository, then create a GitHub issue and notify the likely owner in Discord.', nextAction: 'ask_user', source: 'demo' };
  return ask<ReconcileResponse>(env, {
    system: 'You reconcile messy engineering context. Identify duplicates, stale claims, conflicts and missing fields. Never invent repository names, people, branches or facts. If a mutation target is ambiguous, choose ask_user.',
    user: 'Task: ' + task + '\nCurrent step: ' + (optStr(input.currentStep, 300) ?? '') + '\nNotes: ' + (optStr(input.notes, 1000) ?? '') + '\nBrowser evidence:\n' + tabs.map((t) => t.title + ' — ' + t.url + (t.summary ? ' — ' + t.summary : '')).join('\n'),
    schemaName: 'taskpilot_reconciliation',
    schema: obj({ facts: arr(obj({ claim: str(), sources: arr(str(), 6), confidence: num(), status: enumOf(['confirmed', 'conflicting', 'missing', 'stale']) }), 20), conflicts: arr(str(), 10), missing: arr(str(), 10), recommendation: str(), nextAction: enumOf(['create_issue', 'create_pull_request', 'message_person', 'ask_user']), source: enumOf(['ai', 'demo']) }),
    parse: (raw) => {
      const r = raw as Record<string, unknown>;
      return { facts: arrayOf(r.facts, 'facts', 20, (f) => { const x = f as Record<string, unknown>; return { claim: reqStr(x.claim, 'claim', 300), sources: arrayOf(x.sources, 'sources', 6, (s) => reqStr(s, 'source', 120)), confidence: clamp01(x.confidence), status: x.status === 'conflicting' || x.status === 'missing' || x.status === 'stale' ? x.status : 'confirmed' }; }), conflicts: arrayOf(r.conflicts, 'conflicts', 10, (x) => reqStr(x, 'conflict', 300)), missing: arrayOf(r.missing, 'missing', 10, (x) => reqStr(x, 'missing', 200)), recommendation: reqStr(r.recommendation, 'recommendation', 500), nextAction: (['create_issue', 'create_pull_request', 'message_person', 'ask_user'] as WorkflowAction[]).includes(r.nextAction as WorkflowAction) ? r.nextAction as WorkflowAction : 'ask_user', source: 'ai' };
    },
  });
}
export function preview(env: Env, body: Record<string, unknown>): ActionPreview {
  const input = body as unknown as ActionPreviewRequest;
  const reconciliation = input.reconciliation;
  const action = input.action ?? (reconciliation.nextAction === 'ask_user' ? 'create_issue' : reconciliation.nextAction);
  if (reconciliation.nextAction === 'ask_user' && !input.action) throw new HttpError(422, 'Resolve missing or conflicting context before creating an action preview');
  const rawFields = input.fields ?? {};
  const fields: Record<string, unknown> = { ...rawFields, evidence: reconciliation.facts, conflicts: reconciliation.conflicts };
  const provider = action === 'message_person' ? 'discord' : 'github';
  const title = String(fields.title || (action === 'message_person' ? 'TaskPilot context update' : 'Authentication workflow issue'));
  const bodyText = String(fields.body || reconciliation.recommendation);
  const now = Date.now();
  return { previewId: crypto.randomUUID(), action, provider, title, body: bodyText, target: String(fields.target || (provider === 'discord' ? 'Unresolved recipient' : 'Unresolved repository')), fields, approvalRequired: true, status: 'pending', createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 15 * 60_000).toISOString(), simulated: !env.COMPOSIO_API_KEY };
}
export async function execute(env: Env, body: Record<string, unknown>, getPreview: (id: string) => Promise<ActionPreview | null>, savePreview: (p: ActionPreview) => Promise<void>) {
  const id = reqStr(body.previewId, 'previewId', 80);
  if (body.approvalToken !== id) throw new HttpError(403, 'Approval token does not match this preview');
  const p = await getPreview(id);
  if (!p) throw new HttpError(404, 'Action preview not found');
  if (p.status !== 'pending') throw new HttpError(409, 'Preview is already ' + p.status);
  if (Date.now() > Date.parse(p.expiresAt)) throw new HttpError(410, 'Action preview expired');
  const result = await new ComposioAdapter(env).execute(p, body.sendDiscord === true);
  await savePreview(result);
  return { preview: result, simulated: result.simulated };
}
