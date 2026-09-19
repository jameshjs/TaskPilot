import type {
  FocusClass,
  GroupColor,
  NavigateAction,
  PageElement,
  SuggestedGroup,
  TabLabel,
} from '../../shared/api';

export type { FocusClass, GroupColor, NavigateAction, PageElement, SuggestedGroup, TabLabel };

// ── Live browser state ─────────────────────────────────────────────────────

export interface TabInfo {
  id: number;
  windowId: number;
  title: string;
  url: string;
  favIconUrl?: string;
  groupId: number; // -1 when ungrouped
  active: boolean;
  pinned: boolean;
  lastAccessed?: number;
  index: number;
}

export interface GroupInfo {
  id: number;
  windowId: number;
  title: string;
  color: GroupColor;
  collapsed: boolean;
}

export interface TabsSnapshot {
  tabs: TabInfo[];
  groups: GroupInfo[];
  currentWindowId: number | null;
}

// ── Task sessions ──────────────────────────────────────────────────────────

export interface PlanStep {
  id: string;
  title: string;
  done: boolean;
}

export interface SavedTab {
  url: string;
  title: string;
  category: string;
  groupTitle?: string;
  groupColor?: GroupColor;
  favIconUrl?: string;
}

export type SessionStatus = 'active' | 'saved' | 'finished' | 'archived';

export interface TaskSession {
  sessionId: string;
  task: string;
  /** Short workspace name shown on the tab group. */
  title: string;
  emoji: string;
  status: SessionStatus;
  color: GroupColor;
  tabs: SavedTab[];
  taskPlan: PlanStep[];
  completedSteps: string[]; // PlanStep ids
  currentStep: number; // index into taskPlan
  notes: { at: string; text: string }[];
  startedAt: string;
  lastActiveAt: string;
  endedAt?: string;
  /** Milliseconds spent actively in this session (excludes time while saved/closed). */
  activeMs: number;
  /** When the session last became active; undefined while saved/finished. */
  activeSince?: string;
  lastActiveUrl?: string;
  nextStepHint?: string;
  summary?: SessionSummary;
  paused?: boolean;
  /** Live Chrome tab group for the active session; meaningless once the browser restarts. */
  groupId?: number;
  windowId?: number;
  /** URLs (normalized) the user marked "This is relevant". */
  relevantUrls: string[];
}

export interface SessionSummary {
  goal: string;
  timeLabel: string;
  progressLabel: string;
  completed: string[];
  importantTabs: string[];
  continueWith: string;
}

export interface HistoryEvent {
  id: string;
  at: string;
  sessionId?: string;
  kind:
    | 'session_started'
    | 'tab_added'
    | 'step_done'
    | 'step_undone'
    | 'plan_updated'
    | 'drift'
    | 'returned'
    | 'session_saved'
    | 'session_restored'
    | 'session_finished'
    | 'tabs_organized'
    | 'tabs_closed'
    | 'note';
  text: string;
}

export interface ResumeInfo {
  session: TaskSession;
  stoppedAt: string | null;
  nextStepHint: string | null;
  reopened: number;
  reused: number;
}

// ── Tab Agent ──────────────────────────────────────────────────────────────

export interface OrganizePreview {
  groups: SuggestedGroup[];
  source: 'ai' | 'offline';
  /** Why we fell back to offline grouping, if we did. */
  error?: string;
}

export interface TabClassification {
  label: TabLabel;
  reason: string;
}

export interface DuplicateSet {
  key: string;
  title: string;
  tabIds: number[]; // ordered newest → oldest
}

export interface CleanupReport {
  total: number;
  related: number[];
  inactive: number[];
  duplicates: number[]; // extras only; the keeper of each set is not listed
  stale: number[];
  duplicateSets: DuplicateSet[];
  source: 'ai' | 'offline';
}

export interface WhatWasIDoing {
  narrative: string;
  projects: {
    name: string;
    tabCount: number;
    lastActiveAt: string | null;
    sessionId: string | null;
    note: string;
  }[];
  source: 'ai' | 'offline';
}

// ── Navigator / inputs ─────────────────────────────────────────────────────

export interface NavigatorResult {
  action: NavigateAction;
  elementId: string | null;
  instruction: string;
  confidence: number;
  highlighted: boolean;
}

export interface FormField {
  id: string;
  label: string;
  type: string;
  placeholder?: string;
  maxLength?: number;
}

export interface InputSuggestion {
  field: FormField;
  suggestion: string;
  note?: string;
}

// ── Focus ──────────────────────────────────────────────────────────────────

export interface FocusState {
  status: 'idle' | 'on_task' | 'drifting' | 'paused';
  classification?: FocusClass;
  confidence?: number;
  reason?: string;
  pageTitle?: string;
  pageUrl?: string;
  tabId?: number;
  /** ISO time the user first drifted from the task. */
  driftSince?: string;
  lastNudgeAt?: string;
  /** Tab whose warning the user dismissed ("This is relevant" / "Return"); do not re-warn. */
  dismissedUrl?: string;
}

// ── Settings ───────────────────────────────────────────────────────────────

export interface Settings {
  apiUrl: string;
  apiToken: string;
  focusEnabled: boolean;
  autoAddRelevantTabs: boolean;
  /** Minimum model confidence before a drift warning is shown. */
  driftThreshold: number;
  /** Free-text "about me" used only for input suggestions. */
  profile: string;
  /** Hostnames never sent to the model. */
  excludedHosts: string[];
  /** Opt-in: mirror saved sessions to the backend Durable Object. */
  syncEnabled: boolean;
  userId: string;
}
