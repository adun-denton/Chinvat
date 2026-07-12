import { useEffect, useState } from 'react';
import { api, copy, type ClientView, type EndpointTest, type InstallPreview, type Status } from '../api';

export default function Connect({ status }: { status: Status | null }) {
  const [clients, setClients] = useState<ClientView[]>([]);
  const [endpoint, setEndpoint] = useState('http://127.0.0.1:7777/mcp');
  const [test, setTest] = useState<EndpointTest | null>(null);
  const [testing, setTesting] = useState(false);
  const [copied, setCopied] = useState('');

  useEffect(() => {
    api.connectClients().then((r) => { setClients(r.clients); setEndpoint(r.endpoint); }).catch(() => {});
  }, []);

  const runTest = async () => {
    setTesting(true); setTest(null);
    try { setTest(await api.connectTest()); } catch (e: any) { setTest({ ok: false, url: endpoint, detail: e.message }); }
    finally { setTesting(false); }
  };
  const flash = (id: string) => { setCopied(id); setTimeout(() => setCopied(''), 1400); };

  return (
    <div className="stack">
      <div className="panel pad">
        <div className="between" style={{ marginBottom: 4 }}>
          <h2>MCP endpoint</h2>
          <span className={`hubdot ${status ? 'up' : 'down'}`}><i />{status ? 'hub running' : 'hub offline'}</span>
        </div>
        <p className="hint">Streamable HTTP is the default way any coordinator connects. Point a client here, or use a card below.</p>
        <div className="split" style={{ flexWrap: 'wrap' }}>
          <code className="endpoint-url">{endpoint}</code>
          <button className="btn sm" onClick={() => { copy(endpoint); flash('ep'); }}>{copied === 'ep' ? 'Copied' : 'Copy URL'}</button>
          <button className="btn primary sm" onClick={runTest} disabled={testing}>{testing ? 'Testing…' : 'Test MCP endpoint'}</button>
          {test && (
            <span className={`chip dot ${test.ok ? 'succeeded' : 'failed'}`} title={test.detail}>
              {test.ok ? `ok · ${test.toolCount} tools · ${test.workerCount} workers` : 'failed'}
            </span>
          )}
        </div>
        {test && !test.ok && <pre className="out" style={{ marginTop: 12, color: 'var(--risk)' }}>{test.detail}</pre>}
      </div>

      <div className="grid c2">
        {clients.map((c) => <ClientCard key={c.id} c={c} onCopied={flash} copiedId={copied} />)}
      </div>

      <div className="panel pad">
        <p className="hint" style={{ margin: 0 }}>
          Auto-install writes only a <span className="mono">chinvat</span> entry into the user/global config, backs up any existing file first, and never touches your other servers. Project-scoped setups are copy-and-paste so nothing is written into a folder you didn't choose. Secrets stay in <span className="mono">data/chinvat.config.json</span> on this machine.
        </p>
      </div>
    </div>
  );
}

function ClientCard({ c, onCopied, copiedId }: { c: ClientView; onCopied: (id: string) => void; copiedId: string }) {
  const [open, setOpen] = useState(false);
  const [transport, setTransport] = useState(c.defaultTransport);
  const [preview, setPreview] = useState<InstallPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ path: string; backup: string | null; warning: string | null; test: EndpointTest } | null>(null);
  const [err, setErr] = useState('');

  const snippet = c.snippets[transport] ?? '';
  const cmd = c.oneCommand?.['global'] || c.oneCommand?.['project'];

  const doPreview = async () => {
    setErr(''); setBusy(true); setResult(null);
    try { setPreview(await api.connectPreview(c.id, transport)); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const confirm = async () => {
    setBusy(true); setErr('');
    try {
      const r = await api.connectApply(c.id, transport);
      const t = await api.connectTest();
      setResult({ path: r.path, backup: r.backup, warning: r.warning, test: t });
      setPreview(null);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="panel pad" style={{ gridColumn: open ? '1 / -1' : undefined }}>
      <div className="between">
        <div>
          <div className="split">
            <span style={{ fontFamily: 'var(--serif)', fontSize: 17 }}>{c.name}</span>
            {c.detected.installed
              ? <span className="chip dot succeeded" title={c.detected.via}>detected</span>
              : <span className="chip faint">not detected</span>}
          </div>
          <div className="faint" style={{ fontSize: 12, marginTop: 3, maxWidth: 460 }}>{c.blurb}</div>
        </div>
        <button className="btn sm" onClick={() => setOpen(!open)}>{open ? 'Close' : 'Connect'}</button>
      </div>

      <div className="split" style={{ marginTop: 10, flexWrap: 'wrap', gap: 6 }}>
        {c.transports.map((t) => <span key={t} className={`chip ${t === 'http' ? 'act' : ''}`}>{t === 'http' ? 'HTTP' : 'stdio'}{t === c.defaultTransport ? ' · default' : ''}</span>)}
        {c.scopes.map((s) => <span key={s} className="chip">{s}</span>)}
      </div>

      {open && (
        <div style={{ marginTop: 16, borderTop: '1px solid var(--line-soft)', paddingTop: 16 }}>
          {c.transports.length > 1 && (
            <div className="split" style={{ marginBottom: 12 }}>
              <span className="faint" style={{ fontSize: 12 }}>Transport</span>
              <div className="seg">
                {c.transports.map((t) => (
                  <button key={t} className={transport === t ? 'on autonomous' : ''} onClick={() => { setTransport(t); setPreview(null); setResult(null); }}>
                    {t === 'http' ? 'HTTP' : 'stdio'}
                  </button>
                ))}
              </div>
              {transport !== c.defaultTransport && <span className="faint" style={{ fontSize: 11 }}>advanced / fallback</span>}
            </div>
          )}

          <Field label="Config file">
            <div className="split" style={{ flexWrap: 'wrap' }}>
              <code className="path">{c.globalPath || c.projectPath}</code>
              <span className="chip">{c.format}</span>
            </div>
          </Field>

          <Field label={`Configuration (${transport})`}>
            <pre className="out">{snippet}</pre>
            <button className="btn sm" style={{ marginTop: 8 }} onClick={() => { copy(snippet); onCopied('cfg-' + c.id); }}>{copiedId === 'cfg-' + c.id ? 'Copied' : 'Copy configuration'}</button>
          </Field>

          {cmd && (
            <Field label="Or one command">
              <div className="split" style={{ flexWrap: 'wrap' }}>
                <code className="path">{cmd}</code>
                <button className="btn sm" onClick={() => { copy(cmd); onCopied('cmd-' + c.id); }}>{copiedId === 'cmd-' + c.id ? 'Copied' : 'Copy'}</button>
              </div>
            </Field>
          )}

          <div className="restart">
            <span className="faint" style={{ fontSize: 12 }}>After connecting</span>
            <div style={{ fontSize: 13 }}>{c.restart}</div>
          </div>
          {c.note && <p className="hint" style={{ marginTop: 10 }}>{c.note}</p>}

          {c.autoInstall && c.globalPath && (
            <div style={{ marginTop: 14 }}>
              {!preview && !result && (
                <button className="btn gold" disabled={busy} onClick={doPreview}>{busy ? 'Preparing…' : 'Install automatically (global)'}</button>
              )}
              {preview && (
                <div className="panel pad" style={{ background: '#0e1b16', marginTop: 4 }}>
                  <div className="lbl" style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--ink-faint)', marginBottom: 6 }}>
                    {preview.exists ? 'proposed change — existing file will be backed up' : 'proposed change — new file'}
                  </div>
                  <div className="faint" style={{ fontSize: 12, marginBottom: 8 }}>{preview.path}</div>
                  <pre className="out">{preview.after}</pre>
                  {preview.warning && <div className="restart" style={{ marginTop: 10 }}>{preview.warning}</div>}
                  <div className="split" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
                    <button className="btn ghost sm" onClick={() => setPreview(null)}>Cancel</button>
                    <button className="btn gold sm" disabled={busy} onClick={confirm}>{busy ? 'Writing…' : 'Confirm & write'}</button>
                  </div>
                </div>
              )}
              {result && (
                <div className="panel pad" style={{ background: '#0e1b16', marginTop: 4, borderColor: result.test.ok ? 'var(--bridge-deep)' : 'var(--risk-deep)' }}>
                  <div className="split" style={{ flexWrap: 'wrap' }}>
                    <span className={`chip dot ${result.test.ok ? 'succeeded' : 'failed'}`}>{result.test.ok ? 'connected' : 'endpoint test failed'}</span>
                    <span className="faint" style={{ fontSize: 12 }}>
                      {result.test.ok ? `${result.test.toolCount} tools · ${result.test.workerCount} workers` : result.test.detail}
                    </span>
                  </div>
                  <div className="faint" style={{ fontSize: 12, marginTop: 8 }}>Wrote {result.path}{result.backup ? ` · backed up existing config` : ''}.</div>
                  <div style={{ fontSize: 13, marginTop: 6 }}>{c.restart}</div>
                  {result.warning && <div className="restart" style={{ marginTop: 8 }}>{result.warning}</div>}
                </div>
              )}
            </div>
          )}
          {err && <pre className="out" style={{ color: 'var(--risk)', marginTop: 10 }}>{err}</pre>}
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: any }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div className="lbl" style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--ink-faint)', marginBottom: 6 }}>{label}</div>
      {children}
    </div>
  );
}
