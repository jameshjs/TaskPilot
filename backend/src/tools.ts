/**
 * The allowlist of external-app tools TaskPilot may run, and what each one costs.
 *
 * Composio exposes over a thousand tools and its API says nothing about whether any of
 * them mutates anything, so the read/write judgement has to be ours. Everything here is
 * declared by hand and anything absent is refused — a model that hallucinates a slug
 * cannot reach a provider.
 *
 * `read` runs automatically. `write` cannot run without an explicit human approval
 * recorded server-side (see workflow.execute). When in doubt a tool is a write.
 */
import type { IntegrationName } from '../../shared/api';
import { HttpError } from './http';

type ArgType = 'string' | 'string?' | 'int' | 'int?';

export interface ToolSpec {
  slug: string;
  toolkit: IntegrationName;
  effect: 'read' | 'write';
  /** Shown to the user in the confirmation, so it must describe the real-world effect. */
  label: string;
  args: Record<string, ArgType>;
  /** Filled in when the caller omits the key. For args a provider needs but a person shouldn't have to type. */
  defaults?: Record<string, string | number>;
  /**
   * Last-mile repair of argument combinations a provider rejects. Runs after validation,
   * so it only ever sees coerced values of the declared type.
   */
  normalize?: (args: Record<string, unknown>) => Record<string, unknown>;
}

const SPECS = [
  {
    slug: 'GITHUB_GET_A_REPOSITORY',
    toolkit: 'github',
    effect: 'read',
    label: 'Read a repository',
    args: { owner: 'string', repo: 'string' },
  },
  {
    slug: 'GITHUB_LIST_REPOSITORY_ISSUES',
    toolkit: 'github',
    effect: 'read',
    label: 'List repository issues',
    args: { owner: 'string', repo: 'string', state: 'string?' },
  },
  {
    slug: 'GITHUB_SEARCH_ISSUES_AND_PULL_REQUESTS',
    toolkit: 'github',
    effect: 'read',
    label: 'Search issues and pull requests',
    args: { q: 'string' },
  },
  {
    // Slugs are exact-match. Verify against `GET /v3.1/tools?toolkit_slugs=…` before a
    // live demo: a renamed slug fails closed here (400) rather than reaching Composio.
    slug: 'GOOGLECALENDAR_EVENTS_LIST',
    toolkit: 'googlecalendar',
    effect: 'read',
    label: 'List calendar events',
    args: { calendarId: 'string?', timeMin: 'string?', timeMax: 'string?', maxResults: 'int?', singleEvents: 'string?', orderBy: 'string?' },
    // Composio rejects the call outright without calendarId ("Following fields are
    // missing"), and nobody wants to type "primary" into a form to see their own diary.
    defaults: { calendarId: 'primary' },
    // Google refuses orderBy=startTime unless the recurring-event expansion is on:
    // "The requested ordering is not available for the particular query." The two are
    // not independent knobs, so don't make the caller discover that via a 502.
    normalize: (args) => (args.orderBy === 'startTime' ? { ...args, singleEvents: 'true' } : args),
  },
  {
    slug: 'GMAIL_FETCH_EMAILS',
    toolkit: 'gmail',
    effect: 'read',
    label: 'Find recent emails',
    args: { query: 'string?', max_results: 'int?' },
  },
  {
    slug: 'GITHUB_CREATE_AN_ISSUE',
    toolkit: 'github',
    effect: 'write',
    label: 'Create a GitHub issue',
    args: { owner: 'string', repo: 'string', title: 'string', body: 'string?' },
  },
  {
    slug: 'GITHUB_CREATE_AN_ISSUE_COMMENT',
    toolkit: 'github',
    effect: 'write',
    label: 'Comment on a GitHub issue',
    args: { owner: 'string', repo: 'string', issue_number: 'int', body: 'string' },
  },
] as const satisfies readonly ToolSpec[];

export const TOOLS: Record<string, ToolSpec> = Object.fromEntries(SPECS.map((s) => [s.slug, s as ToolSpec]));

/** Toolkits this release actually supports. Discord stays in the type union but ships disabled. */
export const SUPPORTED_TOOLKITS: IntegrationName[] = ['github', 'googlecalendar', 'gmail'];

export function listTools(): ToolSpec[] {
  return Object.values(TOOLS);
}

/** Resolve a slug, or refuse. Default-deny: an unlisted tool is never reachable. */
export function toolSpec(slug: unknown): ToolSpec {
  const key = typeof slug === 'string' ? slug.trim().toUpperCase() : '';
  const spec = TOOLS[key];
  if (!spec) throw new HttpError(400, 'That action is not one TaskPilot is allowed to run.');
  return spec;
}

export function toolkitName(value: unknown): IntegrationName {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!SUPPORTED_TOOLKITS.includes(v as IntegrationName)) throw new HttpError(400, 'That app is not supported yet.');
  return v as IntegrationName;
}

/**
 * Coerce the caller's arguments to exactly the declared shape.
 *
 * Unknown keys are dropped rather than passed through: whatever reaches Composio is
 * built here, so an extra field cannot ride along into a provider call.
 */
export function validateArgs(spec: ToolSpec, raw: unknown): Record<string, unknown> {
  const input = (raw ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [name, type] of Object.entries(spec.args)) {
    const supplied = input[name];
    // A default is only a fallback — an explicit value always wins.
    const value = supplied === undefined || supplied === null || supplied === '' ? spec.defaults?.[name] : supplied;
    const optional = type.endsWith('?');

    if (value === undefined || value === null || value === '') {
      if (!optional) throw new HttpError(400, `${spec.label} needs ${name}.`);
      continue;
    }

    if (type.startsWith('int')) {
      // The side panel builds arguments from text inputs, so a number always arrives as
      // a string. Rejecting "5" was a backend-shaped complaint about a UI detail.
      const n = typeof value === 'string' && /^-?\d+$/.test(value.trim()) ? Number(value.trim()) : value;
      if (typeof n !== 'number' || !Number.isInteger(n)) throw new HttpError(400, `${name} must be a whole number.`);
      out[name] = n;
    } else {
      if (typeof value !== 'string') throw new HttpError(400, `${name} must be text.`);
      const t = value.trim();
      if (!t && !optional) throw new HttpError(400, `${spec.label} needs ${name}.`);
      if (t) out[name] = t.slice(0, 8000);
    }
  }
  return spec.normalize ? spec.normalize(out) : out;
}

/** A one-line, human-readable target for the confirmation prompt. */
export function describeTarget(spec: ToolSpec, args: Record<string, unknown>): string {
  if (args.owner && args.repo) {
    const repo = `${args.owner}/${args.repo}`;
    return args.issue_number ? `${repo}#${args.issue_number}` : repo;
  }
  if (typeof args.q === 'string') return `search: ${args.q}`;
  if (typeof args.query === 'string') return `search: ${args.query}`;
  return spec.toolkit;
}
