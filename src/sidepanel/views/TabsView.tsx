import { useEffect, useMemo, useRef, useState } from 'react';
import { rpc } from '../../shared/rpc';
import { findDuplicateSets, isManageable } from '../../shared/tabLogic';
import type { CleanupReport, GroupInfo, OrganizePreview, SuggestedGroup, TabClassification, TabInfo, TabLabel, TaskSession } from '../../shared/types';
import { useAction, useLoad, useToast } from '../hooks';
import { Button, Card, Chip, Confirm, Empty, Favicon, hostLabel } from '../ui';

export const GROUP_HEX: Record<string, string> = {
  grey: '#8b8fa3', blue: '#4f86f7', red: '#e5534b', yellow: '#d9a300', green: '#2fa562',
  pink: '#e05aa6', purple: '#8b5cf6', cyan: '#1fb5c9', orange: '#f08a24',
};

const LABEL_CHIP: Record<TabLabel, { tone: 'ok' | 'accent' | 'muted' | 'bad'; text: string }> = {
  CURRENT_TASK: { tone: 'ok', text: 'Current task' },
  POSSIBLY_RELATED: { tone: 'accent', text: 'Possibly related' },
  OTHER_TASK: { tone: 'muted', text: 'Other task' },
  DISTRACTION: { tone: 'bad', text: 'Distraction' },
};

interface PendingClose {
  title: string;
  body: string;
  confirmLabel: string;
  tabIds: number[];
  archive: boolean;
}

export function TabsView({ session, autoOrganize, consumeAuto }: { session: TaskSession | null; autoOrganize: boolean; consumeAuto: () => void }) {
  const snap = useLoad(() => rpc('tabs.snapshot'), ['tabs']);
  const { run, busy } = useAction();
  const { notify } = useToast();

  const [labels, setLabels] = useState<Record<number, TabClassification> | null>(null);
  const [preview, setPreview] = useState<OrganizePreview | null>(null);
  const [draft, setDraft] = useState<(SuggestedGroup & { on: boolean })[]>([]);
  const [report, setReport] = useState<CleanupReport | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [dismissedDupes, setDismissedDupes] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [groupName, setGroupName] = useState('');
  const [pending, setPending] = useState<PendingClose | null>(null);

  const tabs = snap.data?.tabs ?? [];
  const groups = snap.data?.groups ?? [];
  const byId = useMemo(() => new Map(tabs.map((t) => [t.id, t])), [tabs]);
  const dupSets = useMemo(() => findDuplicateSets(tabs).filter((s) => !dismissedDupes.has(s.key)), [tabs, dismissedDupes]);
  const dupExtras = useMemo(() => new Set(dupSets.flatMap((s) => s.tabIds.slice(1))), [dupSets]);

  // Drop selections for tabs that no longer exist.
  useEffect(() => {
    setSelected((sel) => {
      const next = new Set([...sel].filter((id) => byId.has(id)));
      return next.size === sel.size ? sel : next;
    });
  }, [byId]);

  const autoRan = useRef(false);
  useEffect(() => {
    if (autoOrganize && !autoRan.current) {
      autoRan.current = true;
      consumeAuto();
      void organize();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOrganize]);

  return (
    <>
      <div className="toolbar">
        <Button variant="primary" busy={busy === 'organize'} onClick={() => void organize()}>
          ✨ Organize Tabs
        </Button>
        <Button busy={busy === 'cleanup'} onClick={() => void cleanup()}>
          🧹 Clean Up My Tabs
        </Button>
        {session ? (
          <Button busy={busy === 'classify'} onClick={() => void run('classify', () => rpc('tabs.classify')).then((r) => r && setLabels(r.source === 'ai' ? r.labels : null))} title={`Compare every tab to “${session.task}”`}>
            Check relevance
          </Button>
        ) : null}
      </div>

      {preview ? (
        <Card
          title="Suggested groups"
          right={preview.source === 'offline' ? <Chip tone="warn" title={preview.error}>offline · by site</Chip> : <Chip tone="accent">AI</Chip>}
        >
          {preview.error ? <p className="hint">AI grouping unavailable ({preview.error}). Showing a simple grouping by site.</p> : null}
          {draft.length === 0 ? <Empty>No groupable tabs.</Empty> : null}
          <ul className="plain preview">
            {draft.map((g, gi) => (
              <li key={gi} className={g.on ? '' : 'off'}>
                <div className="row">
                  <input type="checkbox" checked={g.on} aria-label={`Include ${g.name}`} onChange={() => setDraft((d) => d.map((x, i) => (i === gi ? { ...x, on: !x.on } : x)))} />
                  <span className="dot" style={{ background: GROUP_HEX[g.color] }} />
                  <span className="emoji">{g.emoji}</span>
                  <input className="input inline" value={g.name} onChange={(e) => setDraft((d) => d.map((x, i) => (i === gi ? { ...x, name: e.target.value } : x)))} aria-label="Group name" />
                  {g.isActiveTask ? <Chip tone="ok">active task</Chip> : null}
                  <span className="hint">{g.tabIds.length}</span>
                </div>
                <ul className="plain tree">
                  {g.tabIds.map((id) => (
                    <li key={id}>{byId.get(id)?.title ?? `Tab ${id}`}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
          <div className="row end">
            <Button variant="ghost" onClick={() => setPreview(null)}>Cancel</Button>
            <Button
              variant="primary"
              busy={busy === 'apply'}
              disabled={!draft.some((g) => g.on)}
              onClick={() =>
                void run('apply', () => rpc('tabs.organizeApply', { groups: draft.filter((g) => g.on && g.name.trim()).map(({ on: _on, ...g }) => g) }), (r) => `Created ${r.created} group${r.created === 1 ? '' : 's'}${r.skipped ? ` (${r.skipped} pinned tabs skipped)` : ''}`).then((r) => r && setPreview(null))
              }
            >
              Create {draft.filter((g) => g.on).length} groups
            </Button>
          </div>
        </Card>
      ) : null}

      {report ? (
        <CleanupCard
          report={report}
          byId={byId}
          reviewing={reviewing}
          onReview={() => setReviewing((v) => !v)}
          onOrganize={() => void organize()}
          onClose={() => setReport(null)}
          request={setPending}
        />
      ) : null}

      {dupSets.length ? (
        <Card title="Duplicate tabs" tone="warn">
          <p className="hint">These tabs appear duplicated. Nothing is closed unless you choose.</p>
          <ul className="plain dupes">
            {dupSets.map((d) => (
              <li key={d.key}>
                <div className="dup-title">{d.title} <Chip tone="warn">×{d.tabIds.length}</Chip></div>
                <div className="row">
                  <Button onClick={() => void run('dup', () => rpc('tabs.close', { tabIds: d.tabIds.slice(1) }), (r) => `Closed ${r.closed} duplicate${r.closed === 1 ? '' : 's'}`)}>Keep Newest</Button>
                  <Button variant="ghost" onClick={() => setDismissedDupes((s) => new Set(s).add(d.key))}>Keep Both</Button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {selected.size ? (
        <div className="selbar">
          <span>{selected.size} selected</span>
          <input className="input inline" placeholder="Group name" value={groupName} onChange={(e) => setGroupName(e.target.value)} />
          <Button
            variant="primary"
            disabled={!groupName.trim()}
            onClick={() => void run('group', () => rpc('tabs.groupTabs', { tabIds: [...selected], title: groupName.trim() }), (r) => `Grouped${r.skipped ? ` (${r.skipped} pinned skipped)` : ''}`).then(() => (setSelected(new Set()), setGroupName('')))}
          >
            Group
          </Button>
          <Button onClick={() => void run('ungroup', () => rpc('tabs.ungroup', { tabIds: [...selected] })).then(() => setSelected(new Set()))}>Ungroup</Button>
          <Button
            onClick={() => {
              const name = window.prompt('Name this saved tab list', `Saved tabs ${new Date().toLocaleDateString()}`);
              if (name) void run('list', () => rpc('tabs.archive', { tabIds: [...selected], close: false, name }), () => 'Saved tab list. Restore it from Sessions.').then(() => setSelected(new Set()));
            }}
          >
            Save list
          </Button>
          <Button variant="danger" onClick={() => setPending({ title: `Close ${selected.size} tabs?`, body: 'These tabs will be closed.', confirmLabel: 'Close tabs', tabIds: [...selected], archive: false })}>Close</Button>
        </div>
      ) : null}

      {snap.error ? <p className="error">{snap.error}</p> : null}
      <TabList
        tabs={tabs}
        groups={groups}
        currentWindowId={snap.data?.currentWindowId ?? null}
        labels={labels}
        dupExtras={dupExtras}
        selected={selected}
        toggle={(id) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; })}
        onRename={(g, title) => void run('rename', () => rpc('tabs.renameGroup', { groupId: g.id, title }))}
        onRecolor={(g, color) => void run('color', () => rpc('tabs.renameGroup', { groupId: g.id, title: g.title, color }))}
        onUngroup={(ids) => void run('ungroup', () => rpc('tabs.ungroup', { tabIds: ids }))}
        onActivate={(id) => void rpc('tabs.activate', { tabId: id })}
        onClose={(id) => void run('close', () => rpc('tabs.close', { tabIds: [id] }))}
      />

      {pending ? (
        <Confirm
          title={pending.title}
          body={pending.body}
          items={pending.tabIds.map((id) => byId.get(id)?.title ?? `Tab ${id}`)}
          confirmLabel={pending.confirmLabel}
          danger={!pending.archive}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const p = pending;
            setPending(null);
            if (p.archive) void run('archive', () => rpc('tabs.archive', { tabIds: p.tabIds }), (r) => `Archived ${r.closed} tabs. Restore them from Sessions.`).then(() => setReport(null));
            else void run('close', () => rpc('tabs.close', { tabIds: p.tabIds }), (r) => `Closed ${r.closed} tab${r.closed === 1 ? '' : 's'}`).then(() => setSelected(new Set()));
          }}
        />
      ) : null}
    </>
  );

  async function organize() {
    const p = await run('organize', () => rpc('tabs.organizePreview'));
    if (!p) return;
    if (p.groups.length === 0) return notify(p.error ?? 'No groupable tabs.', 'info');
    setPreview(p);
    setDraft(p.groups.map((g) => ({ ...g, on: true })));
  }

  async function cleanup() {
    const r = await run('cleanup', () => rpc('tabs.cleanupAnalyze'));
    if (r) (setReport(r), setReviewing(false));
  }
}

// ── Cleanup ────────────────────────────────────────────────────────────────

function CleanupCard({
  report, byId, reviewing, onReview, onOrganize, onClose, request,
}: {
  report: CleanupReport;
  byId: Map<number, TabInfo>;
  reviewing: boolean;
  onReview: () => void;
  onOrganize: () => void;
  onClose: () => void;
  request: (p: PendingClose) => void;
}) {
  const buckets: { key: string; label: string; ids: number[]; actions: ('archive' | 'close')[] }[] = [
    { key: 'related', label: 'related to active tasks', ids: report.related, actions: [] },
    { key: 'inactive', label: 'useful but inactive', ids: report.inactive, actions: ['archive'] },
    { key: 'dup', label: 'duplicates', ids: report.duplicates, actions: ['close'] },
    { key: 'stale', label: 'potentially stale', ids: report.stale, actions: ['archive', 'close'] },
  ];
  const archiveIds = [...report.inactive, ...report.stale];
  const ask = (ids: number[], mode: 'archive' | 'close', what: string) =>
    request(
      mode === 'archive'
        ? { title: `Archive ${ids.length} ${what} tabs?`, body: 'They will be saved as a session you can restore later, then closed.', confirmLabel: 'Archive & close', tabIds: ids, archive: true }
        : { title: `Close ${ids.length} ${what} tabs?`, body: 'These tabs will be closed.', confirmLabel: 'Close tabs', tabIds: ids, archive: false },
    );

  return (
    <Card title={`${report.total} tabs detected`} right={<button className="link" onClick={onClose}>Dismiss</button>}>
      {report.source === 'offline' ? <p className="hint">Sorted by recent use (start a task and connect the backend for task-aware cleanup).</p> : null}
      <ul className="plain counts">
        {buckets.map((b) => (
          <li key={b.key}><b>{b.ids.length}</b> {b.label}</li>
        ))}
      </ul>
      <div className="row wrap">
        <Button onClick={onOrganize}>Organize</Button>
        <Button disabled={!archiveIds.length} onClick={() => ask(archiveIds, 'archive', 'inactive')}>Archive Inactive</Button>
        <Button disabled={!report.duplicates.length} onClick={() => ask(report.duplicates, 'close', 'duplicate')}>Close Duplicates</Button>
        <Button variant="ghost" onClick={onReview}>{reviewing ? 'Hide review' : 'Review'}</Button>
      </div>
      {reviewing ? (
        <div className="review">
          {buckets.filter((b) => b.ids.length).map((b) => (
            <details key={b.key} open={b.key !== 'related'}>
              <summary>{b.label} ({b.ids.length})</summary>
              <ul className="plain">
                {b.ids.map((id) => {
                  const t = byId.get(id);
                  return t ? <li key={id} className="mini"><Favicon tab={t} /><span className="ellipsis">{t.title}</span></li> : null;
                })}
              </ul>
              <div className="row">
                {b.actions.includes('archive') ? <Button onClick={() => ask(b.ids, 'archive', b.label)}>Archive these</Button> : null}
                {b.actions.includes('close') ? <Button variant="danger" onClick={() => ask(b.ids, 'close', b.label)}>Close these</Button> : null}
              </div>
            </details>
          ))}
        </div>
      ) : null}
    </Card>
  );
}

// ── Live tab list ──────────────────────────────────────────────────────────

interface Section {
  key: string;
  windowId: number;
  group: GroupInfo | null;
  tabs: TabInfo[];
}

function TabList(p: {
  tabs: TabInfo[];
  groups: GroupInfo[];
  currentWindowId: number | null;
  labels: Record<number, TabClassification> | null;
  dupExtras: Set<number>;
  selected: Set<number>;
  toggle: (id: number) => void;
  onRename: (g: GroupInfo, title: string) => void;
  onRecolor: (g: GroupInfo, color: string) => void;
  onUngroup: (ids: number[]) => void;
  onActivate: (id: number) => void;
  onClose: (id: number) => void;
}) {
  const groupById = useMemo(() => new Map(p.groups.map((g) => [g.id, g])), [p.groups]);
  const sections = useMemo(() => {
    const sorted = [...p.tabs].sort((a, b) => Number(b.windowId === p.currentWindowId) - Number(a.windowId === p.currentWindowId) || a.windowId - b.windowId || a.index - b.index);
    const out: Section[] = [];
    for (const t of sorted) {
      const last = out[out.length - 1];
      if (last && last.windowId === t.windowId && (last.group?.id ?? -1) === t.groupId) last.tabs.push(t);
      else out.push({ key: `${t.windowId}:${t.groupId}:${out.length}`, windowId: t.windowId, group: groupById.get(t.groupId) ?? null, tabs: [t] });
    }
    return out;
  }, [p.tabs, p.currentWindowId, groupById]);
  const windows = new Set(p.tabs.map((t) => t.windowId)).size;
  const [editing, setEditing] = useState<number | null>(null);
  const [title, setTitle] = useState('');
  let lastWin = -1;

  if (!p.tabs.length) return <Empty>No tabs.</Empty>;
  return (
    <div className="tablist">
      {sections.map((s) => {
        const header = windows > 1 && s.windowId !== lastWin ? <div className="win">Window {s.windowId === p.currentWindowId ? '(this one)' : ''}</div> : null;
        lastWin = s.windowId;
        return (
          <div key={s.key}>
            {header}
            <div className="section-h">
              {s.group ? (
                <>
                  <button className="dot big" style={{ background: GROUP_HEX[s.group.color] }} title="Change color" onClick={() => { const cs = Object.keys(GROUP_HEX); p.onRecolor(s.group!, cs[(cs.indexOf(s.group!.color) + 1) % cs.length]!); }} aria-label="Change group color" />
                  {editing === s.group.id ? (
                    <input className="input inline" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => { p.onRename(s.group!, title.trim() || s.group!.title); setEditing(null); }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEditing(null); }} />
                  ) : (
                    <button className="group-title" onClick={() => { setEditing(s.group!.id); setTitle(s.group!.title); }} title="Rename group">{s.group.title || 'Untitled group'}</button>
                  )}
                  <span className="hint">{s.tabs.length}</span>
                  <button className="link" onClick={() => p.onUngroup(s.tabs.map((t) => t.id))}>Ungroup</button>
                </>
              ) : (
                <span className="group-title muted">Ungrouped <span className="hint">{s.tabs.length}</span></span>
              )}
            </div>
            <ul className="plain tabs">
              {s.tabs.map((t) => {
                const lab = p.labels?.[t.id];
                return (
                  <li key={t.id} className={`tab ${t.active ? 'active' : ''} ${isManageable(t) ? '' : 'internal'}`}>
                    <input type="checkbox" checked={p.selected.has(t.id)} onChange={() => p.toggle(t.id)} aria-label={`Select ${t.title}`} disabled={!isManageable(t)} />
                    <Favicon tab={t} />
                    <button className="tab-main" onClick={() => p.onActivate(t.id)} title={t.url}>
                      <span className="ellipsis title">{t.title}</span>
                      <span className="ellipsis host">{hostLabel(t.url)}</span>
                    </button>
                    {p.dupExtras.has(t.id) ? <Chip tone="warn">dup</Chip> : null}
                    {lab ? <Chip tone={LABEL_CHIP[lab.label].tone} title={lab.reason}>{LABEL_CHIP[lab.label].text}</Chip> : null}
                    <button className="x" onClick={() => p.onClose(t.id)} aria-label={`Close ${t.title}`}>✕</button>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
