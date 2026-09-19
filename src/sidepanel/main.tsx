import { StrictMode, useCallback, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { rpc } from '../shared/rpc';
import type { ResumeInfo, SessionSummary } from '../shared/types';
import { ToastProvider, useLoad } from './hooks';
import { initTelemetry } from './telemetry';
import { HistoryView } from './views/HistoryView';
import { SessionsView } from './views/SessionsView';
import { SettingsView } from './views/SettingsView';
import { TabsView } from './views/TabsView';
import { TaskView } from './views/TaskView';
import './main.css';

type Tab = 'task' | 'tabs' | 'sessions' | 'history' | 'settings';
const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'task', label: 'Task', icon: '🎯' },
  { id: 'tabs', label: 'Tabs', icon: '🗂' },
  { id: 'sessions', label: 'Sessions', icon: '💾' },
  { id: 'history', label: 'History', icon: '🕘' },
  { id: 'settings', label: 'Settings', icon: '⚙️' },
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
          <span className="logo" aria-hidden>✈</span>
          <div>
            <strong>TaskPilot</strong>
            <span className="sub">{active ? `${active.emoji} ${active.title}` : 'No active task'}</span>
          </div>
        </div>
      </header>

      <nav className="tabs-nav" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>
            <span aria-hidden>{t.icon}</span> {t.label}
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
