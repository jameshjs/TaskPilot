/**
 * Contract between the extension and the TaskPilot backend (Cloudflare Worker).
 * Imported by both sides so they cannot drift apart.
 */

export const GROUP_COLORS = [
  'grey',
  'blue',
  'red',
  'yellow',
  'green',
  'pink',
  'purple',
  'cyan',
  'orange',
] as const;
export type GroupColor = (typeof GROUP_COLORS)[number];

export const TAB_LABELS = ['CURRENT_TASK', 'POSSIBLY_RELATED', 'OTHER_TASK', 'DISTRACTION'] as const;
export type TabLabel = (typeof TAB_LABELS)[number];

export const FOCUS_CLASSES = ['RELEVANT', 'POSSIBLY_RELEVANT', 'UNRELATED', 'DISTRACTING'] as const;
export type FocusClass = (typeof FOCUS_CLASSES)[number];

/** Tab metadata as sent to the model. URLs are stripped of query/hash by the extension. */
export interface TabMeta {
  id: number;
  title: string;
  url: string;
  summary?: string;
}

// ── Planner ────────────────────────────────────────────────────────────────

/** One real thing found in a connected app — a meeting, an email, an issue. */
export interface ContextItem {
  source: IntegrationName;
  title: string;
  detail?: string;
  /** Human-readable time, e.g. "Tomorrow 2:00 PM". */
  when?: string;
  url?: string;
}
export interface GatherContextRequest { userId: string; task: string }
export interface GatherContextResponse {
  items: ContextItem[];
  /** Toolkits that actually contributed — drives what the UI can honestly claim. */
  sources: IntegrationName[];
  simulated: boolean;
}

export interface PlanRequest {
  goal: string;
  /** When present, the planner revises this plan instead of creating a new one. */
  existing?: { steps: { title: string; done: boolean }[] };
  note?: string;
  /** Real items from the user's connected apps, for grounding the plan. */
  context?: ContextItem[];
}
export interface PlanResponse {
  /** Short workspace name, e.g. "SWE Applications". */
  title: string;
  steps: { title: string; done: boolean }[];
}

// ── Tab Agent ──────────────────────────────────────────────────────────────

export interface OrganizeRequest {
  activeTask?: string;
  tabs: TabMeta[];
}
export interface SuggestedGroup {
  name: string;
  emoji: string;
  color: GroupColor;
  tabIds: number[];
  /** true when the group is the user's active task. */
  isActiveTask?: boolean;
}
export interface OrganizeResponse {
  groups: SuggestedGroup[];
}

export interface ClassifyRequest {
  activeTask: string;
  tabs: TabMeta[];
}
export interface ClassifyResponse {
  tabs: { id: number; label: TabLabel; reason: string }[];
}

// ── Navigator ──────────────────────────────────────────────────────────────

export interface PageElement {
  id: string; // "tp-21"
  type: 'button' | 'link' | 'input' | 'textarea' | 'select' | 'checkbox' | 'radio' | 'other';
  text?: string;
  label?: string;
  inputType?: string;
  placeholder?: string;
  required?: boolean;
  filled?: boolean;
  disabled?: boolean;
  sensitive?: boolean;
  inViewport?: boolean;
  options?: string[];
}
export interface NavigateRequest {
  goal: string;
  currentStep: string;
  page: { url: string; title: string };
  elements: PageElement[];
}
export type NavigateAction = 'highlight' | 'scroll' | 'wait' | 'done' | 'none';
export interface NavigateResponse {
  action: NavigateAction;
  elementId: string | null;
  instruction: string;
  confidence: number;
}

// ── Focus Agent ────────────────────────────────────────────────────────────

export interface FocusRequest {
  goal: string;
  currentStep: string;
  page: { url: string; title: string; summary?: string };
  /** Titles of tabs the user already placed in the task workspace (context only). */
  taskTabs?: { title: string; url: string }[];
}
export interface FocusResponse {
  classification: FocusClass;
  confidence: number;
  reason: string;
}

// ── Input suggestions ──────────────────────────────────────────────────────

export interface SuggestRequest {
  goal: string;
  page: { url: string; title: string };
  field: { label: string; type: string; placeholder?: string; maxLength?: number };
  /** Free-text "about me" the user stored in settings. */
  profile?: string;
}
export interface SuggestResponse {
  suggestion: string;
  /** Set when the model declined (e.g. sensitive field) or lacks the facts to answer. */
  note?: string;
}

// ── Summaries & memory ─────────────────────────────────────────────────────

export interface SummaryRequest {
  task: string;
  steps: { title: string; done: boolean }[];
  currentStep: string | null;
  tabs: { title: string; url: string }[];
  history: { at: string; text: string }[];
  activeMinutes: number;
}
export interface SummaryResponse {
  completed: string[];
  importantTabs: string[];
  continueWith: string;
  /** One concrete sentence, shown on resume: "Connect chrome.tabs.query() to the classifier." */
  nextStepHint: string;
}

export interface WhatWasIDoingRequest {
  now: string;
  tabs: { id: number; title: string; url: string; groupTitle?: string; lastAccessed?: string }[];
  sessions: {
    id: string;
    task: string;
    status: string;
    progress: string;
    tabCount: number;
    lastActiveAt: string;
    currentStep: string | null;
  }[];
  history: { at: string; text: string }[];
}
export interface WhatWasIDoingResponse {
  projects: {
    name: string;
    tabCount: number;
    lastActiveAt: string | null;
    sessionId: string | null;
    note: string;
  }[];
  narrative: string;
}

// ── Engineering workflow actions ─────────────────────────────────────────
export const INTEGRATION_NAMES = ['github', 'googlecalendar', 'gmail', 'discord'] as const;
export type IntegrationName = (typeof INTEGRATION_NAMES)[number];
export type IntegrationStatus = 'connected' | 'disconnected' | 'demo';
export type WorkflowAction = 'create_issue' | 'create_pull_request' | 'message_person' | 'ask_user';
export type EvidenceStatus = 'confirmed' | 'conflicting' | 'missing' | 'stale';
export type ToolEffect = 'read' | 'write';

export interface IntegrationState { name: IntegrationName; status: IntegrationStatus; account?: string; scopes: string[]; }
export interface WorkflowEvidence { claim: string; sources: string[]; confidence: number; status: EvidenceStatus; }
export interface ReconciliationResult {
  facts: WorkflowEvidence[];
  conflicts: string[];
  missing: string[];
  recommendation: string;
  nextAction: WorkflowAction;
}
/** One allowlisted external-app tool TaskPilot is able to run. */
export interface ToolDescriptor {
  slug: string;
  toolkit: IntegrationName;
  /** `read` runs automatically; `write` cannot run without an explicit approval. */
  effect: ToolEffect;
  label: string;
  args: Record<string, string>;
}

/**
 * A prepared external-app action awaiting the user's decision.
 *
 * The approval token is deliberately absent: it is generated and held server-side when
 * the user approves, so possessing a preview is not enough to execute it.
 */
export interface ActionPreview {
  previewId: string;
  toolSlug: string;
  effect: ToolEffect;
  /** Human-readable description of the real-world effect, shown in the confirmation. */
  label: string;
  provider: IntegrationName;
  title: string;
  body: string;
  /** e.g. "owner/repo" — what the action will touch. */
  target: string;
  args: Record<string, unknown>;
  approvalRequired: boolean;
  status: 'pending' | 'approved' | 'rejected' | 'executed' | 'failed';
  createdAt: string;
  expiresAt: string;
  simulated: boolean;
  result?: { url?: string; message?: string };
}
export interface IntegrationConnectRequest { userId: string; integration: IntegrationName }
export interface IntegrationConnectResponse { integration: IntegrationName; redirectUrl: string; simulated: boolean }
export interface IntegrationStatusRequest { userId: string }
export interface IntegrationStatusResponse { integrations: IntegrationState[] }
export interface ToolListResponse { tools: ToolDescriptor[] }
export interface ReconcileRequest { task: string; currentStep?: string; tabs: TabMeta[]; notes?: string; references?: string[] }
export interface ReconcileResponse extends ReconciliationResult { source: 'ai' | 'demo'; }
/** Read-only tools run straight through; there is nothing to approve. */
export interface ToolReadRequest { userId: string; toolSlug: string; args?: Record<string, unknown> }
export interface ToolReadResponse {
  toolSlug: string;
  data: unknown;
  simulated: boolean;
  /**
   * The same rows as `data`, flattened to something displayable. Empty when the payload
   * had no recognisable rows — the panel falls back to showing `data` verbatim.
   */
  items?: ContextItem[];
}
export interface ActionPreviewRequest { userId: string; task?: string; toolSlug: string; args?: Record<string, unknown> }
export interface ActionApproveRequest { userId: string; previewId: string }
/** The token is returned once, here, and must be echoed back to execute. */
export interface ActionApproveResponse { preview: ActionPreview; approvalToken: string }
export interface ActionRejectRequest { userId: string; previewId: string }
export interface ActionExecuteRequest { userId: string; previewId: string; approvalToken: string }
export interface ActionExecuteResponse { preview: ActionPreview; simulated: boolean }

// ── Sync (Durable Object) ──────────────────────────────────────────────────

export interface SyncedSession {
  sessionId: string;
  lastActiveAt: string;
  // The remaining fields are the extension's TaskSession; the backend stores it opaquely.
  [key: string]: unknown;
}

// ── Telemetry ──────────────────────────────────────────────────────────────

export interface TelemetryEvent {
  kind: 'dom_selection_failed' | 'workflow_failed' | 'client_error';
  message: string;
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
}
