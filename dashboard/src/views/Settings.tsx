import { useState } from 'react';
import type { Status } from '../api';

const STDIO = `{
  "mcpServers": {
    "chinvat": {
      "command": "node",
      "args": ["<path-to>/Chinvat/hub/dist/index.js", "--stdio"]
    }
  }
}`;

const HTTP_URL = 'http://127.0.0.1:7777/mcp';

function Snippet({ title, note, code }: { title: string; note: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => { navigator.clipboard?.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1500); };
  return (
    <div className="panel pad">
      <div className="between" style={{ marginBottom: 4 }}>
        <h2>{title}</h2>
        <button className="btn sm" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
      <p className="hint">{note}</p>
      <pre className="out">{code}</pre>
    </div>
  );
}

export default function Settings({ status }: { status: Status | null }) {
  return (
    <div className="stack">
      <div className="panel pad">
        <h2>Connect a coordinator</h2>
        <p className="hint">
          Chinvat speaks MCP two ways. Any agent that speaks MCP can drive the hub — the same jobs, policy and approvals apply however it connects.
        </p>
        <div className="split" style={{ flexWrap: 'wrap' }}>
          <span className="chip dot autonomous">stdio · spawned per client</span>
          <span className="chip dot act">streamable http · {HTTP_URL}</span>
        </div>
      </div>

      <div className="grid c2">
        <Snippet title="Claude Code / Desktop" note="Add to .mcp.json (or Settings → Developer → Edit config). Point the path at your clone." code={STDIO} />
        <Snippet title="Any Streamable-HTTP client" note="Point the client at the hub's MCP endpoint while it's running." code={HTTP_URL} />
      </div>

      <div className="panel pad">
        <h2>Codex plugin</h2>
        <p className="hint">
          The repo ships a Codex plugin manifest under <span className="mono">clients/codex/</span> that references the same hub over stdio.
          See <span className="mono">clients/README.md</span> for the install steps.
        </p>
      </div>

      <div className="panel pad">
        <h2>This hub</h2>
        <div className="grid c3" style={{ marginTop: 6 }}>
          <Info k="Version" v={status?.version ?? '—'} />
          <Info k="Platform" v={status?.platform ?? '—'} />
          <Info k="Modules" v={status ? `${status.modules_enabled}/${status.modules_total} enabled` : '—'} />
        </div>
        <p className="hint" style={{ marginTop: 14, marginBottom: 0 }}>
          Secrets live only in <span className="mono">data/chinvat.config.json</span> on this machine and are never sent anywhere except the service they belong to. Remote access and per-user levels are on the roadmap — the hub binds to localhost until then.
        </p>
      </div>
    </div>
  );
}

function Info({ k, v }: { k: string; v: string }) {
  return <div className="panel stat" style={{ background: '#0e1b16' }}><div className="k">{k}</div><div className="v tiny" style={{ marginTop: 10 }}>{v}</div></div>;
}
