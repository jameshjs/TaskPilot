/**
 * External-app actions: discover, prepare, approve, run.
 *
 * The rule the whole module exists to enforce: a `read` tool runs on request, a `write`
 * tool cannot run until a human has approved that exact prepared action and the server
 * has recorded it. Approval is a secret this Worker generates — not, as before, the
 * preview id echoed back to itself.
 */
import type {
  ActionPreview,
  ContextItem,
  GatherContextResponse,
  IntegrationName,
  IntegrationState,
  ReconcileRequest,
  ReconcileResponse,
  ToolDescriptor,
  WorkflowAction,
} from '../../shared/api';
import { activeConnectionId, createConnectLink, executeTool, isLive, listConnections } from './composio';
import type { Env } from './env';
import { HttpError, safeEqual } from './http';
import { arr, ask, enumOf, num, obj, str } from './openai';
import { describeTarget, listTools, SUPPORTED_TOOLKITS, toolkitName, toolSpec, validateArgs } from './tools';
import { arrayOf, clamp01, optStr, str as reqStr } from './validate';

/** 15 minutes: long enough to read a confirmation, short enough that a stale one dies. */
const PREVIEW_TTL_MS = 15 * 60_000;

/**
 * How a prepared action is held server-side. The approval token never leaves this
 * boundary except once, in the response to `approve`.
 */
export interface StoredPreview {
  preview: ActionPreview;
  approvalToken?: string;
}

export type GetPreview = (id: string) => Promise<StoredPreview | null>;
export type SavePreview = (p: StoredPreview) => Promise<void>;

// ── Connections ────────────────────────────────────────────────────────────

export async function integrationStatus(env: Env, body: Record<string, unknown>): Promise<{ integrations: IntegrationState[] }> {
  const userId = reqStr(body.userId, 'userId', 80);
  return { integrations: await listConnections(env, userId, SUPPORTED_TOOLKITS) };
}

export async function connect(env: Env, body: Record<string, unknown>) {
  const userId = reqStr(body.userId, 'userId', 80);
  const integration = toolkitName(body.integration);
  const { redirectUrl } = await createConnectLink(env, userId, integration);
  return { integration, redirectUrl, simulated: !isLive(env) };
}

export function tools(): { tools: ToolDescriptor[] } {
  return { tools: listTools().map((t) => ({ slug: t.slug, toolkit: t.toolkit, effect: t.effect, label: t.label, args: t.args })) };
}

// ── Context reconciliation (unchanged behavior) ────────────────────────────

const DEMO_FACTS = [
  { claim: 'Authentication failure is reproducible in the browser workflow.', sources: ['Chrome tab: Auth bug report'], confidence: 0.93, status: 'confirmed' as const },
  { claim: 'Expected token refresh behavior differs between sources.', sources: ['GitHub issue #42', 'Discord discussion'], confidence: 0.84, status: 'conflicting' as const },
  { claim: 'The target repository has not been explicitly selected.', sources: ['Task context'], confidence: 0.99, status: 'missing' as const },
];

export async function reconcile(env: Env, body: Record<string, unknown>): Promise<ReconcileResponse> {
  const input = body as unknown as ReconcileRequest;
  const task = reqStr(input.task, 'task', 500);
  const tabs = arrayOf(input.tabs, 'tabs', 80, (x) => {
    const t = (x ?? {}) as Record<string, unknown>;
    return { title: (typeof t.title === 'string' ? t.title : '').slice(0, 160), url: (typeof t.url === 'string' ? t.url : '').slice(0, 300), summary: optStr(t.summary, 400) };
  });
  if (!env.OPENAI_API_KEY) return { facts: DEMO_FACTS, conflicts: ['GitHub and Discord describe token refresh differently.'], missing: ['repository'], recommendation: 'Confirm the repository, then create a GitHub issue and notify the likely owner in Discord.', nextAction: 'ask_user', source: 'demo' };
  return ask<ReconcileResponse>(env, {
    system: 'You reconcile messy engineering context. Identify duplicates, stale claims, conflicts and missing fields. Never invent repository names, people, branches or facts. If a mutation target is ambiguous, choose ask_user.',
    user: 'Task: ' + task + '\nCurrent step: ' + (optStr(input.currentStep, 300) ?? '') + '\nNotes: ' + (optStr(input.notes, 1000) ?? '') + '\nBrowser evidence:\n' + tabs.map((t) => t.title + ' — ' + t.url + (t.summary ? ' — ' + t.summary : '')).join('\n'),
    schemaName: 'taskpilot_reconciliation',
    schema: obj({ facts: arr(obj({ claim: str(), sources: arr(str(), 6), confidence: num(), status: enumOf(['confirmed', 'conflicting', 'missing', 'stale']) }), 20), conflicts: arr(str(), 10), missing: arr(str(), 10), recommendation: str(), nextAction: enumOf(['create_issue', 'create_pull_request', 'message_person', 'ask_user']), source: enumOf(['ai', 'demo']) }),
    parse: (raw) => {
      const r = raw as Record<string, unknown>;
      return { facts: arrayOf(r.facts, 'facts', 20, (f) => { const x = f as Record<string, unknown>; return { claim: reqStr(x.claim, 'claim', 300), sources: arrayOf(x.sources, 'sources', 6, (s) => reqStr(s, 'source', 120)), confidence: clamp01(x.confidence), status: x.status === 'conflicting' || x.status === 'missing' || x.status === 'stale' ? x.status : 'confirmed' }; }), conflicts: arrayOf(r.conflicts, 'conflicts', 10, (x) => reqStr(x, 'conflict', 300)), missing: arrayOf(r.missing, 'missing', 10, (x) => reqStr(x, 'missing', 200)), recommendation: reqStr(r.recommendation, 'recommendation', 500), nextAction: (['create_issue', 'create_pull_request', 'message_person', 'ask_user'] as WorkflowAction[]).includes(r.nextAction as WorkflowAction) ? r.nextAction as WorkflowAction : 'ask_user', source: 'ai' };
    },
  });
}

// ── Gathering context from connected apps ──────────────────────────────────

/** Whole-gather budget. Starting a task must never wait on a slow provider. */
const GATHER_TIMEOUT_MS = 6_000;
/** Per source, so one chatty inbox can't crowd out the calendar in the prompt. */
const ITEMS_PER_SOURCE = 5;
/** A lookup the user asked for directly, so show more than the planner needs. */
const READ_ITEM_CAP = 25;

const trim = (v: unknown, max = 200): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/**
 * One read per toolkit, chosen for "what does this person need to know right now".
 * Arguments stay deliberately broad — the planner does the relevance thinking, and a
 * narrow provider-side query risks returning nothing at all on stage.
 */
function plannedReads(task: string, now: Date): { toolkit: IntegrationName; slug: string; args: Record<string, unknown> }[] {
  const dayAhead = new Date(now.getTime() + 36 * 3600_000);
  return [
    {
      toolkit: 'googlecalendar',
      slug: 'GOOGLECALENDAR_EVENTS_LIST',
      args: { calendarId: 'primary', timeMin: now.toISOString(), timeMax: dayAhead.toISOString(), maxResults: ITEMS_PER_SOURCE, singleEvents: 'true', orderBy: 'startTime' },
    },
    { toolkit: 'gmail', slug: 'GMAIL_FETCH_EMAILS', args: { query: 'newer_than:7d -category:promotions', max_results: ITEMS_PER_SOURCE } },
    { toolkit: 'github', slug: 'GITHUB_SEARCH_ISSUES_AND_PULL_REQUESTS', args: { q: 'involves:@me is:open updated:>' + new Date(now.getTime() - 14 * 86_400_000).toISOString().slice(0, 10) } },
  ];
}

/**
 * Providers each return a different shape, and none of it is trusted. Pull out only the
 * few fields the planner needs and drop anything unrecognisable.
 */
/** Keys that mark an object as one displayable record rather than an envelope. */
const ROW_KEYS = ['summary', 'subject', 'snippet', 'title', 'full_name', 'name'];

function toItems(source: IntegrationName, data: unknown, limit = ITEMS_PER_SOURCE): ContextItem[] {
  let d = (data ?? {}) as Record<string, unknown>;
  // GitHub search wraps its payload one level deeper ({ data: { items: [...] } }), so the
  // rows were silently dropped and GitHub never appeared as a source. Unwrap before
  // looking for rows, but only when the outer object is a pure envelope.
  const envelope = d.data;
  if (envelope && typeof envelope === 'object' && !Array.isArray(envelope) && !Array.isArray(d.items) && !Array.isArray(d.messages) && !Array.isArray(d.results)) {
    d = envelope as Record<string, unknown>;
  }

  const list = Array.isArray(d.items) ? d.items : Array.isArray(d.messages) ? d.messages : Array.isArray(d.results) ? d.results : Array.isArray(data) ? data : null;
  // A single-record read (one repository) has no list at all. Only fall back to treating
  // the object itself as a row when no list key was present — an *empty* list means the
  // provider genuinely returned nothing, and for a calendar the envelope's own `summary`
  // is the account address, which must never be rendered as an event.
  const rows = (list ?? (ROW_KEYS.some((k) => typeof d[k] === 'string') ? [d] : [])) as Record<string, unknown>[];

  return rows.slice(0, limit).map((r) => {
    if (source === 'googlecalendar') {
      const start = (r.start ?? {}) as Record<string, unknown>;
      return {
        source,
        title: trim(r.summary) || 'Untitled event',
        when: trim(start.dateTime ?? start.date, 40) || undefined,
        detail: trim(r.location ?? r.description, 160) || undefined,
        url: trim(r.htmlLink, 400) || undefined,
      };
    }
    if (source === 'gmail') {
      return {
        source,
        title: trim(r.subject ?? r.snippet) || 'Email',
        detail: trim(r.from ?? r.sender, 120) || undefined,
        when: trim(r.date ?? r.internalDate, 40) || undefined,
      };
    }
    // GitHub covers both issues (title) and repositories (full_name + description).
    const stars = typeof r.stargazers_count === 'number' ? `★ ${r.stargazers_count}` : '';
    const detail = trim(r.description ?? r.repository_url ?? r.html_url, 160);
    return {
      source,
      title: trim(r.title ?? r.full_name ?? r.name) || 'Item',
      detail: [stars, detail].filter(Boolean).join(' · ') || undefined,
      when: trim(r.updated_at ?? r.created_at, 40) || undefined,
      url: trim(r.html_url, 400) || undefined,
    };
  }).filter((i) => i.title);
}

/** Labelled sample context so the flow is demonstrable without a Composio key. */
function demoItems(): ContextItem[] {
  return [
    { source: 'googlecalendar', title: '[demo] Interview — Acme Corp', when: 'Tomorrow 2:00 PM', detail: 'Video call · 45 min' },
    { source: 'gmail', title: '[demo] Your Acme take-home brief', detail: 'recruiting@acme.example', when: 'Tuesday' },
    { source: 'github', title: '[demo] Flaky auth test on acme/api', detail: 'acme/api#212' },
  ];
}

/**
 * Read what the user's connected apps know about right now.
 *
 * `allSettled`, not `all`: a toolkit that is disconnected, slow or erroring must not stop
 * the others — starting a task is the core flow and it degrades to zero items rather than
 * failing. Nothing here can mutate anything: every tool used is `effect: 'read'`.
 */
export async function gatherContext(env: Env, body: Record<string, unknown>): Promise<GatherContextResponse> {
  const userId = reqStr(body.userId, 'userId', 80);
  const task = reqStr(body.task, 'task', 500);
  if (!isLive(env)) return { items: demoItems(), sources: ['googlecalendar', 'gmail', 'github'], simulated: true };

  const reads = plannedReads(task, new Date());
  const work = Promise.allSettled(
    reads.map(async (r) => {
      const spec = toolSpec(r.slug);
      if (spec.effect !== 'read') throw new Error('gather may only use read tools');
      const connectedAccountId = await activeConnectionId(env, userId, r.toolkit);
      if (!connectedAccountId) return { source: r.toolkit, items: [] as ContextItem[] };
      const run = await executeTool(env, { spec, userId, args: validateArgs(spec, r.args), connectedAccountId });
      return { source: r.toolkit, items: toItems(r.toolkit, run.data) };
    }),
  );

  const settled = await Promise.race([
    work,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), GATHER_TIMEOUT_MS)),
  ]);
  if (!settled) {
    console.log(JSON.stringify({ event: 'composio.gather_timeout', ms: GATHER_TIMEOUT_MS }));
    return { items: [], sources: [], simulated: false };
  }

  const items: ContextItem[] = [];
  const sources: IntegrationName[] = [];
  for (const [i, r] of settled.entries()) {
    if (r.status !== 'fulfilled') {
      console.log(JSON.stringify({ event: 'composio.gather_failed', toolkit: reads[i]?.toolkit, message: String(r.reason?.message ?? r.reason).slice(0, 200) }));
      continue;
    }
    if (!r.value.items.length) continue;
    sources.push(r.value.source);
    items.push(...r.value.items);
  }
  return { items, sources, simulated: false };
}

// ── Running tools ──────────────────────────────────────────────────────────

/** A read needs no approval, so it never becomes a preview. Writes are refused here. */
export async function runRead(env: Env, body: Record<string, unknown>) {
  const userId = reqStr(body.userId, 'userId', 80);
  const spec = toolSpec(body.toolSlug);
  if (spec.effect !== 'read') throw new HttpError(400, 'That action changes something, so it has to be previewed and approved first.');
  const args = validateArgs(spec, body.args);
  const connectedAccountId = (await activeConnectionId(env, userId, spec.toolkit)) ?? undefined;
  if (isLive(env) && !connectedAccountId) throw new HttpError(409, `Connect your ${spec.toolkit} account first.`);

  const run = await executeTool(env, { spec, userId, args, connectedAccountId });
  // The panel showed raw provider JSON because nothing ever flattened a read. Same
  // normaliser the planner uses, with a cap suited to a list the user asked to see.
  return { toolSlug: spec.slug, data: run.data, simulated: !isLive(env), items: toItems(spec.toolkit, run.data, READ_ITEM_CAP) };
}

/**
 * Prepare a write for the user's decision. Nothing reaches the provider here — this
 * only records what *would* happen, in the exact shape it would happen.
 */
export function preview(env: Env, body: Record<string, unknown>): ActionPreview {
  const spec = toolSpec(body.toolSlug);
  const args = validateArgs(spec, body.args);
  const now = Date.now();
  return {
    previewId: crypto.randomUUID(),
    toolSlug: spec.slug,
    effect: spec.effect,
    label: spec.label,
    provider: spec.toolkit,
    title: typeof args.title === 'string' ? args.title : spec.label,
    body: typeof args.body === 'string' ? args.body : '',
    target: describeTarget(spec, args),
    args,
    approvalRequired: spec.effect === 'write',
    status: 'pending',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + PREVIEW_TTL_MS).toISOString(),
    simulated: !isLive(env),
  };
}

function assertUsable(stored: StoredPreview | null): StoredPreview {
  if (!stored) throw new HttpError(404, 'Action preview not found');
  if (Date.now() > Date.parse(stored.preview.expiresAt)) throw new HttpError(410, 'Action preview expired');
  return stored;
}

/**
 * The user said yes. Mint a single-use secret and record the approval, so `execute`
 * can verify a human decided this rather than merely that a preview exists.
 */
export async function approve(env: Env, body: Record<string, unknown>, getPreview: GetPreview, savePreview: SavePreview) {
  const id = reqStr(body.previewId, 'previewId', 80);
  const stored = assertUsable(await getPreview(id));
  if (stored.preview.status !== 'pending') throw new HttpError(409, 'Preview is already ' + stored.preview.status);

  const approvalToken = crypto.randomUUID();
  const preview: ActionPreview = { ...stored.preview, status: 'approved' };
  await savePreview({ preview, approvalToken });
  return { preview, approvalToken };
}

export async function reject(env: Env, body: Record<string, unknown>, getPreview: GetPreview, savePreview: SavePreview) {
  const id = reqStr(body.previewId, 'previewId', 80);
  const stored = await getPreview(id);
  if (!stored) throw new HttpError(404, 'Action preview not found');
  if (stored.preview.status === 'executed') throw new HttpError(409, 'Preview is already executed');

  const preview: ActionPreview = { ...stored.preview, status: 'rejected' };
  await savePreview({ preview });
  return { preview };
}

/**
 * Run an approved write.
 *
 * Every guard here is load-bearing: the preview must exist, must not have expired, must
 * be in `approved` (not merely `pending`), and the caller must present the token minted
 * at approval time. A failure is recorded as `failed` so it cannot be retried forever.
 */
export async function execute(env: Env, body: Record<string, unknown>, getPreview: GetPreview, savePreview: SavePreview) {
  const id = reqStr(body.previewId, 'previewId', 80);
  const token = reqStr(body.approvalToken, 'approvalToken', 120);
  const userId = reqStr(body.userId, 'userId', 80);
  const stored = assertUsable(await getPreview(id));

  if (stored.preview.status !== 'approved') {
    throw new HttpError(stored.preview.status === 'pending' ? 403 : 409, stored.preview.status === 'pending' ? 'This action has not been approved.' : 'Preview is already ' + stored.preview.status);
  }
  if (!stored.approvalToken || !safeEqual(token, stored.approvalToken)) throw new HttpError(403, 'Approval token does not match this preview');

  const spec = toolSpec(stored.preview.toolSlug);
  const connectedAccountId = (await activeConnectionId(env, userId, spec.toolkit)) ?? undefined;
  if (isLive(env) && !connectedAccountId) throw new HttpError(409, `Connect your ${spec.toolkit} account first.`);

  try {
    const run = await executeTool(env, { spec, userId, args: stored.preview.args, connectedAccountId });
    const result = resultOf(run.data);
    // Token dropped: an approval is good for exactly one execution.
    const preview: ActionPreview = { ...stored.preview, status: 'executed', simulated: !isLive(env), result };
    await savePreview({ preview });
    return { preview, simulated: preview.simulated };
  } catch (e) {
    await savePreview({ preview: { ...stored.preview, status: 'failed' } });
    throw e;
  }
}

/** Pull the couple of fields the side panel shows out of an arbitrary tool response. */
function resultOf(data: unknown): { url?: string; message?: string } {
  const d = (data ?? {}) as Record<string, unknown>;
  const url = typeof d.html_url === 'string' ? d.html_url : typeof d.url === 'string' ? d.url : undefined;
  const message = typeof d.message === 'string' ? d.message : typeof d.title === 'string' ? d.title : undefined;
  return { ...(url ? { url } : {}), ...(message ? { message } : {}) };
}
