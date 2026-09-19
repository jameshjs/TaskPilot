import { useState } from 'react';
import type { ActionPreview, ReconcileResponse } from '../../../shared/api';
import { rpc } from '../../shared/rpc';
import { useAction, useLoad } from '../hooks';
import { Button, Card, Chip, Empty } from '../ui';

export function ActionsView() {
  const status = useLoad(() => rpc('workflow.status'));
  const { run, busy } = useAction();
  const [reconciliation, setReconciliation] = useState<ReconcileResponse | null>(null);
  const [preview, setPreview] = useState<ActionPreview | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const analyze = () => void run('analyze', () => rpc('workflow.reconcile', {}), (r) => { setReconciliation(r); setPreview(null); return r.source === 'demo' ? 'Demo evidence loaded' : 'Context reconciled'; });
  const makePreview = (action: 'create_issue' | 'create_pull_request' | 'message_person') => void run('preview', () => rpc('workflow.preview', { action }), (p) => { setPreview(p); return 'Review the proposed action'; });
  const approve = () => preview && void run('execute', () => rpc('workflow.execute', { previewId: preview.previewId, sendDiscord: preview.provider === 'discord' }), (r) => { setPreview(r.preview); setResult(r.simulated ? 'Simulated demo action completed' : 'Action executed through Composio'); return 'Action completed'; });
  return <div className="stack">
    <Card title="Connected tools" right={<Button onClick={analyze} busy={busy === 'analyze'}>Analyze task</Button>}>
      <div className="chips">{(status.data?.integrations ?? []).map((i) => <Chip key={i.name} tone={i.status === 'connected' ? 'ok' : 'accent'}>{i.name} · {i.status}</Chip>)}</div>
      <p className="muted">GitHub and Discord actions stay behind an approval gate.</p>
    </Card>
    {reconciliation ? <Card title="Messy context" tone={reconciliation.conflicts.length ? 'warn' : 'ok'}>
      <p>{reconciliation.recommendation}</p>
      {reconciliation.conflicts.map((x) => <p className="error" key={x}>Conflict: {x}</p>)}
      {reconciliation.missing.map((x) => <p className="muted" key={x}>Missing: {x}</p>)}
      <div className="row wrap">
        <Button onClick={() => makePreview('create_issue')}>Preview GitHub issue</Button>
        <Button onClick={() => makePreview('create_pull_request')}>Preview pull request</Button>
        <Button onClick={() => makePreview('message_person')}>Preview Discord message</Button>
      </div>
    </Card> : <Empty>Analyze the active task to reconcile tabs, GitHub context, and Discord notes.</Empty>}
    {preview ? <Card title="Approval required" tone="accent">
      <Chip tone="warn">{preview.simulated ? 'Demo mode' : 'Composio'} · {preview.action}</Chip>
      <h3>{preview.title}</h3><p className="muted">Target: {preview.target}</p><p>{preview.body}</p>
      <div className="row end"><Button variant="ghost" onClick={() => setPreview(null)}>Reject</Button><Button variant="primary" onClick={approve} busy={busy === 'execute'}>Approve exact action</Button></div>
    </Card> : null}
    {result ? <Card title="Result" tone="ok"><p>{result}</p>{preview?.result?.url ? <a href={preview.result.url} target="_blank" rel="noreferrer">{preview.result.url}</a> : null}</Card> : null}
  </div>;
}
