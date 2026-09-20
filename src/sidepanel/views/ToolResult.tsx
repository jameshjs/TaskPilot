import { useState } from 'react';
import type { ContextItem, IntegrationName, ToolReadResponse } from '../../../shared/api';
import { Chip } from '../ui';

/**
 * A lookup result, as a person would want to read it.
 *
 * The panel used to print the provider's JSON straight into a <pre>, which meant the
 * answer to "what's on my calendar" was an etag and a sync token. The Worker now
 * flattens each row, so the common case is a list; raw stays one click away because a
 * shape we failed to recognise still has to be inspectable.
 */

const ICON: Record<IntegrationName, string> = { github: '🐙', googlecalendar: '📅', gmail: '✉️', discord: '💬' };

/**
 * Provider timestamps arrive in whatever format the provider likes — RFC3339, an epoch
 * in milliseconds, or a human string we should leave alone. Only reformat what parses.
 */
function when(raw: string): string {
  const epoch = /^\d{10,13}$/.test(raw) ? Number(raw.length === 10 ? raw + '000' : raw) : NaN;
  const d = new Date(Number.isNaN(epoch) ? raw : epoch);
  if (Number.isNaN(d.getTime())) return raw;

  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return `Today ${time}`;

  const tomorrow = new Date(now.getTime() + 86_400_000);
  if (d.toDateString() === tomorrow.toDateString()) return `Tomorrow ${time}`;
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`;
}

export function ToolResult({ result }: { result: ToolReadResponse }) {
  const [raw, setRaw] = useState(false);
  const items = result.items ?? [];

  return (
    <div className="tool-result">
      <div className="tool-result-h">
        <span className="hint">
          {items.length ? `${items.length} result${items.length === 1 ? '' : 's'}` : 'No rows to show'}
          {result.simulated ? ' · demo' : ''}
        </span>
        <button className="link-btn" onClick={() => setRaw(!raw)}>
          {raw ? 'Show summary' : 'Show raw'}
        </button>
      </div>

      {raw || !items.length ? (
        <pre className="result">{JSON.stringify(result.data, null, 2).slice(0, 4000)}</pre>
      ) : (
        <ul className="plain res-list">
          {items.map((it, i) => (
            <Row item={it} key={`${it.title}-${i}`} />
          ))}
        </ul>
      )}
    </div>
  );
}

function Row({ item }: { item: ContextItem }) {
  const body = (
    <>
      <div className="res-top">
        <span className="res-icon" aria-hidden>
          {ICON[item.source] ?? '•'}
        </span>
        <span className="res-title">{item.title}</span>
        {item.when ? <Chip>{when(item.when)}</Chip> : null}
      </div>
      {item.detail ? <p className="res-detail">{item.detail}</p> : null}
    </>
  );

  // rel=noreferrer as well as noopener: these URLs come from a third-party payload.
  return (
    <li className="res-row">
      {item.url && /^https:\/\//.test(item.url) ? (
        <a className="res-link" href={item.url} target="_blank" rel="noopener noreferrer">
          {body}
        </a>
      ) : (
        body
      )}
    </li>
  );
}
