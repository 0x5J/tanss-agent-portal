import { useEffect, useState } from "react";
import { api } from "../api.ts";
import type { LogEntry } from "../../shared/log.ts";
import { dayAndClock } from "../format.ts";
import { Dot, Icon, PageHeader, Segmented, Tile } from "../ui/kit.tsx";
import "../styles/import.css";

type Props = {
  onSubtitle: (text: string) => void;
  onError: (error: unknown) => void;
};

/** Every API request and TANSS call of this server, newest first, kept in memory only. */
export function LogView({ onSubtitle, onError }: Props) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [filter, setFilter] = useState<"all" | "errors">("all");
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

  const visible = [...entries].reverse().filter((e) => filter === "all" || !e.ok);
  const failed = entries.filter((e) => !e.ok).length;
  const subtitle = `${entries.length} Einträge · ${failed} fehlgeschlagen · nur im Arbeitsspeicher dieses Servers`;

  useEffect(() => {
    onSubtitle(subtitle);
  }, [subtitle, onSubtitle]);

  async function clear() {
    try {
      await api.clearLog();
      setEntries([]);
      setOpen(null);
    } catch (error) {
      onError(error);
    }
  }

  return (
    <div className="view tight wide" style={{ maxWidth: 1400 }}>
      <PageHeader title="Log" subtitle={subtitle}>
        <Segmented
          label="Filter"
          options={[
            { id: "all", label: "Alle", count: entries.length },
            { id: "errors", label: "Nur Fehler", count: failed },
          ]}
          value={filter}
          onChange={setFilter}
        />
        <button className="btn lg" onClick={() => void clear()} disabled={!entries.length}>
          Leeren
        </button>
      </PageHeader>

      <div className="tiles">
        <Tile label="Anfragen an das Portal" value={entries.filter((e) => e.kind === "request").length} />
        <Tile label="Aufrufe bei TANSS" value={entries.filter((e) => e.kind === "tanss").length} />
        <Tile label="Fehlgeschlagen" value={failed} tone={failed ? "danger" : undefined} />
      </div>

      <div className="table-scroll">
        <div className="table" style={{ minWidth: 760 }}>
          <div className="thead log-grid">
            <span>Zeitstempel</span>
            <span>Quelle</span>
            <span>Aufruf</span>
            <span>Status</span>
            <span style={{ textAlign: "right" }}>Dauer</span>
            <span />
          </div>
          {visible.length === 0 ? (
            <div style={{ padding: "24px 0" }} className="muted">
              {filter === "errors" && entries.length ? "Keine Fehler." : "Noch nichts protokolliert."}
            </div>
          ) : null}
          {visible.map((entry) => {
            const expanded = open === entry.id;
            return (
              <div key={entry.id}>
                <div
                  className={`trow clickable log-grid${expanded ? " selected" : ""}`}
                  onClick={() => setOpen(expanded ? null : entry.id)}
                  aria-expanded={expanded}
                >
                  <span className="num-cell muted">{dayAndClock(Math.floor(entry.at / 1000))}</span>
                  <span>
                    <span className="badge">{entry.kind === "request" ? "Portal" : "TANSS"}</span>
                  </span>
                  <span className="ellipsis" style={{ paddingRight: 16 }}>
                    <span style={{ fontWeight: 500 }}>{entry.method}</span> {entry.path}
                    {entry.message ? <span className="muted"> · {entry.message}</span> : null}
                  </span>
                  <span className="row" style={{ gap: 8 }}>
                    <Dot tone={entry.ok ? "ok" : "danger"} />
                    <span className="num-cell" style={entry.ok ? undefined : { color: "var(--red)", fontWeight: 500 }}>
                      {entry.status}
                    </span>
                  </span>
                  <span className="num-cell muted" style={{ textAlign: "right" }}>
                    {entry.durationMs} ms
                  </span>
                  <span className="muted" style={{ display: "flex", justifyContent: "flex-end" }}>
                    <Icon d={expanded ? "m18 15-6-6-6 6" : "m6 9 6 6 6-6"} size={14} stroke={2} />
                  </span>
                </div>
                {expanded ? (
                  <div className="log-detail">
                    {entry.redirected ? `umgeleitet nach ${entry.url}\n` : ""}
                    {entry.traceId ? `traceId ${entry.traceId}\n` : ""}
                    {entry.body ? `Nutzlast: ${entry.body}\n` : ""}
                    {entry.response ? `Antwort: ${entry.response}` : ""}
                    {!entry.body && !entry.response && !entry.redirected && !entry.traceId ? "(keine Details)" : ""}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
