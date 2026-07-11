import { useEffect, useState } from 'react';
import { api, type ModuleView } from '../api';

const TIERS = ['observe', 'approve', 'autonomous'] as const;

export default function Modules({ tick, notify }: { tick: number; notify: (m: string) => void }) {
  const [mods, setMods] = useState<ModuleView[]>([]);
  const [open, setOpen] = useState<string | null>(null);

  const load = () => api.modules().then(setMods).catch(() => {});
  useEffect(() => { void load(); }, [tick]);

  return (
    <div className="grid c2">
      {mods.map((m) => (
        <ModuleCard key={m.name} m={m} open={open === m.name} onToggle={() => setOpen(open === m.name ? null : m.name)} notify={notify} reload={load} />
      ))}
    </div>
  );
}

function ModuleCard({ m, open, onToggle, notify, reload }: { m: ModuleView; open: boolean; onToggle: () => void; notify: (s: string) => void; reload: () => void }) {
  const [form, setForm] = useState<Record<string, any>>(m.config);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  useEffect(() => setForm(m.config), [m]);

  const setTier = async (tier: string) => { try { await api.setTier(m.name, tier); notify(`${m.name} → ${tier}`); reload(); } catch (e: any) { notify(e.message); } };
  const toggle = async () => { try { await api.setEnabled(m.name, !m.enabled); reload(); } catch (e: any) { notify(e.message); } };
  const test = async () => {
    setTesting(true);
    try {
      const h = await api.moduleTest(m.name);
      notify(`${m.name}: ${h.ok ? 'connected' : 'failed'}${h.detail ? ' — ' + h.detail : ''}`);
      reload();
    } catch (e: any) { notify(e.message); } finally { setTesting(false); }
  };
  const save = async () => {
    setSaving(true);
    try { await api.setConfig(m.name, form); notify(`${m.name} configuration saved`); reload(); }
    catch (e: any) { notify(e.message); } finally { setSaving(false); }
  };

  return (
    <div className="panel pad" style={{ gridColumn: open ? '1 / -1' : undefined }}>
      <div className="between">
        <div className="split">
          <span className={`hubdot ${m.health.ok ? 'up' : 'down'}`}><i /></span>
          <div>
            <div style={{ fontSize: 16, fontFamily: 'var(--serif)' }}>{m.name}{m.external && <span className="chip" style={{ marginLeft: 8 }}>external</span>}</div>
            <div className="faint" style={{ fontSize: 12 }}>{m.health.detail || m.description}</div>
          </div>
        </div>
        <div className="seg">
          {TIERS.map((t) => (
            <button key={t} className={`${t} ${m.tier === t ? 'on ' + t : ''}`} onClick={() => setTier(t)}>{t}</button>
          ))}
        </div>
      </div>

      <div className="between" style={{ marginTop: 12 }}>
        <div className="split" style={{ flexWrap: 'wrap', gap: 5 }}>
          {m.operations.map((o) => (
            <span key={o.name} className={`chip ${o.risk}`} title={o.description}>{o.name}</span>
          ))}
        </div>
        <div className="split">
          <button className="btn ghost sm" onClick={test} disabled={testing}>{testing ? 'Testing…' : 'Test connection'}</button>
          <button className="btn ghost sm" onClick={toggle}>{m.enabled ? 'Disable' : 'Enable'}</button>
          {m.configSchema.length > 0 && <button className="btn sm" onClick={onToggle}>{open ? 'Close' : 'Configure'}</button>}
        </div>
      </div>

      {open && m.configSchema.length > 0 && (
        <div style={{ marginTop: 18, borderTop: '1px solid var(--line-soft)', paddingTop: 16 }}>
          <div className="grid c2">
            {m.configSchema.map((f) => (
              <label className="field" key={f.key} style={{ gridColumn: f.type === 'boolean' ? '1 / -1' : undefined }}>
                <span className="cap">{f.label}{f.required && <span className="req">required</span>}</span>
                {f.type === 'boolean' ? (
                  <div className="split">
                    <input type="checkbox" style={{ width: 18, height: 18 }} checked={!!form[f.key]}
                      onChange={(e) => setForm({ ...form, [f.key]: e.target.checked })} />
                    <span className="faint">{f.help}</span>
                  </div>
                ) : (
                  <>
                    <input type={f.type === 'secret' ? 'password' : f.type === 'number' ? 'number' : 'text'}
                      value={form[f.key] ?? ''} placeholder={f.placeholder || (f.type === 'secret' ? '••••••' : '')}
                      onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} />
                    {f.help && <span className="help">{f.help}</span>}
                  </>
                )}
              </label>
            ))}
          </div>
          <div className="split" style={{ justifyContent: 'flex-end', marginTop: 4 }}>
            <button className="btn primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save configuration'}</button>
          </div>
        </div>
      )}
    </div>
  );
}
