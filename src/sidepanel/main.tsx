import { StrictMode, useCallback, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { rpc } from '../shared/rpc';
import type { ResumeInfo, SessionSummary } from '../shared/types';
import { ToastProvider, useLoad } from './hooks';
import { Icon, type IconName } from './icons';
import { initTelemetry } from './telemetry';
import { HistoryView } from './views/HistoryView';
import { ActionsView } from './views/ActionsView';
import { SessionsView } from './views/SessionsView';
import { SettingsView } from './views/SettingsView';
import { TabsView } from './views/TabsView';
import { TaskView } from './views/TaskView';
import './main.css';

type Tab = 'task' | 'tabs' | 'sessions' | 'actions' | 'history' | 'settings';
/** Lucide icons rather than emoji — the design spec rules emoji out of the UI entirely. */
const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: 'task', label: 'Task', icon: 'target' },
  { id: 'tabs', label: 'Tabs', icon: 'layers' },
  { id: 'sessions', label: 'Sessions', icon: 'archive' },
  { id: 'actions', label: 'Actions', icon: 'zap' },
  { id: 'history', label: 'History', icon: 'clock' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

function App() {
  const [tab, setTab] = useState<Tab>('task');
  const [autoOrganize, setAutoOrganize] = useState(false);
  const [resume, setResume] = useState<ResumeInfo | null>(null);
  const [finished, setFinished] = useState<SessionSummary | null>(null);

  const session = useLoad(() => rpc('session.active'), ['state']);
  const sessions = useLoad(() => rpc('session.list'), ['state']);
  const focus = useLoad(() => rpc('focus.state'), ['state']);
  const settings = useLoad(() => rpc('settings.get'), ['state']);

  const active = session.data ?? null;
  const goTabs = useCallback((organize: boolean) => {
    setAutoOrganize(organize);
    setTab('tabs');
  }, []);

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          {/* A leaf in an organic blob, replacing the plane glyph. */}
          <span className="logo">
            <Icon name="leaf" size={18} />
          </span>
          <div>
            <strong>TaskPilot</strong>
            <span className="sub">{active ? `${active.emoji} ${active.title}` : 'No active task'}</span>
          </div>
        </div>
      </header>

      <nav className="tabs-nav" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>
            <Icon name={t.icon} size={15} />
            {t.label}
          </button>
        ))}
      </nav>

      <main className="body">
        {session.error && tab === 'task' ? <p className="error">{session.error}</p> : null}
        {tab === 'task' ? (
          <TaskView
            session={active}
            focus={focus.data}
            saved={(sessions.data ?? []).filter((s) => s.status === 'saved' || s.status === 'finished')}
            resume={resume}
            dismissResume={() => setResume(null)}
            finished={finished}
            dismissFinished={() => setFinished(null)}
            onRestored={(r) => { setResume(r); setFinished(null); setTab('task'); }}
            onFinished={(s) => { setFinished(s); setResume(null); }}
            goTabs={goTabs}
          />
        ) : null}
        {tab === 'tabs' ? <TabsView session={active} autoOrganize={autoOrganize} consumeAuto={() => setAutoOrganize(false)} /> : null}
        {tab === 'sessions' ? (
          <SessionsView
            sessions={sessions.data ?? []}
            activeId={active?.sessionId ?? null}
            onRestored={(r) => { setResume(r); setFinished(null); setTab('task'); }}
          />
        ) : null}
        {tab === 'actions' ? <ActionsView /> : null}
        {tab === 'history' ? <HistoryView /> : null}
        {tab === 'settings' ? <SettingsView settings={settings.data} reload={settings.reload} /> : null}
      </main>
    </div>
  );
}

initTelemetry();
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </StrictMode>,
);
