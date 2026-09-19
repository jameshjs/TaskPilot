import { useState } from 'react';
import { rpc } from '../../shared/rpc';
import { formatAgo } from '../../shared/tabLogic';
import type { WhatWasIDoing } from '../../shared/types';
import { useAction } from '../hooks';
import { Button, Card, Chip } from '../ui';

export function WhatWasIDoingCard() {
  const { run, busy } = useAction();
  const [answer, setAnswer] = useState<WhatWasIDoing | null>(null);

  return (
    <Card
      title="What was I doing?"
      right={
        <Button variant="ghost" busy={busy === 'w'} onClick={() => void run('w', () => rpc('whatWasIDoing')).then((r) => r && setAnswer(r))}>
          {answer ? 'Refresh' : 'Ask'}
        </Button>
      }
    >
      {!answer ? (
        <p className="hint">Lost in your tabs? TaskPilot looks at your open tabs, saved sessions and recent history to tell you what you’re in the middle of.</p>
      ) : (
        <>
          <p>{answer.narrative}</p>
          <ol className="projects">
            {answer.projects.map((p, i) => (
              <li key={i}>
                <strong>{p.name}</strong>
                <div className="muted">
                  {p.tabCount} tab{p.tabCount === 1 ? '' : 's'} · Last worked on {formatAgo(p.lastActiveAt)}
                </div>
                {p.note ? <div className="hint">{p.note}</div> : null}
                {p.sessionId ? (
                  <Button variant="ghost" onClick={() => void run('r', () => rpc('session.restore', { sessionId: p.sessionId! }), () => `Resumed “${p.name}”`)}>
                    Resume
                  </Button>
                ) : null}
              </li>
            ))}
          </ol>
          {answer.source === 'offline' ? <Chip tone="muted" title="The AI backend was unreachable, so this answer comes from local data only.">offline summary</Chip> : null}
        </>
      )}
    </Card>
  );
}
