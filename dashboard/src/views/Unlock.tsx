import { useState } from 'react';
import { api, setToken, UnauthorizedError } from '../api';

/**
 * Shown when the hub answers 401. A hub bound to a mesh address must carry an
 * authToken, which is exactly the case where someone sitting at that machine
 * still needs the dashboard — previously it loaded and then failed every call.
 */
export default function Unlock({ onUnlocked }: { onUnlocked: () => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const token = value.trim();
    if (!token) return;
    setBusy(true);
    setError(null);
    setToken(token);
    try {
      await api.status(); // the token is only accepted if the hub accepts it
      setValue('');
      onUnlocked();
    } catch (err) {
      setToken('');
      setError(
        err instanceof UnauthorizedError
          ? 'That token was rejected by the hub.'
          : err instanceof Error
            ? err.message
            : 'Could not reach the hub.'
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="unlock">
      <form className="unlock-card" onSubmit={submit}>
        <div className="wordmark">
          <span className="glyph">Chin<em>v</em>at</span>
        </div>
        <h2>This hub requires a token</h2>
        <p className="muted">
          It is bound beyond loopback, so every request must be authenticated. Paste the{' '}
          <code>authToken</code> from this machine&rsquo;s <code>data/chinvat.config.json</code>.
        </p>
        <input
          type="password"
          autoFocus
          autoComplete="off"
          spellCheck={false}
          placeholder="authToken"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        {error && <div className="unlock-error">{error}</div>}
        <button type="submit" disabled={busy || !value.trim()}>
          {busy ? 'Checking…' : 'Unlock'}
        </button>
        <p className="muted small">
          Stored in this browser only. Clear it any time from the sidebar.
        </p>
      </form>
    </div>
  );
}
