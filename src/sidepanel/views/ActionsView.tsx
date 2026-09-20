import { useState } from 'react';
import type { ReconcileResponse, ToolDescriptor, ToolReadResponse } from '../../../shared/api';
import { rpc } from '../../shared/rpc';
import { useAction, useLoad, useToast } from '../hooks';
import { Button, Card, Chip, Confirm, Empty } from '../ui';
import { ToolResult } from './ToolResult';

/**
 * External-app actions through the Worker's Composio layer.
 *
 * Two paths on purpose: a read runs on click, a write is prepared, shown in full, and
 * runs only after the user confirms it. The pending write lives in the service worker's
 * storage, so closing the panel or switching tabs can't lose it — and can't silently
 * abandon something the user already approved.
 */
export function ActionsView() {
  const status = useLoad(() => rpc('workflow.status'), ['state']);
  const tools = useLoad(() => rpc('workflow.tools'), ['state']);
  const pending = useLoad(() => rpc('workflow.pending'), ['state']);
  const { run, busy } = useAction();
  const { notify } = useToast();

  const [reconciliation, setReconciliation] = useState<ReconcileResponse | null>(null);
  const [reading, setReading] = useState<ToolReadResponse | null>(null);
  const [draft, setDraft] = useState<{ tool: ToolDescriptor; args: Record<string, string> } | null>(null);
  const [confirming, setConfirming] = useState(false);

  const preview = pending.data ?? null;
  const all = tools.data?.tools ?? [];
  const reads = all.filter((t) => t.effect === 'read');
  const writes = all.filter((t) => t.effect === 'write');
  const connected = (status.data?.integrations ?? []).some((i) => i.status === 'connected' || i.status === 'demo');

  return (
    <div className="stack">
      <Card
        title="Connected apps"
        right={
          <Button busy={busy === 'analyze'} onClick={() => void run('analyze', () => rpc('workflow.reconcile', {}), (r) => { setReconciliation(r); return r.source === 'demo' ? 'Demo evidence loaded' : 'Context reconciled'; })}>
            Analyze task
          </Button>
        }
      >
        <div className="chips">
          {(status.data?.integrations ?? []).map((i) => (
            <Chip key={i.name} tone={i.status === 'connected' ? 'ok' : i.status === 'demo' ? 'accent' : 'muted'} title={i.scopes.join(', ')}>
              {i.name} · {i.status}
            </Chip>
          ))}
        </div>
        <div className="row">
          {(status.data?.integrations ?? [])
            .filter((i) => i.status === 'disconnected')
            .map((i) => (
              <Button key={i.name} busy={busy === `c${i.name}`} onClick={() => void run(`c${i.name}`, () => rpc('workflow.connect', { integration: i.name }), () => 'Finish sign-in in the tab that just opened')}>
                Connect {i.name}
              </Button>
            ))}
        </div>
        <p className="hint">
          Your account credentials stay with the connected-apps service — they never enter the browser. Reads run when you ask; anything that
          creates or changes something asks you first.
        </p>
      </Card>

      {reconciliation ? (
        <Card title="Task context" tone={reconciliation.conflicts.length ? 'warn' : 'ok'}>
          <p>{reconciliation.recommendation}</p>
          {reconciliation.conflicts.map((x) => <p className="error" key={x}>Conflict: {x}</p>)}
          {reconciliation.missing.map((x) => <p className="muted" key={x}>Missing: {x}</p>)}
        </Card>
      ) : null}

      <Card title="Look something up">
        {!connected ? (
          <Empty>Connect an app to run lookups.</Empty>
        ) : (
          <>
            <div className="row wrap">
              {reads.map((t) => (
                <Button key={t.slug} busy={busy === t.slug} onClick={() => void askFor(t, false)}>
                  {t.label}
                </Button>
              ))}
            </div>
            {reading ? (
              <ToolResult result={reading} />
            ) : (
              <p className="hint">Read-only — nothing is changed, so these run without asking.</p>
            )}
          </>
        )}
      </Card>

      <Card title="Make a change" tone={preview ? 'accent' : undefined}>
        {!connected ? (
          <Empty>Connect an app to prepare an action.</Empty>
        ) : preview ? (
          <>
            <Chip tone="warn">{preview.simulated ? 'Demo mode' : 'Live'} · {preview.toolSlug}</Chip>
            <h3>{preview.title}</h3>
            <p className="muted">Target: {preview.target}</p>
            {preview.body ? <p>{preview.body}</p> : null}
            <div className="row end">
              <Button variant="ghost" busy={busy === 'reject'} onClick={() => void run('reject', () => rpc('workflow.reject', { previewId: preview.previewId }), () => 'Action declined')}>
                Reject
              </Button>
              <Button variant="primary" busy={busy === 'execute'} onClick={() => setConfirming(true)}>
                Approve…
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="row wrap">
              {writes.map((t) => (
                <Button key={t.slug} onClick={() => void askFor(t, true)}>
                  {t.label}
                </Button>
              ))}
            </div>
            <p className="hint">TaskPilot prepares the exact request and shows it to you. Nothing is sent until you approve it.</p>
          </>
        )}
      </Card>

      {draft ? (
        <Card title={draft.tool.label}>
          {Object.entries(draft.tool.args).map(([name, type]) => (
            <label className="lbl" key={name}>
              {name}
              {type.endsWith('?') ? ' (optional)' : ''}
              <input
                className="input"
                value={draft.args[name] ?? ''}
                onChange={(e) => setDraft({ ...draft, args: { ...draft.args, [name]: e.target.value } })}
              />
            </label>
          ))}
          <div className="row end">
            <Button variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
            <Button variant="primary" busy={busy === draft.tool.slug || busy === 'preview'} onClick={() => void submit()}>
              {draft.tool.effect === 'read' ? 'Run' : 'Prepare action'}
            </Button>
          </div>
        </Card>
      ) : null}

      {/* The exact request, one more time, before anything leaves the machine. */}
      {confirming && preview ? (
        <Confirm
          title={preview.simulated ? `${preview.label} (demo mode)` : preview.label}
          body={
            <>
              <p>{preview.title}</p>
              {preview.body ? <p className="muted">{preview.body}</p> : null}
            </>
          }
          items={[`${preview.provider} · ${preview.target}`, ...Object.entries(preview.args).map(([k, v]) => `${k}: ${String(v).slice(0, 120)}`)]}
          confirmLabel={preview.simulated ? 'Run simulated' : 'Approve and run'}
          danger={!preview.simulated}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            void run('execute', () => rpc('workflow.execute', { previewId: preview.previewId }), (r) => (r.simulated ? 'Simulated action completed' : 'Action completed'));
          }}
        />
      ) : null}
    </div>
  );

  function askFor(tool: ToolDescriptor, _write: boolean) {
    setReading(null);
    setDraft({ tool, args: {} });
  }

  async function submit() {
    if (!draft) return;
    const args = Object.fromEntries(Object.entries(draft.args).filter(([, v]) => v.trim()));
    if (draft.tool.effect === 'read') {
      const r = await run(draft.tool.slug, () => rpc('workflow.read', { toolSlug: draft.tool.slug, args }));
      if (r) {
        setReading(r);
        setDraft(null);
      }
      return;
    }
    const p = await run('preview', () => rpc('workflow.preview', { toolSlug: draft.tool.slug, args }), () => 'Review it, then approve');
    if (p) setDraft(null);
    else notify('Could not prepare that action', 'error');
  }
}
