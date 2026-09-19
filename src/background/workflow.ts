import { callApi } from './api';
import { getActiveSession, getSettings } from './store';
import * as tabs from './tabs';
import type { ActionPreview, ActionExecuteResponse, IntegrationState, ReconcileResponse } from '../../shared/api';

async function context() {
  const session = await getActiveSession();
  const snapshot = await tabs.snapshot();
  return { userId: (await getSettings()).userId, task: session?.task || 'Understand my current engineering task', currentStep: session?.taskPlan[session.currentStep]?.title, tabs: snapshot.tabs.map((t) => ({ id: t.id, title: t.title, url: t.url })) };
}
export async function status(): Promise<{ integrations: IntegrationState[] }> {
  return callApi('/integrations/status', {});
}
export async function reconcile(notes?: string): Promise<ReconcileResponse> {
  return callApi('/context/reconcile', { ...(await context()), notes });
}
export async function preview(action?: ActionPreview['action'], fields?: Record<string, unknown>): Promise<ActionPreview> {
  const c = await reconcile();
  const x = await context();
  return callApi('/actions/preview', { userId: x.userId, task: x.task, reconciliation: c, action, fields });
}
export async function execute(previewId: string, sendDiscord = false): Promise<ActionExecuteResponse> {
  const x = await context();
  return callApi('/actions/execute', { userId: x.userId, previewId, approvalToken: previewId, sendDiscord });
}
