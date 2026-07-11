import { useEffect, useState } from 'react';
import { api, type ModuleView } from '../api';

export default function Playground({ notify }: { notify: (m: string) => void }) {
  const [mods, setMods] = useState<ModuleView[]>([]);
  const [mod, setMod] = useState('');
  const [op, setOp] = useState('');
  const [args, setArgs] = useState('{\n  \n}');
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<any>(null);

  useEffect(() => { api.modules().then((m) => { setMods(m); if (m[0]) { setMod(m[0].name); setOp(m[0].operations[0]?.name || ''); } }).catch(() => {}); }, []);

  const current = mods.find((m) => m.name === mod);
  const currentOp = current?.operations.find((o) => o.name === op);

  const run = async () => {
    let parsed: any = {};
    try { parsed = args.trim() ? JSON.parse(args) : {}; } catch { notify('Arguments must be valid JSON'); return; }
    setBusy(true); setOut(null);
    try {
      const job = await api.submit({ module: mod, operation: op, args: parsed, mode: 'async' });
      for (let i = 0; i < 120; i++) {
        const d = await api.job(job.id);
        if (['succeeded', 'failed', 'cancelled', 'waiting_approval'].includes(d.status)) { setOut(d); break; }
        await new Promise((r) => setTimeout(r, 500));
      }
    } catch (e: any) { notify(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="grid c2">
      <div className="panel pad">
        <h2>Call a module</h2>
        <p className="hint">Same path an agent takes — submitted as a job, weighed by policy.</p>
        <label className="field">
          <span className="cap">Module</span>
          <select value={mod} onChange={(e) => { setMod(e.target.value); const mm = mods.find((x) => x.name === e.target.value); setOp(mm?.operations[0]?.name || ''); }}>
            {mods.map((m) => <option key={m.name} value={m.name} disabled={!m.enabled}>{m.name}{m.enabled ? '' : ' (disabled)'}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="cap">Operation</span>
          <select value={op} onChange={(e) => setOp(e.target.value)}>
            {current?.operations.map((o) => <option key={o.name} value={o.name}>{o.name} — {o.risk}</option>)}
          </select>
        </label>
        {currentOp && (
          <div className="split" style={{ marginBottom: 12 }}>
            <span className={`chip ${currentOp.risk}`}>{currentOp.risk}</span>
            <span className="faint" style={{ fontSize: 12 }}>{currentOp.description}</span>
          </div>
        )}
        <label className="field">
          <span className="cap">Arguments (JSON){currentOp && Object.keys(currentOp.params).length > 0 && <span className="faint">keys: {Object.keys(currentOp.params).join(', ')}</span>}</span>
          <textarea rows={8} value={args} onChange={(e) => setArgs(e.target.value)} />
        </label>
        <button className="btn primary" disabled={busy || !mod} onClick={run}>{busy ? 'Running…' : 'Run'}</button>
      </div>

      <div className="panel pad">
        <h2>Result</h2>
        <p className="hint">{out ? `job ${out.id.slice(0, 8)} · ${out.status}` : 'output appears here'}</p>
        {!out ? (
          <div className="empty"><div className="big">Awaiting a call</div>Pick a module and operation, then Run.</div>
        ) : out.status === 'waiting_approval' ? (
          <div className="stack">
            <span className="chip waiting_approval dot">waiting approval</span>
            <p className="dim">This operation exceeds the module's tier. Approve it on the Approvals page, then re-open the job to see its result.</p>
          </div>
        ) : (
          <>
            <span className={`chip dot ${out.status}`} style={{ marginBottom: 10 }}>{out.status}</span>
            {out.error && <pre className="out" style={{ color: 'var(--risk)' }}>{out.error}</pre>}
            {out.result != null && <pre className="out">{JSON.stringify(out.result, null, 2)}</pre>}
          </>
        )}
      </div>
    </div>
  );
}
