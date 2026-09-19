import { useState } from 'react';
import { rpc } from '../../shared/rpc';
import { progressOf } from '../../shared/sessionLogic';
import { formatAgo, formatDuration } from '../../shared/tabLogic';
import type { ResumeInfo, TaskSession } from '../../shared/types';
import { useAction } from '../hooks';
import { Button, Card, Chip, Confirm, Empty, Progress } from '../ui';
import { SummaryCard } from './SummaryCard';

const STATUS: Record<TaskSession['status'], { tone: 'ok' | 'accent' | 'muted' | 'warn'; label: string }> = {
  active: { tone: 'ok', label: 'Active' },
  saved: { tone: 'accent', label: 'Saved' },
  finished: { tone: 'muted', label: 'Finished' },
  archived: { tone: 'warn', label: 'Archive' },
};

export function SessionsView({ sessions, activeId, onRestored }: { sessions: TaskSession[]; activeId: string | null; onRestored: (r: ResumeInfo) => void }) {
  const { run, busy } = useAction();
  const [viewing, setViewing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<TaskSession | null>(null);

  if (!sessions.length) return <Empty>No saved sessions yet. Start a task, then use <b>Save session</b>.</Empty>;

  return (
    <>
      {sessions.map((s) => {
        const { done, total } = progressOf(s);
        const isActive = s.sessionId === activeId;
        const open = viewing === s.sessionId;
        return (
          <Card
            key={s.sessionId}
            title={<>{s.emoji} {s.title}</>}
            right={<Chip tone={isActive ? 'ok' : STATUS[s.status].tone}>{isActive ? 'Active' : STATUS[s.status].label}</Chip>}
          >
            {s.status !== 'archived' ? <p className="task">{s.task}</p> : null}
            <div className="meta-grid">
              <span>Started</span><span>{new Date(s.startedAt).toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}</span>
              <span>Tabs</span><span>{s.tabs.length}</span>
              {total ? <><span>Progress</span><span>{done} / {total}</span></> : null}
              <span>Last active</span><span>{formatAgo(s.lastActiveAt)}</span>
              {s.activeMs ? <><span>Time</span><span>{formatDuration(s.activeMs)}</span></> : null}
            </div>
            {total ? <Progress done={done} total={total} /> : null}
            {s.taskPlan[s.currentStep] && !isActive ? <p className="muted">Current step: {s.taskPlan[s.currentStep]!.title}</p> : null}
            {s.nextStepHint ? <p className="hint"><b>Next:</b> {s.nextStepHint}</p> : null}

            <div className="row wrap">
              {!isActive ? (
                <Button
                  variant="primary"
                  busy={busy === s.sessionId}
                  onClick={() => void run(s.sessionId, () => rpc('session.restore', { sessionId: s.sessionId }), (r) => `${r.reopened} reopened, ${r.reused} already open`).then((r) => r && onRestored(r))}
                >
                  {s.status === 'archived' ? 'Reopen tabs' : s.status === 'finished' ? 'Resume task' : 'Restore Session'}
                </Button>
              ) : null}
              <Button variant="ghost" onClick={() => setViewing(open ? null : s.sessionId)}>{open ? 'Hide tabs' : 'View Tabs'}</Button>
              <Button variant="danger" onClick={() => setDeleting(s)}>Delete</Button>
            </div>

            {open ? (
              <ul className="plain saved-tabs">
                {s.tabs.map((t, i) => (
                  <li key={i}>
                    <button className="tab-main" onClick={() => void chrome.tabs.create({ url: t.url })} title={t.url}>
                      <span className="ellipsis title">{t.title}</span>
                      <span className="ellipsis host">{t.url}</span>
                    </button>
                  </li>
                ))}
                {!s.tabs.length ? <Empty>No tabs were saved with this session.</Empty> : null}
              </ul>
            ) : null}

            {s.summary ? <SummaryCard summary={s.summary} /> : null}
          </Card>
        );
      })}

      {deleting ? (
        <Confirm
          title={`Delete “${deleting.title}”?`}
          body="The saved tab list, plan and progress are deleted permanently. Open tabs are not closed."
          confirmLabel="Delete session"
          danger
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const d = deleting;
            setDeleting(null);
            void run('del', () => rpc('session.delete', { sessionId: d.sessionId }), () => 'Session deleted');
          }}
        />
      ) : null}
    </>
  );
}
