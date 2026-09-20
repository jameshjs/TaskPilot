import { useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { TabInfo } from '../shared/types';
import { hostOf } from '../shared/urlutil';
import { Icon, type IconName } from './icons';

export function Button({ variant = 'default', busy, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'danger' | 'ghost'; busy?: boolean }) {
  return (
    <button className={`btn ${variant}`} {...rest} disabled={rest.disabled || busy}>
      {busy ? <span className="spin" aria-hidden /> : null}
      {children}
    </button>
  );
}

export function Card({ title, right, children, tone }: { title?: ReactNode; right?: ReactNode; children: ReactNode; tone?: 'warn' | 'ok' | 'accent' }) {
  return (
    <section className={`card ${tone ?? ''}`}>
      {title || right ? (
        <header className="card-h">
          <h3>{title}</h3>
          {right}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export function Chip({ tone = 'muted', children, title }: { tone?: 'ok' | 'warn' | 'bad' | 'accent' | 'muted'; children: ReactNode; title?: string }) {
  return (
    <span className={`chip ${tone}`} title={title}>
      {children}
    </span>
  );
}

export function Progress({ done, total }: { done: number; total: number }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className="progress" role="progressbar" aria-valuenow={done} aria-valuemax={total} aria-label="Task progress">
      <div className="bar">
        {/* scaleX rather than width so the fill animates on the compositor. */}
        <div style={{ transform: `scaleX(${total ? done / total : 0})` }} />
      </div>
      <span>
        {done} / {total}
      </span>
    </div>
  );
}

export function Favicon({ tab }: { tab: Pick<TabInfo, 'favIconUrl' | 'url'> }) {
  const [broken, setBroken] = useState(false);
  const src = tab.favIconUrl && /^https?:|^data:/.test(tab.favIconUrl) ? tab.favIconUrl : undefined;
  if (!src || broken) return <span className="fav ph">{(hostOf(tab.url)[0] ?? '·').toUpperCase()}</span>;
  return <img className="fav" src={src} alt="" onError={() => setBroken(true)} />;
}

/**
 * Empty state: icon composition plus descriptive text, per the design spec. The icon
 * defaults to a sprout, which is the one place the biophilic motif earns its keep —
 * "nothing here yet" reads better as something waiting to grow than as an error.
 */
export function Empty({ children, icon = 'sprout' }: { children: ReactNode; icon?: IconName }) {
  return (
    <div className="empty">
      <Icon name={icon} size={28} />
      <p>{children}</p>
    </div>
  );
}

export function Confirm({
  title,
  body,
  items,
  confirmLabel,
  danger,
  onConfirm,
  onCancel,
  extra,
}: {
  title: string;
  body?: ReactNode;
  items?: string[];
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  extra?: ReactNode;
}) {
  return (
    <div className="modal-bg" onClick={onCancel} role="presentation">
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        {body ? <p>{body}</p> : null}
        {items?.length ? (
          <ul className="modal-list">
            {items.slice(0, 8).map((t, i) => (
              <li key={i}>{t}</li>
            ))}
            {items.length > 8 ? <li className="more">…and {items.length - 8} more</li> : null}
          </ul>
        ) : null}
        {extra}
        <div className="row end">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} autoFocus>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function hostLabel(url: string): string {
  return hostOf(url) || url;
}
