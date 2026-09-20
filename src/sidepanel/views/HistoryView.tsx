import { rpc } from '../../shared/rpc';
import type { HistoryEvent } from '../../shared/types';
import { useLoad } from '../hooks';
import { Icon, type IconName } from '../icons';
import { Card, Empty } from '../ui';

/** Icons, not emoji. The set is deliberately small — fifteen event kinds map onto eight
    glyphs, because a timeline reads better when related events share a mark. */
const ICON: Record<HistoryEvent['kind'], IconName> = {
  session_started: 'sprout', tab_added: 'plus', step_done: 'check', step_undone: 'circle', plan_updated: 'leaf',
  drift: 'alert', returned: 'target', session_saved: 'archive', session_restored: 'archive', session_finished: 'check',
  tabs_organized: 'layers', tabs_closed: 'x', action_executed: 'zap', action_rejected: 'x', note: 'message',
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
                <span className="ic"><Icon name={ICON[e.kind] ?? 'circle'} size={14} /></span>
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
