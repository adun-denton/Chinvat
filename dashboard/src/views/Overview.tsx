import { useEffect, useState } from 'react';
import { api, short, type Job, type Status } from '../api';

const AGENTS = ['Claude Code', 'Claude Desktop', 'Codex', 'Cursor'];

export default function Overview({ status, tick, onGo }: { status: Status | null; tick: number; onGo: (v: any) => void }) {
  const [recent, setRecent] = useState<Job[]>([]);
  const [modules, setModules] = useState<{ name: string; enabled: boolean }[]>([]);

  useEffect(() => {
    api.jobs('?limit=6').then(setRecent).catch(() => {});
    api.modules().then((m) => setModules(m.map((x) => ({ name: x.name, enabled: x.enabled })))).catch(() => {});
  }, [tick]);

  const j = status?.jobs ?? {};
  const running = (j.running ?? 0) + (j.queued ?? 0);
  const waiting = j.waiting_approval ?? 0;
  const done = j.succeeded ?? 0;
  const failed = (j.failed ?? 0) + (j.cancelled ?? 0);
  const enabled = modules.filter((m) => m.enabled).map((m) => m.name);

  return (
    <div className="stack">
      <div className="panel crossing">
        <div className="between">
          <span className="lbl">the crossing</span>
          <span className="lbl">{running} in transit · {waiting} at the gate</span>
        </div>
        <div className="span-wrap">
          <div className="bank left">
            <div className="who">Coordinators</div>
            <div className="lst">{AGENTS.join(' · ')}</div>
          </div>
          <div className="deck" />
          <div className="pier" style={{ left: '25%' }} />
          <div className="pier" style={{ left: '75%' }} />
          {[0, 1, 2].map((i) => (
            <div key={i} className={`mote ${running > 0 ? 'run' : ''}`} style={{ animationDelay: `${i * 1.5}s`, left: '130px' }} />
          ))}
          <div className={`gate ${waiting > 0 ? '' : 'clear'}`}>
            {waiting > 0 ? `⚖ ${waiting} awaiting approval` : '⚖ policy gate · clear'}
          </div>
          <div className="bank right">
            <div className="who">The world</div>
            <div className="lst">{enabled.length ? enabled.join(' · ') : 'no modules enabled'}</div>
          </div>
        </div>
      </div>

      <div className="grid c4">
        <div className="panel stat"><div className="k">In transit</div><div className="v"><em>{running}</em></div></div>
        <div className="panel stat"><div className="k">At the gate</div><div className="v" style={{ color: waiting ? 'var(--gold)' : undefined }}>{waiting}</div></div>
        <div className="panel stat"><div className="k">Crossed</div><div className="v">{done}</div></div>
        <div className="panel stat"><div className="k">Turned back</div><div className="v tiny" style={{ marginTop: 12 }}>{failed} failed / cancelled</div></div>
      </div>

      <div className="grid c2">
        <div className="panel pad">
          <div className="between" style={{ marginBottom: 12 }}>
            <h2>Recent jobs</h2>
            <button className="btn ghost sm" onClick={() => onGo('jobs')}>View all</button>
          </div>
          {recent.length === 0 ? (
            <div className="empty"><div className="big">Nothing has crossed yet</div>Delegate a task from a coordinator, or try the Playground.</div>
          ) : (
            <div className="rows">
              {recent.map((job) => (
                <div className="row" key={job.id} style={{ gridTemplateColumns: '1fr auto auto' }}>
                  <div><span className="mono dim">{job.module}</span> · {job.operation}</div>
                  <span className={`chip dot ${job.status}`}>{job.status.replace('_', ' ')}</span>
                  <span className="jid">{short(job.id)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="panel pad">
          <h2>Attention</h2>
          <p className="hint">what the bridge-keeper should look at</p>
          <div className="stack" style={{ gap: 10 }}>
            <Line label="Pending approvals" value={waiting} cta={waiting ? 'Review' : undefined} onClick={() => onGo('approvals')} tone="gold" />
            <Line label="Modules enabled" value={`${status?.modules_enabled ?? 0} / ${status?.modules_total ?? 0}`} cta="Configure" onClick={() => onGo('modules')} />
            <Line label="Failed / cancelled" value={failed} tone={failed ? 'risk' : undefined} cta={failed ? 'Inspect' : undefined} onClick={() => onGo('jobs')} />
          </div>
        </div>
      </div>
    </div>
  );
}

function Line({ label, value, cta, onClick, tone }: { label: string; value: any; cta?: string; onClick?: () => void; tone?: 'gold' | 'risk' }) {
  const color = tone === 'gold' ? 'var(--gold)' : tone === 'risk' ? 'var(--risk)' : undefined;
  return (
    <div className="between" style={{ padding: '8px 0', borderBottom: '1px solid var(--line-soft)' }}>
      <span className="dim">{label}</span>
      <div className="split">
        <span className="mono" style={{ color, fontSize: 15 }}>{value}</span>
        {cta && <button className="btn ghost sm" onClick={onClick}>{cta}</button>}
      </div>
    </div>
  );
}
