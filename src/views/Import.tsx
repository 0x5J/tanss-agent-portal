import { useCallback, useEffect, useState } from "react";
import { api, type ImportBookItem, type Meta } from "../api.ts";
import { formatLongDate } from "../../shared/days.ts";
import { formatHm, parseDuration } from "../../shared/duration.ts";
import { ROUND_CHOICES, type ImportRules, type Suggestion, type WorkflowState } from "../../shared/import.ts";
import type { Target } from "../../shared/mapping.ts";
import { formatClock } from "../../shared/timeline.ts";
import { todayYmd } from "../format.ts";
import { findTargets, type Target as Target2 } from "../targets.ts";

type Row = Suggestion & { mapping: Target | null; bookedSupportId: number | null };

type Draft = {
  start: string;
  duration: string;
  text: string;
  ticketId: number | null;
  companyId: number | null;
  targetLabel: string;
  typeId: number;
  confirmed: boolean;
  dropped: boolean;
  error: string;
};

type Props = {
  /** False when no LINEAR_API_KEY is configured on the server. */
  configured: boolean;
  /** True when a local model is set up — enables "formulieren". */
  agentReady: boolean;
  meta: Meta | null;
  reload: number;
  onSubtitle: (text: string) => void;
  onError: (error: unknown) => void;
  onToast: (text: string) => void;
  onChanged: () => void;
};

/**
 * The day read out of Linear, turned into booking suggestions. Nothing is
 * booked without confirmation, and every rule that changed a duration stays
 * visible on the suggestion instead of quietly shrinking a number.
 */
export function ImportView(props: Props) {
  const [day, setDay] = useState(todayYmd());
  const [rows, setRows] = useState<Row[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [rules, setRules] = useState<ImportRules | null>(null);
  const [states, setStates] = useState<WorkflowState[]>([]);
  const [loading, setLoading] = useState(false);
  const [booking, setBooking] = useState(false);
  const [phrasing, setPhrasing] = useState<string | null>(null);
  const [capped, setCapped] = useState(false);
  const { onSubtitle, onError } = props;
  const types = props.meta?.supportTypes ?? [];

  useEffect(() => {
    onSubtitle(props.configured ? "" : "keine Verbindung");
  }, [onSubtitle, props.configured]);

  useEffect(() => {
    if (!props.configured) return;
    let cancelled = false;
    api.import
      .states()
      .then((r) => {
        if (cancelled) return;
        setStates(r.items);
        setRules(r.rules);
      })
      .catch((error: unknown) => !cancelled && onError(error));
    return () => {
      cancelled = true;
    };
  }, [props.configured, onError]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.import.day(day);
      setRows(result.suggestions);
      setRules(result.rules);
      setCapped(result.capped);
      setDrafts(
        Object.fromEntries(
          result.suggestions.map((s) => [
            s.issue,
            {
              start: formatClock(s.start),
              duration: formatHm(s.minutes),
              text: s.text,
              ticketId: s.mapping?.ticketId ?? null,
              companyId: s.mapping?.companyId ?? null,
              targetLabel: s.mapping?.ticketLabel || s.mapping?.companyLabel || "",
              typeId: s.mapping?.typeId ?? types[0]?.id ?? 0,
              confirmed: false,
              dropped: false,
              error: "",
            },
          ]),
        ),
      );
    } catch (error) {
      onError(error);
    } finally {
      setLoading(false);
    }
  }, [day, onError, types]);

  async function saveRules(next: ImportRules) {
    setRules(next);
    try {
      await api.import.saveRules(next);
    } catch (error) {
      onError(error);
    }
  }

  /** Bring the raw Linear notes into the shape a booking text has here. */
  async function phrase(row: Row) {
    setPhrasing(row.issue);
    try {
      const result = await api.agent.importText({
        issue: row.issue,
        title: row.title,
        project: row.project,
        notes: row.text,
      });
      patch(row.issue, { text: result.text });
    } catch (error) {
      onError(error);
    } finally {
      setPhrasing(null);
    }
  }

  function patch(issue: string, change: Partial<Draft>) {
    setDrafts((d) => ({ ...d, [issue]: { ...d[issue]!, ...change } }));
  }

  const open = (rows ?? []).filter((r) => !r.bookedSupportId && !drafts[r.issue]?.dropped);
  const ready = open.filter((r) => {
    const draft = drafts[r.issue];
    return draft?.confirmed && (draft.ticketId || draft.companyId) && draft.typeId && parseDuration(draft.duration);
  });
  const readyMinutes = ready.reduce((sum, r) => sum + (parseDuration(drafts[r.issue]!.duration) ?? 0), 0);

  async function bookConfirmed() {
    setBooking(true);
    try {
      const items: ImportBookItem[] = ready.map((r) => {
        const draft = drafts[r.issue]!;
        const [h, m] = draft.start.split(":");
        return {
          issue: r.issue,
          startMinute: Number(h) * 60 + Number(m),
          duration: parseDuration(draft.duration)!,
          text: draft.text.trim(),
          ...(draft.ticketId ? { ticketId: draft.ticketId } : { companyId: draft.companyId! }),
          typeId: draft.typeId,
        };
      });
      const result = await api.import.book(day, items);
      for (const line of result.results) {
        if (line.error) patch(line.issue, { error: line.error, confirmed: false });
      }
      props.onToast(
        result.booked === items.length
          ? `${result.booked} Leistungen gebucht`
          : `${result.booked} von ${items.length} gebucht — der Rest steht mit Grund in der Zeile`,
      );
      props.onChanged();
      await load();
    } catch (error) {
      onError(error);
    } finally {
      setBooking(false);
    }
  }

  if (!props.configured) {
    return (
      <div style={{ padding: 16, maxWidth: 720 }}>
        <div className="empty">
          <div className="title">Keine Linear-Verbindung eingerichtet.</div>
          <div className="small muted pretty" style={{ maxWidth: "68ch" }}>
            Für den Tagesimport braucht der Server einen persönlichen Linear-API-Key:{" "}
            <span className="mono">LINEAR_API_KEY</span> in die <span className="mono">.env</span>, dann{" "}
            <span className="mono">docker compose up -d</span>. Den Key gibt es in Linear unter Settings → API →
            Personal API keys. Alles andere im Portal funktioniert unabhängig davon.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: 16, maxWidth: 1100 }}>
      <div className="card pad" style={{ marginBottom: 14 }}>
        <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
          <input className="input mono" type="date" value={day} onChange={(e) => setDay(e.target.value)} style={{ width: 150 }} />
          <button className="btn primary" disabled={loading} onClick={() => void load()}>
            {loading ? "lädt …" : "Aus Linear laden"}
          </button>
          <span className="small muted pretty">
            {formatLongDate(day)} · Zeiten aus eigenen Kommentaren und Statuswechseln, in Europe/Berlin.
          </span>
        </div>
        {capped ? (
          <div className="row tiny" style={{ marginTop: 8, gap: 6 }}>
            <span className="dot xs warn" />
            <span className="pretty">
              Es wurden 50 zuletzt berührte Issues gelesen — die Grenze war erreicht, der Tag kann unvollständig sein.
            </span>
          </div>
        ) : null}
      </div>

      {rules ? <RulesCard rules={rules} states={states} onChange={(next) => void saveRules(next)} /> : null}

      {rows === null ? (
        <div className="muted small" style={{ padding: "18px 2px" }}>Noch nichts geladen.</div>
      ) : rows.length === 0 ? (
        <div className="empty">
          <div className="title">Keine buchbare Zeit an diesem Tag.</div>
          <div className="small muted pretty" style={{ maxWidth: "68ch" }}>
            Entweder gab es keine Aktivität, oder die Regeln unten zählen die betroffenen Status nicht.
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {rows.map((row) => {
            const draft = drafts[row.issue];
            if (!draft) return null;
            const minutes = parseDuration(draft.duration);
            const hasTarget = Boolean(draft.ticketId || draft.companyId);
            return (
              <div key={row.issue} className={`card pad import-row${draft.dropped ? " dropped" : ""}`}>
                <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                  <span className="badge">{row.issue}</span>
                  <span className="small ellipsis" style={{ flex: 1, minWidth: 160 }}>{row.title}</span>
                  <span className="tiny muted">{row.project}</span>
                  {row.bookedSupportId ? (
                    <span className="chip">gebucht · TANSS #{row.bookedSupportId}</span>
                  ) : draft.dropped ? (
                    <button className="btn ghost small" onClick={() => patch(row.issue, { dropped: false })}>
                      zurückholen
                    </button>
                  ) : (
                    <>
                      <button className="btn ghost small danger-hover" onClick={() => patch(row.issue, { dropped: true })}>
                        verwerfen
                      </button>
                      <button
                        className={draft.confirmed ? "btn agent small" : "btn small"}
                        disabled={!hasTarget || !minutes}
                        title={hasTarget ? "" : "Ohne Ticket oder Kunde kann nicht gebucht werden"}
                        onClick={() => patch(row.issue, { confirmed: !draft.confirmed })}
                      >
                        {draft.confirmed ? "bestätigt ✓" : "bestätigen"}
                      </button>
                    </>
                  )}
                </div>

                {row.bookedSupportId || draft.dropped ? null : (
                  <>
                    <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                      <label className="row tiny muted" style={{ gap: 4 }}>
                        ab
                        <input className="input mono" value={draft.start} onChange={(e) => patch(row.issue, { start: e.target.value })} style={{ width: 74 }} />
                      </label>
                      <label className="row tiny muted" style={{ gap: 4 }}>
                        Dauer
                        <input
                          className="input mono"
                          value={draft.duration}
                          onChange={(e) => patch(row.issue, { duration: e.target.value })}
                          style={{ width: 74, borderColor: minutes ? undefined : "var(--danger)" }}
                        />
                      </label>
                      <span className="tiny muted">
                        {row.raw === row.minutes ? "exakt" : `${row.raw} min roh`} · Vorschlag {formatHm(row.minutes)}
                      </span>
                      <TargetPicker
                        draft={draft}
                        types={types}
                        onPatch={(change) => patch(row.issue, change)}
                        onRemember={async (target) => {
                          try {
                            await api.import.remember(row.project, target);
                            props.onToast(`Zuordnung für „${row.project}" gemerkt`);
                          } catch (error) {
                            onError(error);
                          }
                        }}
                      />
                    </div>
                    <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 5 }}>
                      <textarea
                        className="textarea"
                        rows={2}
                        value={draft.text}
                        onChange={(e) => patch(row.issue, { text: e.target.value })}
                      />
                      <div className="row" style={{ gap: 8 }}>
                        <button
                          className="btn agent small"
                          disabled={!props.agentReady || phrasing !== null}
                          title={
                            props.agentReady
                              ? "Die Notizen aus Linear in einen Leistungstext in deinem Stil bringen"
                              : "KI nicht eingerichtet (Einstellungen)"
                          }
                          onClick={() => void phrase(row)}
                        >
                          {phrasing === row.issue ? (
                            <>
                              <span className="dot xs agent pulse" /> formuliert …
                            </>
                          ) : (
                            "aus Issue formulieren"
                          )}
                        </button>
                        <span className="tiny muted">
                          Nutzt deine Stilregeln und Musterbeispiele aus den Einstellungen.
                        </span>
                      </div>
                    </div>
                  </>
                )}

                {row.flags.length ? (
                  <div className="row" style={{ gap: 5, flexWrap: "wrap", marginTop: 8 }}>
                    {row.flags.map((flag, i) => (
                      <span key={i} className="chip" title={flag.reason}>
                        {flag.label}
                      </span>
                    ))}
                  </div>
                ) : null}
                {row.flags.length ? (
                  <div className="tiny muted pretty" style={{ marginTop: 5 }}>
                    {row.flags.map((f) => f.reason).join(" ")}
                  </div>
                ) : null}
                {draft.error ? (
                  <div className="tiny" style={{ color: "var(--danger)", marginTop: 5 }}>{draft.error}</div>
                ) : null}
              </div>
            );
          })}

          <div className="row" style={{ gap: 10, marginTop: 4 }}>
            <span className="small muted">
              {ready.length} von {open.length} bestätigt · {formatHm(readyMinutes)} Std.
            </span>
            <button
              className="btn primary"
              style={{ marginLeft: "auto" }}
              disabled={booking || ready.length === 0}
              onClick={() => void bookConfirmed()}
            >
              {booking ? "bucht …" : "Alle bestätigten buchen"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Ticket or customer for one suggestion, plus remembering it for the project. */
function TargetPicker(props: {
  draft: Draft;
  types: { id: number; name: string }[];
  onPatch: (change: Partial<Draft>) => void;
  onRemember: (target: Target) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Target2[]>([]);
  const { draft } = props;

  useEffect(() => {
    const text = query.trim();
    if (text.length < 2) return setHits([]);
    const handle = window.setTimeout(() => {
      void findTargets(text)
        .then((found) => setHits(found.slice(0, 10)))
        .catch(() => setHits([]));
    }, 250);
    return () => window.clearTimeout(handle);
  }, [query]);

  return (
    <>
      {draft.targetLabel ? (
        <span className="row tiny" style={{ gap: 4 }}>
          <span className="chip">{draft.targetLabel}</span>
          <button
            className="btn ghost small"
            onClick={() => props.onPatch({ ticketId: null, companyId: null, targetLabel: "" })}
            title="Zuordnung entfernen"
          >
            ×
          </button>
        </span>
      ) : (
        <span style={{ position: "relative" }}>
          <input
            className="input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Ticketnummer, Betreff oder Kunde"
            style={{ width: 200 }}
          />
          {hits.length ? (
            <div className="picker">
              {hits.map((hit) => (
                <button
                  key={`${hit.kind}${hit.id}`}
                  className="picker-row"
                  onClick={() => {
                    props.onPatch({
                      ticketId: hit.kind === "ticket" ? hit.id : null,
                      companyId: hit.kind === "company" ? hit.id : null,
                      targetLabel: hit.label,
                    });
                    setQuery("");
                    setHits([]);
                  }}
                >
                  <span className="badge" style={{ flex: "none" }}>{hit.kind === "ticket" ? "TICKET" : "KUNDE"}</span>
                  <span className="ellipsis">{hit.label}</span>
                </button>
              ))}
            </div>
          ) : null}
        </span>
      )}
      <select
        className="select"
        value={draft.typeId}
        onChange={(e) => props.onPatch({ typeId: Number(e.target.value) })}
        style={{ minWidth: 120 }}
      >
        {props.types.length === 0 ? <option value={0}>— keine Typen —</option> : null}
        {props.types.map((t) => (
          <option key={t.id} value={t.id}>{t.name}</option>
        ))}
      </select>
      {draft.ticketId || draft.companyId ? (
        <button
          className="btn ghost small"
          title="Diese Zuordnung für das Projekt merken"
          onClick={() =>
            void props.onRemember({
              ticketId: draft.ticketId,
              ticketLabel: draft.ticketId ? draft.targetLabel : "",
              companyId: draft.companyId,
              companyLabel: draft.companyId ? draft.targetLabel : "",
              typeId: draft.typeId || null,
            })
          }
        >
          merken
        </button>
      ) : null}
    </>
  );
}

/** The rules that decide a duration — visible next to what they produced. */
function RulesCard(props: { rules: ImportRules; states: WorkflowState[]; onChange: (rules: ImportRules) => void }) {
  const { rules } = props;
  return (
    <div className="card pad" style={{ marginBottom: 14, display: "flex", flexDirection: "column", gap: 8 }}>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <span className="viz-title">Regeln</span>
        <button
          className={rules.timeSource === "comment" ? "btn agent small" : "btn ghost small"}
          onClick={() => props.onChange({ ...rules, timeSource: "comment" })}
          title="Zeitangaben aus den eigenen Kommentaren, sonst der Statusverlauf"
        >
          Kommentar, sonst Statusverlauf
        </button>
        <button
          className={rules.timeSource === "history" ? "btn agent small" : "btn ghost small"}
          onClick={() => props.onChange({ ...rules, timeSource: "history" })}
        >
          nur Statusverlauf
        </button>
      </div>
      <div className="row" style={{ gap: 5, flexWrap: "wrap" }}>
        <span className="tiny muted">zählt als Arbeit:</span>
        {props.states.map((state) => {
          const on = rules.states.includes(state.name);
          return (
            <button
              key={state.name}
              className={on ? "btn agent small" : "btn ghost small"}
              onClick={() => {
                const next = on ? rules.states.filter((s) => s !== state.name) : [...rules.states, state.name];
                // At least one state has to count, or the day is always empty.
                if (next.length === 0) return;
                props.onChange({ ...rules, states: next });
              }}
            >
              {state.name}
            </button>
          );
        })}
      </div>
      <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
        <label className="row tiny muted" style={{ gap: 4 }}>
          max. Sitzung
          <input
            className="input mono"
            value={String(rules.sessionHours)}
            onChange={(e) => props.onChange({ ...rules, sessionHours: Number(e.target.value) || rules.sessionHours })}
            style={{ width: 54 }}
          />
          h
        </label>
        <label className="row tiny muted" style={{ gap: 4 }}>
          Arbeitsfenster
          <input
            className="input mono"
            value={rules.window}
            onChange={(e) => props.onChange({ ...rules, window: e.target.value })}
            style={{ width: 108 }}
          />
        </label>
        <label className="row tiny muted" style={{ gap: 4 }}>
          max. Tag
          <input
            className="input mono"
            value={String(rules.dayMaxHours)}
            onChange={(e) => props.onChange({ ...rules, dayMaxHours: Number(e.target.value) || rules.dayMaxHours })}
            style={{ width: 54 }}
          />
          h
        </label>
        <label className="row tiny muted" style={{ gap: 4 }}>
          Rundung
          <select
            className="select"
            value={rules.roundMinutes}
            onChange={(e) => props.onChange({ ...rules, roundMinutes: Number(e.target.value) })}
          >
            {ROUND_CHOICES.map((n) => (
              <option key={n} value={n}>{n} min</option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}
