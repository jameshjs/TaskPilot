import type { SessionSummary } from '../../shared/types';
import { Icon } from '../icons';
import { Card } from '../ui';

export function SummaryCard({ summary, onClose }: { summary: SessionSummary; onClose?: () => void }) {
  return (
    <Card title="Session summary" tone="ok" right={onClose ? <button className="link" onClick={onClose}>Dismiss</button> : undefined}>
      <dl className="summary">
        <dt>Goal</dt>
        <dd>{summary.goal}</dd>
        <dt>Time</dt>
        <dd>{summary.timeLabel}</dd>
        <dt>Progress</dt>
        <dd>{summary.progressLabel} steps</dd>
        {summary.completed.length ? (
          <>
            <dt>Completed</dt>
            <dd>
              <ul className="plain">
                {summary.completed.map((c, i) => (
                  <li key={i}>
                    <Icon name="check" size={13} /> {c}
                  </li>
                ))}
              </ul>
            </dd>
          </>
        ) : null}
        {summary.importantTabs.length ? (
          <>
            <dt>Important tabs</dt>
            <dd>
              <ul className="plain">
                {summary.importantTabs.map((c, i) => (
                  <li key={i}>• {c}</li>
                ))}
              </ul>
            </dd>
          </>
        ) : null}
        <dt>Continue with</dt>
        <dd>{summary.continueWith}</dd>
      </dl>
    </Card>
  );
}
