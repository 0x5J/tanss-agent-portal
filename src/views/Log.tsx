import { useEffect, useState } from "react";
import { api } from "../api.ts";
import type { LogEntry } from "../../shared/log.ts";
import { dayAndClock } from "../format.ts";

type Props = {
  onSubtitle: (text: string) => void;
  onError: (error: unknown) => void;
};

export function LogView({ onSubtitle, onError }: Props) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [onlyErrors, setOnlyErrors] = useState(false);
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    let lastId = 0;
    async function poll() {
      try {
        const result = await api.log(lastId);
        if (cancelled) return;
        if (result.entries.length) {
          setEntries((current) => [...current, ...result.entries].slice(-300));
          lastId = result.lastId;
        }
      } catch (error) {
        if (!cancelled) onError(error);
      }
    }
    void poll();
    const handle = window.setInterval(poll, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [onError]);

  const visible = [...entries].reverse().filter((e) => !onlyErrors || !e.ok);
  const failed = entries.filter((e) => !e.ok).length;

  useEffect(() => {
    onSubtitle(`${entries.length} Einträge · ${failed} fehlgeschlagen · nur im Arbeitsspeicher`);
  }, [entries.length, failed, onSubtitle]);

  async function clear() {
    try {
      await api.clearLog();
      setEntries([]);
    } catch (error) {
      onError(error);
    }
  }

  return (
    <div style={{ padding: 16 }}>
      <div className="card pad row" style={{ marginBottom: 14, gap: 26 }}>
        <span className="small muted">Dieser Server</span>
        <span>
          <span className="mono">{entries.filter((e) => e.kind === "request").length}</span> Anfragen
        </span>
        <span>
          <span className="mono">{entries.filter((e) => e.kind === "tanss").length}</span> TANSS-Aufrufe
        </span>
        <span>
          <span className="mono" style={{ color: failed ? "var(--danger)" : undefined }}>{failed}</span> fehlgeschlagen
        </span>
        <label className="row small muted" style={{ marginLeft: "auto", cursor: "pointer" }}>
          <input type="checkbox" checked={onlyErrors} onChange={(e) => setOnlyErrors(e.target.checked)} /> Nur Fehler
        </label>
        <button className="btn muted" onClick={clear}>
          Leeren
        </button>
      </div>

      <div className="log-head">
        <span>Zeitstempel</span>
        <span>Quelle</span>
        <span>Aufruf</span>
        <span>Status</span>
        <span style={{ textAlign: "right" }}>Dauer</span>
      </div>
      {visible.length === 0 ? (
        <div className="muted small" style={{ padding: 12 }}>
          Noch nichts protokolliert.
        </div>
      ) : null}
      {visible.map((entry) => (
        <div key={entry.id}>
          <div className="log-row" onClick={() => setOpen(open === entry.id ? null : entry.id)}>
            <span className="mono small muted">{dayAndClock(Math.floor(entry.at / 1000))}</span>
            <span className={`badge${entry.kind === "request" ? " agent" : ""}`}>
              {entry.kind === "request" ? "API" : "TANSS"}
            </span>
            <span className="mono small ellipsis">
              {entry.method} {entry.path}
              {entry.message ? <span className="muted"> · {entry.message}</span> : null}
            </span>
            <span className="row small">
              <span className={`dot xs ${entry.ok ? "ok" : "danger"}`} />
              <span className="mono">{entry.status}</span>
            </span>
            <span className="mono small muted" style={{ textAlign: "right" }}>
              {entry.durationMs} ms
            </span>
          </div>
          {open === entry.id ? (
            <div className="log-detail">
              {entry.redirected ? `umgeleitet nach ${entry.url}\n` : ""}
              {entry.traceId ? `traceId ${entry.traceId}\n` : ""}
              {entry.body ? `Nutzlast: ${entry.body}\n` : ""}
              {entry.response ? `Antwort: ${entry.response}` : ""}
              {!entry.body && !entry.response && !entry.redirected ? "(keine Details)" : ""}
            </div>
          ) : null}
        </div>
      ))}
      <div style={{ height: 60 }} />
    </div>
  );
}
