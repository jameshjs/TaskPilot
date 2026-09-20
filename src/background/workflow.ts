import { callApi, reportTelemetry } from './api';
import { getActiveSession, getPendingAction, getSettings, logEvent, setPendingAction } from './store';
import * as tabs from './tabs';
import { currentStepTitle } from '../shared/sessionLogic';
import { hostOf, matchesHost, redactTitle, redactUrl } from '../shared/urlutil';
import type {
  ActionApproveResponse,
  ActionExecuteResponse,
  ActionPreview,
  IntegrationConnectResponse,
  IntegrationName,
  IntegrationState,
  ReconcileResponse,
  ToolDescriptor,
  ToolReadResponse,
} from '../../shared/api';

/** Matches the cap the other backend callers use. */
const MAX_TABS = 80;

async function userId(): Promise<string> {
  return (await getSettings()).userId;
}

/**
 * Task context for the backend.
 *
 * Redacted and filtered like every other outbound call: query strings stripped, titles
 * cleaned, excluded hosts dropped entirely. This used to send raw titles and full URLs
 * for every tab in every window, which contradicted the promise in Settings.
 */
async function context() {
  const [session, snapshot, settings] = await Promise.all([getActiveSession(), tabs.snapshot(), getSettings()]);
  const visible = snapshot.tabs
    .filter((t) => !matchesHost(hostOf(t.url), settings.excludedHosts))
    .slice(0, MAX_TABS)
    .map((t) => ({ id: t.id, title: redactTitle(t.title, t.url), url: redactUrl(t.url) }));

  return {
    userId: settings.userId,
    task: session?.task || 'Understand my current engineering task',
    currentStep: session ? (currentStepTitle(session) ?? undefined) : undefined,
    tabs: visible,
  };
}

// ── Connections ────────────────────────────────────────────────────────────

export async function status(): Promise<{ integrations: IntegrationState[] }> {
  return callApi('/integrations/status', { userId: await userId() });
}

export async function listTools(): Promise<{ tools: ToolDescriptor[] }> {
  return callApi('/tools/list', {});
}

/**
 * Start the OAuth handshake. The extension only ever opens Composio's hosted page —
 * no provider credential passes through here.
 */
export async function connect(integration: IntegrationName): Promise<IntegrationConnectResponse> {
  const res = await callApi<IntegrationConnectResponse>('/integrations/connect', { userId: await userId(), integration });
  if (res.redirectUrl.startsWith('https://')) await chrome.tabs.create({ url: res.redirectUrl, active: true });
  return res;
}

// ── Reading ────────────────────────────────────────────────────────────────

export async function reconcile(notes?: string): Promise<ReconcileResponse> {
  return callApi('/context/reconcile', { ...(await context()), notes });
}

/** Read-only tools need no approval, so they run straight through. */
export async function read(toolSlug: string, args: Record<string, unknown>): Promise<ToolReadResponse> {
  return callApi('/tools/read', { userId: await userId(), toolSlug, args });
}

// ── Writing (approval required) ────────────────────────────────────────────

/**
 * Prepare a write and hold it where the side panel can find it again.
 *
 * Stored rather than kept in the panel's memory for the same reason as `guideTarget`:
 * the service worker is evicted freely, and the panel loses React state whenever the
 * user switches tabs.
 */
export async function preview(toolSlug: string, args: Record<string, unknown>): Promise<ActionPreview> {
  const x = await context();
  const p = await callApi<ActionPreview>('/actions/preview', { userId: x.userId, task: x.task, toolSlug, args });
  await setPendingAction(p);
  return p;
}

export async function pending(): Promise<ActionPreview | null> {
  return getPendingAction();
}

export async function reject(previewId: string): Promise<void> {
  const p = await getPendingAction();
  await callApi('/actions/reject', { userId: await userId(), previewId });
  await setPendingAction(null);
  await logEvent('action_rejected', `Declined: ${p?.label ?? 'external action'}${p?.target ? ` (${p.target})` : ''}`);
}

/**
 * Approve and run, in that order. The approval token is minted by the Worker, used
 * once, and never stored in the browser.
 */
export async function execute(previewId: string): Promise<ActionExecuteResponse> {
  const id = await userId();
  const approved = await callApi<ActionApproveResponse>('/actions/approve', { userId: id, previewId });
  try {
    const done = await callApi<ActionExecuteResponse>('/actions/execute', { userId: id, previewId, approvalToken: approved.approvalToken });
    await setPendingAction(null);
    await logEvent('action_executed', `${done.preview.label}${done.preview.target ? ` — ${done.preview.target}` : ''}${done.simulated ? ' (simulated)' : ''}`);
    return done;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    reportTelemetry('workflow_failed', 'Action execution failed', { reason: 'execute_error' }, { message });
    await setPendingAction(null); // the Worker marked it failed; a stale card would only mislead
    throw e;
  }
}
