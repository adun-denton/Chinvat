import { useEffect, useState } from 'react';
import { api, ago, short, type Job } from '../api';

const FILTERS = ['all', 'running', 'queued', 'waiting_approval', 'succeeded', 'failed', 'cancelled'];

export default function Jobs({ tick, notify }: { tick: number; notify: (m: string) => void }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [filter, setFilter] = useState('all');
  const [sel, setSel] = useState<string | null>(null);
  const [detail, setDetail] = useState<any>(null);

  const load = () => {
    const q = filter === 'all' ? '?limit=100' : `?status=${filter}&limit=100`;
    api.jobs(q).then(setJobs).catch(() => {});
  };
  useEffect(load, [filter, tick]);
  useEffect(() => { if (sel) api.job(sel).then(setDetail).catch(() => setDetail(null)); else setDetail(null); }, [sel, tick]);

  const cancel = async (id: string) => { try { await api.cancel(id); notify('Cancel requested'); load(); } catch (e: any) { notify(e.message); } };

  return (
    <div className="stack">
      <div className="split" style={{ flexWrap: 'wrap', gap: 6 }}>
        {FILTERS.map((f) => (
          <button key={f} className={`btn sm ${filter === f ? 'primary' : 'ghost'}`} onClick={() => setFilter(f)}>
            {f.replace('_', ' ')}
          </button>
        ))}
      </div>

      <div className="grid" style={{ gridTemplateColumns: detail ? '1fr 1fr' : '1fr' }}>
        <div className="panel pad">
          {jobs.length === 0 ? (
            <div className="empty"><div className="big">No jobs here</div>When a coordinator delegates work, it appears in this ledger.</div>
          ) : (
            <div className="rows">
              {jobs.map((job) => (
                <div key={job.id} className={`row click`} style={{ gridTemplateColumns: '1fr auto auto', background: sel === job.id ? '#ffffff08' : undefined }}
                  onClick={() => setSel(sel === job.id ? null : job.id)}>
                  <div>
                    <div><span className="mono dim">{job.module}</span> · {job.operation}</div>
                    <div className="faint" style={{ fontSize: 11.5, marginTop: 2 }}>{short(job.id)} · {ago(job.created_at)} · via {job.source}</div>
                  </div>
                  {job.parent_id && <span className="chip" title="has a parent">child</span>}
                  <span className={`chip dot ${job.status}`}>{job.status.replace('_', ' ')}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {detail && (
          <div className="panel pad">
            <div className="between" style={{ marginBottom: 12 }}>
              <h2>{detail.module}.{detail.operation}</h2>
              <button className="btn ghost sm" onClick={() => setSel(null)}>Close</button>
            </div>
            <div className="split" style={{ marginBottom: 14, flexWrap: 'wrap' }}>
              <span className={`chip dot ${detail.status}`}>{detail.status.replace('_', ' ')}</span>
              <span className="jid">{detail.id}</span>
              {['running', 'queued', 'waiting_approval'].includes(detail.status) && (
                <button className="btn danger sm" onClick={() => cancel(detail.id)}>Cancel</button>
              )}
            </div>

            <Section title="Arguments"><pre className="out">{JSON.stringify(detail.args, null, 2)}</pre></Section>
            {detail.error && <Section title="Error"><pre className="out" style={{ color: 'var(--risk)' }}>{detail.error}</pre></Section>}
            {detail.result != null && <Section title="Result"><pre className="out">{JSON.stringify(detail.result, null, 2)}</pre></Section>}
            {detail.artifacts?.length > 0 && (
              <Section title="Artifacts">
                {detail.artifacts.map((a: any) => (
                  <a key={a.name} className="chip" style={{ marginRight: 6 }} href={`/api/jobs/${detail.id}/artifacts/${a.name}`} target="_blank" rel="noreferrer">{a.name} · {a.size}B</a>
                ))}
              </Section>
            )}
            {detail.children?.length > 0 && (
              <Section title={`Child jobs (${detail.children.length})`}>
                <div className="tree-kids">
                  {detail.children.map((c: Job) => (
                    <div key={c.id} className="row" style={{ gridTemplateColumns: '1fr auto', padding: '7px 0' }}>
                      <span><span className="mono dim">{c.module}</span> · {c.operation}</span>
                      <span className={`chip dot ${c.status}`}>{c.status.replace('_', ' ')}</span>
                    </div>
                  ))}
                </div>
              </Section>
            )}
            <Section title="Timeline">
              <div className="rows">
                {detail.events?.slice(-14).map((e: any, i: number) => (
                  <div key={i} className="row" style={{ gridTemplateColumns: 'auto 1fr auto', padding: '6px 0', fontSize: 12 }}>
                    <span className="chip">{e.kind}</span>
                    <span className="faint mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {e.data ? JSON.stringify(e.data).slice(0, 90) : ''}
                    </span>
                    <span className="faint">{ago(e.ts)}</span>
                  </div>
                ))}
              </div>
            </Section>
          </div>
        )}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: any }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div className="lbl" style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'var(--ink-faint)', marginBottom: 6 }}>{title}</div>
      {children}
    </div>
  );
}
