import { useState } from "react";
import { validateLoginForm } from "../shared/login.ts";

type Props = {
  error: string | null;
  pending: boolean;
  tokenRequired: boolean;
  onSubmit: (username: string, password: string, token: string) => void;
};

export function Login({ error, pending, tokenRequired, onSubmit }: Props) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const parsed = validateLoginForm({ username, password, token }, { tokenRequired });
    if (!parsed.ok) {
      setLocalError(parsed.error);
      return;
    }
    setLocalError(null);
    onSubmit(parsed.value.username, parsed.value.password, parsed.value.token ?? "");
  }

  const message = localError ?? error;

  return (
    <main className="login">
      <div className="login-hero">
        <div className="brand">Agent-Portal</div>
        <div>
          <h1>Tickets, Zeiten und Agent an einem Ort.</h1>
          <p>Eine schnellere Oberfläche für TANSS. Der Agent bereitet vor, du entscheidest.</p>
        </div>
        <div className="foot">Anmeldung direkt gegen TANSS</div>
      </div>

      <div className="login-pane">
        <form className="login-form" onSubmit={handleSubmit}>
          <div className="login-head">
            <h2>Anmelden</h2>
            <p className="muted">Anmeldung über TANSS</p>
          </div>
          <div className="field">
            <label htmlFor="username">Benutzername</label>
            <input
              id="username"
              className="input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoFocus
              disabled={pending}
            />
          </div>
          <div className="field">
            <label htmlFor="password">Passwort</label>
            <input
              id="password"
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              disabled={pending}
            />
          </div>
          {tokenRequired ? (
            <div className="field">
              <label htmlFor="token">2FA-Code</label>
              <input
                id="token"
                className="input mono"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="6-stellig"
                disabled={pending}
              />
            </div>
          ) : (
            <p className="row small muted" role="status">
              <span className="dot ok" />
              <span>Der 2FA-Code wird aus dem hinterlegten Token-Schlüssel erzeugt.</span>
            </p>
          )}

          {message ? (
            <p className="notice danger" role="alert">
              <span className="dot danger" />
              <span>{message}</span>
            </p>
          ) : null}

          <button type="submit" className="btn primary login-submit" disabled={pending}>
            <span>{pending ? "Anmelden …" : "Anmelden"}</span>
            <span aria-hidden="true">→</span>
          </button>

          <p className="tiny muted pretty">
            Die TANSS-Session liegt in einem HttpOnly-Cookie dieses Servers; der Browser spricht nie
            selbst mit TANSS. Fehlermeldungen stammen unverändert von TANSS.
          </p>
        </form>
      </div>
    </main>
  );
}
