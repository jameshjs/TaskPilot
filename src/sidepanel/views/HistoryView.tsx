import { rpc } from '../../shared/rpc';
import type { HistoryEvent } from '../../shared/types';
import { useLoad } from '../hooks';
import { Card, Empty } from '../ui';

const ICON: Record<HistoryEvent['kind'], string> = {
  session_started: '🚀', tab_added: '📑', step_done: '✅', step_undone: '↩️', plan_updated: '📝',
  drift: '🎬', returned: '🎯', session_saved: '💾', session_restored: '♻️', session_finished: '🏁',
  tabs_organized: '📁', tabs_closed: '🧹', action_executed: '⚡', action_rejected: '🚫', note: '🗒️',
};

const dayLabel = (iso: string): string => {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86400_000);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, today)) return 'Today';
  if (same(d, yesterday)) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
};

export function HistoryView() {
  const { data, error } = useLoad(() => rpc('history.list', { limit: 200 }), ['state']);
  const events = data ?? [];
  if (error) return <p className="error">{error}</p>;
  if (!events.length) return <Empty>Nothing yet. TaskPilot records meaningful task events — not your keystrokes or browsing history.</Empty>;

  const days: { day: string; items: HistoryEvent[] }[] = [];
  for (const e of events) {
    const day = dayLabel(e.at);
    const last = days[days.length - 1];
    if (last?.day === day) last.items.push(e);
    else days.push({ day, items: [e] });
  }

  return (
    <>
      {days.map((d) => (
        <Card key={d.day} title={d.day}>
          <ul className="plain timeline">
            {d.items.map((e) => (
              <li key={e.id}>
                <span className="time">{new Date(e.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>
                <span className="ic" aria-hidden>{ICON[e.kind] ?? '•'}</span>
                <span>{e.text}</span>
              </li>
            ))}
          </ul>
        </Card>
      ))}
      <p className="hint">TaskPilot records task events only.</p>
    </>
  );
}
