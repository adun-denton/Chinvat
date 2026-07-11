import { useCallback, useEffect, useState } from 'react';
import { api, useHubEvents, type Status } from './api';
import Overview from './views/Overview';
import Jobs from './views/Jobs';
import Approvals from './views/Approvals';
import Modules from './views/Modules';
import Playground from './views/Playground';
import Settings from './views/Settings';

type ViewId = 'overview' | 'jobs' | 'approvals' | 'modules' | 'playground' | 'settings';

const I = {
  overview: 'M3 12l9-8 9 8M5 10v9h5v-6h4v6h5v-9',
  jobs: 'M4 6h16M4 12h16M4 18h10',
  approvals: 'M20 6L9 17l-5-5',
  modules: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  playground: 'M5 3l14 9-14 9z',
  settings: 'M12 8a4 4 0 100 8 4 4 0 000-8zM2 12h3M19 12h3M12 2v3M12 19v3',
};

function Icon({ d }: { d: string }) {
  return (
    <svg className="ni" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
      strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
  );
}

const NAV: { id: ViewId; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'jobs', label: 'Jobs' },
  { id: 'approvals', label: 'Approvals' },
  { id: 'modules', label: 'Modules' },
  { id: 'playground', label: 'Playground' },
  { id: 'settings', label: 'Settings' },
];

const TITLES: Record<ViewId, { h: string; sub: string }> = {
  overview: { h: 'The Crossing', sub: 'what your agents are moving across the bridge' },
  jobs: { h: 'Jobs', sub: 'every task submitted to the hub' },
  approvals: { h: 'Approvals', sub: 'work waiting to be weighed' },
  modules: { h: 'Modules', sub: 'the workers on the far bank' },
  playground: { h: 'Playground', sub: 'call a module by hand' },
  settings: { h: 'Settings', sub: 'connect a coordinator to Chinvat' },
};

export default function App() {
  const [view, setView] = useState<ViewId>('overview');
  const [status, setStatus] = useState<Status | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const refreshStatus = useCallback(() => { api.status().then(setStatus).catch(() => setStatus(null)); }, []);

  useEffect(() => {
    refreshStatus();
    const t = setInterval(refreshStatus, 5000);
    return () => clearInterval(t);
  }, [refreshStatus]);

  const connected = useHubEvents(
    useCallback((evt: any) => {
      setTick((n) => n + 1); // nudge child views to refetch
      if (evt.type === 'approval.requested') setFlash('New approval request');
      if (evt.type === 'job.status' || evt.type === 'approval.resolved') refreshStatus();
    }, [refreshStatus])
  );

  useEffect(() => { if (!flash) return; const t = setTimeout(() => setFlash(null), 2600); return () => clearTimeout(t); }, [flash]);

  const notify = useCallback((m: string) => setFlash(m), []);
  const pending = status?.pending_approvals ?? 0;
  const t = TITLES[view];

  return (
    <div className="shell">
      <aside className="rail">
        <div className="wordmark">
          <span className="glyph">Chin<em>v</em>at</span>
        </div>
        <nav className="nav">
          {NAV.map((n) => (
            <button key={n.id} className={view === n.id ? 'active' : ''} onClick={() => setView(n.id)}>
              <Icon d={I[n.id]} />
              {n.label}
              {n.id === 'approvals' && pending > 0 && <span className="badge">{pending}</span>}
            </button>
          ))}
        </nav>
        <div className="foot">
          <div className={`hubdot ${connected ? 'up' : 'down'}`}>
            <i />{connected ? 'hub connected' : 'hub offline'}
          </div>
          {status && (
            <div className="faint mono" style={{ fontSize: 11, marginTop: 6 }}>
              v{status.version} · {status.platform} · up {Math.round(status.uptime_sec / 60)}m
            </div>
          )}
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <h1>{t.h}</h1>
          <span className="sub">{t.sub}</span>
        </header>
        <section className="content">
          {view === 'overview' && <Overview status={status} tick={tick} onGo={setView} />}
          {view === 'jobs' && <Jobs tick={tick} notify={notify} />}
          {view === 'approvals' && <Approvals tick={tick} notify={notify} onStatus={refreshStatus} />}
          {view === 'modules' && <Modules tick={tick} notify={notify} />}
          {view === 'playground' && <Playground notify={notify} />}
          {view === 'settings' && <Settings status={status} />}
        </section>
      </main>

      {flash && <div className="flash">{flash}</div>}
    </div>
  );
}
