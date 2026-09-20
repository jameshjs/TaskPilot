import type {
  CleanupReport,
  FocusState,
  HistoryEvent,
  InputSuggestion,
  NavigatorResult,
  OrganizePreview,
  ResumeInfo,
  SessionSummary,
  Settings,
  SuggestedGroup,
  TabClassification,
  TabsSnapshot,
  TaskSession,
  WhatWasIDoing,
  FormField,
  GuideTarget,
} from './types';
import type {
  ActionPreview,
  ActionExecuteResponse,
  GatherContextResponse,
  IntegrationConnectResponse,
  IntegrationName,
  IntegrationState,
  ReconcileResponse,
  ToolDescriptor,
  ToolReadResponse,
} from '../../shared/api';

/** Every request the side panel (or a content script) can make of the service worker. */
export interface RpcMap {
  'tabs.snapshot': { req: void; res: TabsSnapshot };
  'tabs.groupTabs': { req: { tabIds: number[]; title: string; color?: string }; res: { groupId: number; skipped: number } };
  'tabs.renameGroup': { req: { groupId: number; title: string; color?: string }; res: void };
  'tabs.ungroup': { req: { tabIds: number[] }; res: void };
  'tabs.close': { req: { tabIds: number[] }; res: { closed: number } };
  'tabs.activate': { req: { tabId: number }; res: void };
  'tabs.organizePreview': { req: void; res: OrganizePreview };
  'tabs.organizeApply': { req: { groups: SuggestedGroup[] }; res: { created: number; skipped: number } };
  'tabs.classify': { req: void; res: { labels: Record<number, TabClassification>; source: 'ai' | 'offline' } };
  'tabs.cleanupAnalyze': { req: void; res: CleanupReport };
  'tabs.archive': { req: { tabIds: number[]; close?: boolean; name?: string }; res: { sessionId: string; closed: number } };

  'session.active': { req: void; res: TaskSession | null };
  'session.list': { req: void; res: TaskSession[] };
  'session.start': { req: { task: string }; res: TaskSession };
  'session.setStep': { req: { index: number }; res: TaskSession };
  'session.toggleStep': { req: { stepId: string }; res: TaskSession };
  'session.replan': { req: { note?: string }; res: TaskSession };
  'session.save': { req: { closeTabs?: boolean }; res: TaskSession };
  'session.finish': { req: { closeTabs?: boolean }; res: { session: TaskSession; summary: SessionSummary } };
  'session.restore': { req: { sessionId: string }; res: ResumeInfo };
  'session.delete': { req: { sessionId: string }; res: void };
  'session.addNote': { req: { text: string }; res: TaskSession };
  'session.pause': { req: { paused: boolean }; res: TaskSession };
  'session.addTabs': { req: { tabIds: number[] }; res: TaskSession };

  'history.list': { req: { limit?: number } | void; res: HistoryEvent[] };
  'whatWasIDoing': { req: void; res: WhatWasIDoing };

  'nav.guide': { req: void; res: NavigatorResult };
  'nav.guideTarget': { req: void; res: GuideTarget | null };
  'nav.clear': { req: void; res: void };
  'nav.scanFields': { req: void; res: FormField[] };
  'nav.suggest': { req: { field: FormField }; res: InputSuggestion };
  'nav.insert': { req: { fieldId: string; text: string }; res: void };

  'focus.state': { req: void; res: FocusState };
  'focus.action': { req: { action: 'return' | 'relevant' | 'pause' | 'dismiss' }; res: void };

  'settings.get': { req: void; res: Settings };
  'settings.set': { req: Partial<Settings>; res: Settings };
  'sync.now': { req: void; res: { pushed: number; pulled: number } };
  'workflow.status': { req: void; res: { integrations: IntegrationState[] } };
  'workflow.tools': { req: void; res: { tools: ToolDescriptor[] } };
  'workflow.connect': { req: { integration: IntegrationName }; res: IntegrationConnectResponse };
  'workflow.reconcile': { req: { notes?: string }; res: ReconcileResponse };
  'workflow.gather': { req: { task: string }; res: GatherContextResponse };
  'workflow.read': { req: { toolSlug: string; args?: Record<string, unknown> }; res: ToolReadResponse };
  'workflow.preview': { req: { toolSlug: string; args?: Record<string, unknown> }; res: ActionPreview };
  'workflow.pending': { req: void; res: ActionPreview | null };
  'workflow.reject': { req: { previewId: string }; res: void };
  'workflow.execute': { req: { previewId: string }; res: ActionExecuteResponse };
}

export type RpcType = keyof RpcMap;
export type RpcRequest<K extends RpcType> = RpcMap[K]['req'];
export type RpcResponse<K extends RpcType> = RpcMap[K]['res'];

export type RpcEnvelope<T> = { ok: true; data: T } | { ok: false; error: string };

/** Background → UI push notifications. UI re-reads state when it hears one. */
export type BroadcastName = 'tabs' | 'state';
export interface Broadcast {
  type: 'broadcast';
  name: BroadcastName;
}

export async function rpc<K extends RpcType>(type: K, payload?: RpcRequest<K>): Promise<RpcResponse<K>> {
  const res = (await chrome.runtime.sendMessage({ type, payload })) as RpcEnvelope<RpcResponse<K>> | undefined;
  if (!res) throw new Error('TaskPilot background did not respond');
  if (!res.ok) throw new Error(res.error);
  return res.data;
}
