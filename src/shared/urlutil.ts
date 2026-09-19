const TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|mc_|ref$|ref_src$|igshid$|si$)/i;

export function isWebUrl(url: string | undefined): url is string {
  return !!url && /^https?:\/\//i.test(url);
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

/** Canonical form used to decide whether two tabs point at the same page. */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    u.hostname = u.hostname.replace(/^www\./, '').toLowerCase();
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS.test(key)) u.searchParams.delete(key);
    }
    u.searchParams.sort();
    let out = `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
    const qs = u.searchParams.toString();
    if (qs) out += `?${qs}`;
    return out;
  } catch {
    return url;
  }
}

/** What we are willing to send to a model: origin + path only (no query string or fragment). */
export function redactUrl(url: string, maxLen = 200): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`.slice(0, maxLen);
  } catch {
    return url.slice(0, maxLen);
  }
}

const MAIL_HOSTS: Record<string, string> = {
  'mail.google.com': 'Gmail',
  'outlook.live.com': 'Outlook',
  'outlook.office.com': 'Outlook',
  'outlook.office365.com': 'Outlook',
  'mail.yahoo.com': 'Yahoo Mail',
  'mail.proton.me': 'Proton Mail',
};

/** Mail clients put message subjects in the title; the model only needs to know it's email. */
export function redactTitle(title: string, url: string): string {
  const app = MAIL_HOSTS[hostOf(url)];
  return (app ?? title).slice(0, 160);
}

export function matchesHost(host: string, patterns: string[]): boolean {
  return patterns.some((p) => {
    const q = p.trim().toLowerCase().replace(/^www\./, '');
    return !!q && (host === q || host.endsWith(`.${q}`));
  });
}

/**
 * Does a URL match one of the user's site patterns? A pattern is a host
 * (`youtube.com`, which also covers its subdomains) optionally followed by a path
 * prefix (`reddit.com/r/memes`). The prefix has to land on a segment boundary, so
 * `reddit.com/r/memes` does not also catch `/r/memesearch`. Query strings are ignored.
 */
export function matchesUrlPattern(url: string, patterns: string[]): boolean {
  let host: string;
  let path: string;
  try {
    const u = new URL(url);
    host = u.hostname.replace(/^www\./, '').toLowerCase();
    path = u.pathname.replace(/\/+$/, '').toLowerCase();
  } catch {
    return false;
  }
  return patterns.some((raw) => {
    const q = raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
    if (!q) return false;
    const slash = q.indexOf('/');
    const qHost = slash === -1 ? q : q.slice(0, slash);
    const qPath = slash === -1 ? '' : q.slice(slash);
    if (host !== qHost && !host.endsWith(`.${qHost}`)) return false;
    return !qPath || path === qPath || path.startsWith(`${qPath}/`);
  });
}
