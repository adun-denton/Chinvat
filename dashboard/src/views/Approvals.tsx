import { useEffect, useState } from 'react';
import { api, ago, short, type Approval } from '../api';

export default function Approvals({ tick, notify, onStatus }: { tick: number; notify: (m: string) => void; onStatus: () => void }) {
  const [items, setItems] = useState<Approval[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = () => api.approvals().then(setItems).catch(() => {});
  useEffect(load, [tick]);

  const decide = async (id: string, ok: boolean) => {
    setBusy(id);
    try {
      await (ok ? api.approve(id) : api.deny(id));
      notify(ok ? 'Approved — job released' : 'Denied');
      load(); onStatus();
    } catch (e: any) { notify(e.message); } finally { setBusy(null); }
  };

  if (items.length === 0)
    return (
      <div className="panel pad">
        <div className="empty">
          <div className="big">The gate is clear</div>
          Nothing is waiting to be weighed. Operations that exceed a module's tier will queue here for your decision.
        </div>
      </div>
    );

  return (
    <div className="stack">
      <div className="panel pad" style={{ borderColor: 'var(--gold-deep)' }}>
        <div className="split"><span className="chip approve dot">{items.length} waiting</span>
          <span className="faint">Approve to release the job into the queue; deny to cancel it.</span></div>
      </div>
      {items.map((a) => (
        <div className="panel pad" key={a.id}>
          <div className="between" style={{ marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 16 }}><span className="mono dim">{a.module}</span> · <strong>{a.operation}</strong></div>
              <div className="faint" style={{ fontSize: 12, marginTop: 3 }}>job {short(a.job_id)} · requested {ago(a.requested_at)}</div>
            </div>
            <div className="split">
              <button className="btn danger" disabled={busy === a.id} onClick={() => decide(a.id, false)}>Deny</button>
              <button className="btn gold" disabled={busy === a.id} onClick={() => decide(a.id, true)}>Approve</button>
            </div>
          </div>
          <pre className="out">{JSON.stringify(a.args, null, 2)}</pre>
        </div>
      ))}
    </div>
  );
}
