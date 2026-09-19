import { useEffect, useState } from 'react';
import { rpc } from '../../shared/rpc';
import type { Settings } from '../../shared/types';
import { useAction } from '../hooks';
import { Button, Card } from '../ui';

export function SettingsView({ settings, reload }: { settings: Settings | undefined; reload: () => void }) {
  const { run, busy } = useAction();
  const [draft, setDraft] = useState<Settings | null>(null);
  useEffect(() => { if (settings && !draft) setDraft(settings); }, [settings, draft]);
  if (!draft) return null;

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setDraft({ ...draft, [k]: v });
  const save = (patch: Partial<Settings>) => void run('save', () => rpc('settings.set', patch), () => 'Settings saved').then(reload);

  return (
    <>
      <Card title="Backend">
        <label className="lbl">Worker URL
          <input className="input" value={draft.apiUrl} onChange={(e) => set('apiUrl', e.target.value)} placeholder="https://taskpilot.you.workers.dev" />
        </label>
        <label className="lbl">Access token (optional)
          <input className="input" type="password" value={draft.apiToken} onChange={(e) => set('apiToken', e.target.value)} placeholder="shared secret" />
        </label>
        <p className="hint">Your OpenAI key lives on the Worker, never in the browser. Without a backend TaskPilot still groups tabs by site, tracks plans and saves sessions.</p>
        <div className="row end"><Button variant="primary" busy={busy === 'save'} onClick={() => save({ apiUrl: draft.apiUrl.trim(), apiToken: draft.apiToken.trim() })}>Save</Button></div>
      </Card>

      <Card title="Focus">
        <label className="check"><input type="checkbox" checked={draft.focusEnabled} onChange={(e) => { set('focusEnabled', e.target.checked); save({ focusEnabled: e.target.checked }); }} /> Warn me when I drift off task</label>
        <label className="check"><input type="checkbox" checked={draft.autoAddRelevantTabs} onChange={(e) => { set('autoAddRelevantTabs', e.target.checked); save({ autoAddRelevantTabs: e.target.checked }); }} /> Add relevant tabs to the task group automatically</label>
        <label className="lbl">Warn only above {Math.round(draft.driftThreshold * 100)}% confidence
          <input type="range" min={0.5} max={0.95} step={0.05} value={draft.driftThreshold} onChange={(e) => set('driftThreshold', Number(e.target.value))} onMouseUp={() => save({ driftThreshold: draft.driftThreshold })} onTouchEnd={() => save({ driftThreshold: draft.driftThreshold })} />
        </label>
      </Card>

      <Card title="About me">
        <p className="hint">Used only to draft answers for form fields you explicitly ask about.</p>
        <textarea className="input" rows={5} value={draft.profile} onChange={(e) => set('profile', e.target.value)} placeholder="e.g. 3rd-year CS student at Waterloo. Built Cairn, an AI-assisted PR triage system…" />
        <div className="row end"><Button variant="primary" onClick={() => save({ profile: draft.profile })}>Save</Button></div>
      </Card>

      <Card title="Privacy">
        <p className="hint">TaskPilot sends page titles, URLs without query strings, and a short summary of headings — never page text, form values or credentials. Sites listed here are never read or sent.</p>
        <label className="lbl">Excluded sites (one per line)
          <textarea className="input" rows={4} value={draft.excludedHosts.join('\n')} onChange={(e) => set('excludedHosts', e.target.value.split('\n').map((s) => s.trim()).filter(Boolean))} placeholder={'bank.com\nmail.google.com'} />
        </label>
        <div className="row end"><Button variant="primary" onClick={() => save({ excludedHosts: draft.excludedHosts })}>Save</Button></div>
        <label className="check"><input type="checkbox" checked={draft.syncEnabled} onChange={(e) => { set('syncEnabled', e.target.checked); save({ syncEnabled: e.target.checked }); }} /> Back up sessions to my Worker</label>
        {draft.syncEnabled ? <div className="row"><Button busy={busy === 'sync'} onClick={() => void run('sync', () => rpc('sync.now'), (r) => `Synced (${r.pushed} up, ${r.pulled} down)`)}>Sync now</Button></div> : null}
      </Card>
    </>
  );
}
