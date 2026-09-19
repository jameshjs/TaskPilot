import { useState } from 'react';
import { rpc } from '../../shared/rpc';
import { currentStepTitle, progressOf } from '../../shared/sessionLogic';
import { formatAgo } from '../../shared/tabLogic';
import type { FocusState, FormField, InputSuggestion, NavigatorResult, ResumeInfo, SessionSummary, TaskSession } from '../../shared/types';
import { useAction, useToast } from '../hooks';
import { Button, Card, Chip, Confirm, Empty, Progress } from '../ui';
import { SummaryCard } from './SummaryCard';
import { WhatWasIDoingCard } from './WhatWasIDoingCard';

interface Props {
  session: TaskSession | null;
  focus: FocusState | undefined;
  saved: TaskSession[];
  resume: ResumeInfo | null;
  dismissResume: () => void;
  finished: SessionSummary | null;
  dismissFinished: () => void;
  onRestored: (r: ResumeInfo) => void;
  onFinished: (s: SessionSummary) => void;
  goTabs: (autoOrganize: boolean) => void;
}

export function TaskView(p: Props) {
  if (!p.session) return <StartTask {...p} />;
  return <ActiveTask {...p} session={p.session} />;
}

// ── No active task ─────────────────────────────────────────────────────────

function StartTask({ saved, finished, dismissFinished, onRestored }: Props) {
  const [task, setTask] = useState('');
  const { run, busy } = useAction();
  const latest = saved.find((s) => s.status === 'saved');

  return (
    <>
      {finished ? <SummaryCard summary={finished} onClose={dismissFinished} /> : null}
      <Card title="What do you want to get done?">
        <textarea
          className="input"
          rows={3}
          placeholder="e.g. Apply to three software engineering internships"
          value={task}
          onChange={(e) => setTask(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && task.trim()) void start();
          }}
        />
        <div className="row end">
          <Button variant="primary" disabled={!task.trim()} busy={busy === 'start'} onClick={() => void start()}>
            Start task
          </Button>
        </div>
        <p className="hint">TaskPilot will plan the steps, pull the relevant tabs into a group, and keep you on track.</p>
      </Card>

      {latest ? (
        <Card title="Continue working?" tone="accent">
          <strong>{latest.title}</strong>
          <p className="muted">
            {latest.tabs.length} saved tabs · Last active: {formatAgo(latest.lastActiveAt)}
            <br />
            Progress: {progressOf(latest).done} / {progressOf(latest).total}
          </p>
          <Button
            variant="primary"
            busy={busy === 'restore'}
            onClick={() => void run('restore', () => rpc('session.restore', { sessionId: latest.sessionId }), (r) => `Restored ${r.reopened + r.reused} tabs`).then((r) => r && onRestored(r))}
          >
            Restore Session
          </Button>
        </Card>
      ) : null}

      <WhatWasIDoingCard />
    </>
  );

  async function start() {
    const s = await run('start', () => rpc('session.start', { task }), (s) => `Started “${s.title}”`);
    if (s) setTask('');
  }
}

// ── Active task ────────────────────────────────────────────────────────────

function ActiveTask({ session, focus, resume, dismissResume, onFinished, goTabs }: Props & { session: TaskSession }) {
  const { run, busy } = useAction();
  const { notify } = useToast();
  const [confirm, setConfirm] = useState<'saveClose' | 'finish' | null>(null);
  const [closeOnFinish, setCloseOnFinish] = useState(false);
  const [nav, setNav] = useState<NavigatorResult | null>(null);
  const [noteText, setNoteText] = useState('');
  const [replanNote, setReplanNote] = useState<string | null>(null);

  const { done, total } = progressOf(session);
  const step = currentStepTitle(session);
  const allDone = total > 0 && done === total;

  return (
    <>
      {resume ? (
        <Card title="You stopped here" tone="accent" right={<button className="link" onClick={dismissResume}>Dismiss</button>}>
          <strong>{resume.stoppedAt ?? 'All steps complete'}</strong>
          {resume.nextStepHint ? (
            <p className="muted">
              <b>Recommended next step:</b> {resume.nextStepHint}
            </p>
          ) : null}
          <p className="hint">
            {resume.reopened} tab{resume.reopened === 1 ? '' : 's'} reopened{resume.reused ? `, ${resume.reused} were already open` : ''}.
          </p>
        </Card>
      ) : null}

      <Card
        title={
          <>
            {session.emoji} {session.title}
          </>
        }
        right={session.paused ? <Chip tone="warn">Paused</Chip> : undefined}
      >
        <p className="task">{session.task}</p>
        <Progress done={done} total={total} />
        <FocusStatus session={session} focus={focus} />
      </Card>

      <Card title="Next action">
        {allDone ? (
          <p>🎉 Every step is done. Review your work, then finish the session.</p>
        ) : (
          <>
            <p className="step">{step ?? session.task}</p>
            <div className="row">
              <Button
                variant="primary"
                busy={busy === 'guide'}
                onClick={() => void run('guide', () => rpc('nav.guide')).then((r) => r && setNav(r))}
              >
                Guide me on this page
              </Button>
              {nav?.highlighted ? (
                <Button variant="ghost" onClick={() => void rpc('nav.clear').then(() => setNav(null))}>
                  Clear highlight
                </Button>
              ) : null}
            </div>
          </>
        )}
        {nav ? (
          <div className={`nav-result ${nav.highlighted ? 'hit' : ''}`}>
            {nav.action === 'done' ? (
              <>
                <p>✅ {nav.instruction}</p>
                {session.taskPlan[session.currentStep] ? (
                  <Button onClick={() => void run('toggle', () => rpc('session.toggleStep', { stepId: session.taskPlan[session.currentStep]!.id })).then(() => setNav(null))}>
                    Mark step done
                  </Button>
                ) : null}
              </>
            ) : (
              <>
                <p>
                  {nav.highlighted ? '→ ' : ''}
                  {nav.instruction}
                </p>
                {nav.action === 'highlight' ? <span className="hint">confidence {(nav.confidence * 100).toFixed(0)}%</span> : null}
              </>
            )}
          </div>
        ) : null}
      </Card>

      <Card
        title="Plan"
        right={
          <button className="link" onClick={() => setReplanNote(replanNote === null ? '' : null)}>
            Update plan
          </button>
        }
      >
        {replanNote !== null ? (
          <div className="stack">
            <input className="input" placeholder="What changed? (optional)" value={replanNote} onChange={(e) => setReplanNote(e.target.value)} />
            <div className="row end">
              <Button
                variant="primary"
                busy={busy === 'replan'}
                onClick={() => void run('replan', () => rpc('session.replan', { note: replanNote || undefined }), () => 'Plan updated').then(() => setReplanNote(null))}
              >
                Revise plan
              </Button>
            </div>
          </div>
        ) : null}
        {session.taskPlan.length === 0 ? (
          <Empty>No steps yet.</Empty>
        ) : (
          <ol className="steps">
            {session.taskPlan.map((s, i) => (
              <li key={s.id} className={`${s.done ? 'done' : ''} ${i === session.currentStep ? 'current' : ''}`}>
                <input type="checkbox" checked={s.done} aria-label={`Mark “${s.title}” ${s.done ? 'not done' : 'done'}`} onChange={() => void run('toggle', () => rpc('session.toggleStep', { stepId: s.id }))} />
                <button className="step-title" onClick={() => void run('step', () => rpc('session.setStep', { index: i }))} title="Make this the current step">
                  {s.title}
                </button>
              </li>
            ))}
          </ol>
        )}
      </Card>

      <Card
        title="Workspace"
        right={
          <Button variant="ghost" onClick={() => goTabs(true)}>
            ✨ Organize workspace
          </Button>
        }
      >
        <WorkspaceSummary session={session} />
      </Card>

      <InputSuggestions />

      <Card title="Notes">
        {session.notes.length ? (
          <ul className="plain notes">
            {session.notes.slice(-3).map((n, i) => (
              <li key={i}>
                <span className="hint">{formatAgo(n.at)}</span> {n.text}
              </li>
            ))}
          </ul>
        ) : null}
        <div className="row">
          <input className="input" placeholder="Jot something down…" value={noteText} onChange={(e) => setNoteText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && noteText.trim() && void addNote()} />
          <Button disabled={!noteText.trim()} onClick={() => void addNote()}>
            Add
          </Button>
        </div>
      </Card>

      <div className="footer-actions">
        <Button busy={busy === 'save'} onClick={() => void run('save', () => rpc('session.save', {}), (s) => `Saved ${s.tabs.length} tabs · ${done} / ${total} steps`)}>
          💾 Save session
        </Button>
        <Button onClick={() => setConfirm('saveClose')}>Save &amp; close tabs</Button>
        <Button onClick={() => void run('pause', () => rpc('session.pause', { paused: !session.paused }))}>{session.paused ? '▶ Resume focus' : '⏸ Pause task'}</Button>
        <Button variant="primary" onClick={() => setConfirm('finish')}>
          Finish session
        </Button>
      </div>

      {confirm === 'saveClose' ? (
        <Confirm
          title="Save and close this workspace?"
          body={`Your ${session.tabs.length || 'task'} tabs will be saved with your progress, then closed. You can restore them any time from Sessions.`}
          confirmLabel="Save & close tabs"
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            setConfirm(null);
            void run('saveClose', () => rpc('session.save', { closeTabs: true }), (s) => `Saved “${s.title}”. Restore it from Sessions.`);
          }}
        />
      ) : null}

      {confirm === 'finish' ? (
        <Confirm
          title="Finish this session?"
          body="TaskPilot will write a summary of what you did and stop tracking focus."
          confirmLabel="Finish session"
          onCancel={() => setConfirm(null)}
          extra={
            <label className="check">
              <input type="checkbox" checked={closeOnFinish} onChange={(e) => setCloseOnFinish(e.target.checked)} /> Also close this task’s tabs
            </label>
          }
          onConfirm={() => {
            setConfirm(null);
            void run('finish', () => rpc('session.finish', { closeTabs: closeOnFinish })).then((r) => r && onFinished(r.summary));
          }}
        />
      ) : null}
    </>
  );

  async function addNote() {
    await run('note', () => rpc('session.addNote', { text: noteText }));
    setNoteText('');
    notify('Note added', 'ok');
  }
}

// ── Pieces ─────────────────────────────────────────────────────────────────

function FocusStatus({ session, focus }: { session: TaskSession; focus: FocusState | undefined }) {
  const { run } = useAction();
  const status = session.paused ? 'paused' : (focus?.status ?? 'idle');

  if (status === 'paused') return <div className="focus paused">⏸ Focus paused. <button className="link" onClick={() => void run('p', () => rpc('session.pause', { paused: false }))}>Resume</button></div>;
  if (status === 'drifting') {
    const mins = focus?.driftSince ? Math.floor((Date.now() - Date.parse(focus.driftSince)) / 60_000) : 0;
    return (
      <div className="focus drifting" role="alert">
        <strong>Off task:</strong> {focus?.pageTitle ?? 'this page'} doesn’t look related.
        {mins >= 1 ? <span className="hint"> Away for {mins} min.</span> : null}
        {focus?.reason ? <div className="hint">{focus.reason}</div> : null}
        <div className="row">
          <Button variant="primary" onClick={() => void run('a', () => rpc('focus.action', { action: 'return' }))}>Return to Task</Button>
          <Button onClick={() => void run('a', () => rpc('focus.action', { action: 'relevant' }))}>This Is Relevant</Button>
          <Button variant="ghost" onClick={() => void run('a', () => rpc('focus.action', { action: 'pause' }))}>Pause Task</Button>
        </div>
      </div>
    );
  }
  if (status === 'on_task') return <div className="focus ok">✓ On task{focus?.pageTitle ? ` — ${focus.pageTitle}` : ''}</div>;
  return <div className="focus idle">Focus check runs as you browse.</div>;
}

function WorkspaceSummary({ session }: { session: TaskSession }) {
  const live = session.groupId != null && session.groupId >= 0;
  return live ? (
    <p className="muted">Relevant tabs you open are added to the <b>{session.emoji} {session.title}</b> group automatically.</p>
  ) : (
    <p className="muted">No tabs in this task yet. Open the pages you need, or organize your existing tabs — relevant ones join the task group.</p>
  );
}

function InputSuggestions() {
  const { run, busy } = useAction();
  const { notify } = useToast();
  const [fields, setFields] = useState<FormField[] | null>(null);
  const [suggestions, setSuggestions] = useState<Record<string, InputSuggestion>>({});

  return (
    <Card
      title="Suggested inputs"
      right={
        <Button variant="ghost" busy={busy === 'scan'} onClick={() => void run('scan', () => rpc('nav.scanFields')).then((f) => f && (setFields(f), setSuggestions({})))}>
          Scan this form
        </Button>
      }
    >
      {fields === null ? (
        <p className="hint">Find empty text fields on this page and draft answers. Nothing is entered until you click Insert — passwords, payment details and submit buttons are never touched.</p>
      ) : fields.length === 0 ? (
        <Empty>No empty text fields found on this page.</Empty>
      ) : (
        <ul className="plain fields">
          {fields.map((f) => {
            const s = suggestions[f.id];
            return (
              <li key={f.id}>
                <div className="field-label">{f.label}</div>
                {s ? (
                  <>
                    <textarea className="input" rows={4} value={s.suggestion} onChange={(e) => setSuggestions((m) => ({ ...m, [f.id]: { ...s, suggestion: e.target.value } }))} />
                    {s.note ? <p className="hint">{s.note}</p> : null}
                    <div className="row">
                      <Button
                        variant="primary"
                        disabled={!s.suggestion.trim()}
                        onClick={() => void run('insert', () => rpc('nav.insert', { fieldId: f.id, text: s.suggestion }), () => 'Inserted — review it, then submit yourself.')}
                      >
                        Insert
                      </Button>
                      <Button onClick={() => void navigator.clipboard.writeText(s.suggestion).then(() => notify('Copied', 'ok'))}>Copy</Button>
                      <Button variant="ghost" onClick={() => setFields((all) => all?.filter((x) => x.id !== f.id) ?? null)}>Ignore</Button>
                    </div>
                  </>
                ) : (
                  <Button busy={busy === `s${f.id}`} onClick={() => void run(`s${f.id}`, () => rpc('nav.suggest', { field: f })).then((r) => r && setSuggestions((m) => ({ ...m, [f.id]: r })))}>
                    Suggest an answer
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
