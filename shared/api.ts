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

export interface PlanRequest {
  goal: string;
  /** When present, the planner revises this plan instead of creating a new one. */
  existing?: { steps: { title: string; done: boolean }[] };
  note?: string;
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
export const INTEGRATION_NAMES = ['github', 'discord'] as const;
export type IntegrationName = (typeof INTEGRATION_NAMES)[number];
export type IntegrationStatus = 'connected' | 'disconnected' | 'demo';
export type WorkflowAction = 'create_issue' | 'create_pull_request' | 'message_person' | 'ask_user';
export type EvidenceStatus = 'confirmed' | 'conflicting' | 'missing' | 'stale';

export interface IntegrationState { name: IntegrationName; status: IntegrationStatus; account?: string; scopes: string[]; }
export interface WorkflowEvidence { claim: string; sources: string[]; confidence: number; status: EvidenceStatus; }
export interface ReconciliationResult {
  facts: WorkflowEvidence[];
  conflicts: string[];
  missing: string[];
  recommendation: string;
  nextAction: WorkflowAction;
}
export interface ActionPreview {
  previewId: string;
  action: Exclude<WorkflowAction, 'ask_user'>;
  provider: IntegrationName;
  title: string;
  body: string;
  target: string;
  fields: Record<string, unknown>;
  approvalRequired: boolean;
  status: 'pending' | 'approved' | 'rejected' | 'executed' | 'failed';
  createdAt: string;
  expiresAt: string;
  simulated: boolean;
  result?: { url?: string; message?: string };
}
export interface IntegrationConnectRequest { integration: IntegrationName; demo?: boolean }
export interface IntegrationStatusResponse { integrations: IntegrationState[] }
export interface ReconcileRequest { task: string; currentStep?: string; tabs: TabMeta[]; notes?: string; references?: string[] }
export interface ReconcileResponse extends ReconciliationResult { source: 'ai' | 'demo'; }
export interface ActionPreviewRequest { task: string; reconciliation: ReconciliationResult; action?: Exclude<WorkflowAction, 'ask_user'>; fields?: Record<string, unknown> }
export interface ActionExecuteRequest { previewId: string; approvalToken: string; sendDiscord?: boolean }
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
