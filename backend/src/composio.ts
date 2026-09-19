import type { ActionPreview, IntegrationName, IntegrationState } from '../../shared/api';
import type { Env } from './env';

export class ComposioAdapter {
  constructor(private env: Env) {}
  status(): IntegrationState[] {
    const connected = !!this.env.COMPOSIO_API_KEY;
    return [
      { name: 'github', status: connected ? 'connected' : 'demo', account: connected ? undefined : 'demo-user', scopes: ['read', 'create_issue', 'create_pull_request'] },
      { name: 'discord', status: connected ? 'connected' : 'demo', account: connected ? undefined : 'demo-user', scopes: ['search', 'draft_message', 'send_message'] },
    ];
  }
  async execute(preview: ActionPreview, sendDiscord = false): Promise<ActionPreview> {
    if (!this.env.COMPOSIO_API_KEY) {
      return { ...preview, status: 'executed', simulated: true, result: { url: 'https://demo.taskpilot.local/' + preview.action + '/' + preview.previewId, message: 'Simulated action completed for demo mode.' } };
    }
    const base = this.env.COMPOSIO_BASE_URL || 'https://backend.composio.dev/api';
    const res = await fetch(base.replace(/\/$/, '') + '/actions/execute', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + this.env.COMPOSIO_API_KEY },
      body: JSON.stringify({ action: preview.action, provider: preview.provider, fields: preview.fields, send: preview.provider !== 'discord' || sendDiscord }),
    });
    if (!res.ok) throw new Error('Composio ' + res.status + ': ' + (await res.text()).slice(0, 240));
    return { ...preview, status: 'executed', simulated: false, result: await res.json() as { url?: string; message?: string } };
  }
}
export function integrationName(value: unknown): IntegrationName { return value === 'discord' ? 'discord' : 'github'; }
