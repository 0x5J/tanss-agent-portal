import { useCallback, useEffect, useState } from "react";
import { api, type ImportBookItem, type Meta } from "../api.ts";
import { formatLongDate, shiftYmd } from "../../shared/days.ts";
import { formatHm, parseDuration } from "../../shared/duration.ts";
import { ROUND_CHOICES, type ImportRules, type Suggestion, type WorkflowState } from "../../shared/import.ts";
import type { Target } from "../../shared/mapping.ts";
import { formatClock, formatHours, sumMinutes, supportsOfDay } from "../../shared/timeline.ts";
import { todayYmd } from "../format.ts";
import { findTargets, type Target as Target2 } from "../targets.ts";
import { AgentHint, CheckBox, Dot, Icon, PageHeader, SectionTitle, Segmented, SPARK_SMALL, Switch, Tile } from "../ui/kit.tsx";
import "../styles/import.css";

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

type Step = 1 | 2 | 3;

const STEPS: { n: Step; label: string }[] = [
  { n: 1, label: "Tag und Regeln" },
  { n: 2, label: "Prüfen und zuordnen" },
  { n: 3, label: "Buchen" },
];

/** How sure a suggestion is, from what the data says — not a model's guess. */
type Certainty = { tone: "ok" | "warn" | "danger" | "flat"; label: string };

function certaintyOf(row: Row, draft: Draft): Certainty {
  if (row.bookedSupportId) return { tone: "ok", label: "gebucht" };
  if (draft.dropped) return { tone: "flat", label: "verworfen" };
  if (draft.error) return { tone: "danger", label: "Fehler" };
  if (!draft.ticketId && !draft.companyId) return { tone: "warn", label: "ohne Ziel" };
  if (!parseDuration(draft.duration)) return { tone: "danger", label: "Dauer?" };
  if (row.flags.length) return { tone: "warn", label: "prüfen" };
  return { tone: "ok", label: row.mapping ? "sicher" : "zugeordnet" };
}

/**
 * The day read out of Linear, turned into booking suggestions, in three
 * steps: what counts, what it produced, what gets booked. Nothing is booked
 * without confirmation, and every rule that changed a duration stays visible
 * on the suggestion instead of quietly shrinking a number.
 */
export function ImportView(props: Props) {
  const [step, setStep] = useState<Step>(1);
  const [day, setDay] = useState(todayYmd());
  const [rows, setRows] = useState<Row[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [rules, setRules] = useState<ImportRules | null>(null);
  const [states, setStates] = useState<WorkflowState[]>([]);
  const [issuesChecked, setIssuesChecked] = useState(0);
  const [loading, setLoading] = useState(false);
  const [booking, setBooking] = useState(false);
  const [phrasing, setPhrasing] = useState<string | null>(null);
  const [capped, setCapped] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [bookedToday, setBookedToday] = useState<number | null>(null);
  const { onSubtitle, onError } = props;
  const types = props.meta?.supportTypes ?? [];

  const subtitle = props.configured
    ? `Aktivitäten vom ${formatLongDate(day)} aus Linear als Buchungen übernehmen.`
    : "Keine Linear-Verbindung eingerichtet.";
  useEffect(() => {
    onSubtitle(subtitle);
  }, [onSubtitle, subtitle]);

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

  // Another day is another set of suggestions; the old ones would be booked onto the wrong date.
  useEffect(() => {
    setRows(null);
    setDrafts({});
    setOpen(null);
    setStep(1);
  }, [day]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.import.day(day);
      setRows(result.suggestions);
      setRules(result.rules);
      setCapped(result.capped);
      setIssuesChecked(result.issuesChecked);
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
      return true;
    } catch (error) {
      onError(error);
      return false;
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

  const all = rows ?? [];
  const pending = all.filter((r) => !r.bookedSupportId && !drafts[r.issue]?.dropped);
  const bookable = (r: Row) => {
    const draft = drafts[r.issue];
    return Boolean(draft && (draft.ticketId || draft.companyId) && draft.typeId && parseDuration(draft.duration));
  };
  const ready = pending.filter((r) => drafts[r.issue]?.confirmed && bookable(r));
  const readyMinutes = ready.reduce((sum, r) => sum + (parseDuration(drafts[r.issue]!.duration) ?? 0), 0);
  const safe = pending.filter((r) => drafts[r.issue] && certaintyOf(r, drafts[r.issue]!).tone === "ok");
  const withoutTarget = pending.filter((r) => {
    const draft = drafts[r.issue];
    return draft && !draft.ticketId && !draft.companyId;
  });
  const flagged = pending.filter((r) => r.flags.length);

  // What the day already holds, so step 3 can say where it ends up.
  useEffect(() => {
    if (step !== 3) return;
    let cancelled = false;
    setBookedToday(null);
    api
      .supports(day)
      .then((r) => !cancelled && setBookedToday(sumMinutes(supportsOfDay(r.supports, day))))
      .catch(() => !cancelled && setBookedToday(null));
    return () => {
      cancelled = true;
    };
  }, [step, day]);

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
      const failed = result.results.filter((line) => line.error);
      props.onToast(
        result.booked === items.length
          ? `${result.booked} Leistungen gebucht`
          : `${result.booked} von ${items.length} gebucht — der Rest steht mit Grund in der Zeile`,
      );
      props.onChanged();
      await load();
      // load() resets the drafts; the reasons for what failed go back onto their rows.
      for (const line of failed) patch(line.issue, { error: line.error, confirmed: false });
      setStep(2);
    } catch (error) {
      onError(error);
    } finally {
      setBooking(false);
    }
  }

  if (!props.configured) {
    return (
      <div className="view tight">
        <PageHeader title="Tagesimport" subtitle={subtitle} />
        <div className="soft-card">
          <span style={{ fontSize: 18, lineHeight: "24px", fontWeight: 500 }}>Keine Linear-Verbindung eingerichtet.</span>
          <p className="lead">
            Für den Tagesimport braucht der Server einen persönlichen Linear-API-Key: <span className="mono">LINEAR_API_KEY</span>{" "}
            in die <span className="mono">.env</span>, dann <span className="mono">docker compose up -d</span>. Den Key gibt es in
            Linear unter Settings → API → Personal API keys. Alles andere im Portal funktioniert unabhängig davon.
          </p>
        </div>
      </div>
    );
  }

  const canReach = (n: Step) => n === 1 || (n === 2 && rows !== null) || (n === 3 && ready.length > 0);

  return (
    <div className="view tight">
      <PageHeader title="Tagesimport" subtitle={subtitle} />

      <div className="stepper" role="tablist" aria-label="Schritte">
        {STEPS.map((s) => (
          <button
            key={s.n}
            role="tab"
            aria-selected={step === s.n}
            className={`step${step === s.n ? " active" : ""}${step >= s.n ? " reached" : ""}`}
            disabled={!canReach(s.n)}
            onClick={() => setStep(s.n)}
          >
            <span className="n">Schritt {s.n}</span>
            <span className="label">{s.label}</span>
          </button>
        ))}
      </div>

      {step === 1 ? (
        <>
          <section className="section">
            <SectionTitle title="Tag" />
            <div className="day-pick">
              <input className="input mono" type="date" value={day} max={todayYmd()} onChange={(e) => e.target.value && setDay(e.target.value)} />
              <Segmented
                label="Schnellwahl"
                small
                options={[
                  { id: todayYmd(), label: "Heute" },
                  { id: shiftYmd(todayYmd(), -1), label: "Gestern" },
                ]}
                value={day}
                onChange={setDay}
              />
              <span className="muted">{formatLongDate(day)} · Zeiten in Europe/Berlin</span>
            </div>
          </section>

          {rules ? (
            <>
              <section className="section">
                <SectionTitle title="Zeit lesen aus" />
                <div>
                  <Segmented
                    label="Zeitquelle"
                    options={[
                      { id: "comment", label: "Kommentare, sonst Statusverlauf", title: "Zeitangaben aus den eigenen Kommentaren, sonst der Statusverlauf" },
                      { id: "history", label: "Nur Statusverlauf" },
                    ]}
                    value={rules.timeSource}
                    onChange={(timeSource) => void saveRules({ ...rules, timeSource })}
                  />
                </div>
              </section>

              <section className="section">
                <SectionTitle title="Zählt als Arbeit" note="Zeit in diesen Linear-Status wird zur Buchung. Mindestens einer bleibt an." />
                {states.length ? (
                  <div className="source-grid">
                    {states.map((state) => {
                      const on = rules.states.includes(state.name);
                      const toggle = () => {
                        const next = on ? rules.states.filter((s) => s !== state.name) : [...rules.states, state.name];
                        // At least one state has to count, or the day is always empty.
                        if (next.length === 0) return;
                        void saveRules({ ...rules, states: next });
                      };
                      return (
                        <div key={state.name} className="source-card" onClick={toggle}>
                          <span className="top">
                            <span className="label">{state.name}</span>
                            <Switch on={on} onChange={toggle} label={state.name} />
                          </span>
                          <span className="meta">{on ? "zählt als Arbeitszeit" : "zählt nicht"} · Linear-Typ {state.type}</span>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="empty-note">Workflow-Status werden geladen …</div>
                )}
              </section>

              <section className="section">
                <SectionTitle title="Grenzen" note="Was länger, später oder mehr ist, wird gekappt — und an der Zeile vermerkt." />
                <div className="soft-card">
                  <div className="limits">
                    <label className="field">
                      <span>Längste Sitzung (h)</span>
                      <input
                        className="input mono"
                        value={String(rules.sessionHours)}
                        onChange={(e) => void saveRules({ ...rules, sessionHours: Number(e.target.value) || rules.sessionHours })}
                      />
                    </label>
                    <label className="field">
                      <span>Arbeitsfenster</span>
                      <input className="input mono" value={rules.window} onChange={(e) => void saveRules({ ...rules, window: e.target.value })} />
                    </label>
                    <label className="field">
                      <span>Höchstens am Tag (h)</span>
                      <input
                        className="input mono"
                        value={String(rules.dayMaxHours)}
                        onChange={(e) => void saveRules({ ...rules, dayMaxHours: Number(e.target.value) || rules.dayMaxHours })}
                      />
                    </label>
                    <label className="field">
                      <span>Rundung</span>
                      <select
                        className="select"
                        value={rules.roundMinutes}
                        onChange={(e) => void saveRules({ ...rules, roundMinutes: Number(e.target.value) })}
                      >
                        {ROUND_CHOICES.map((n) => (
                          <option key={n} value={n}>
                            {n} min
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                </div>
              </section>
            </>
          ) : null}
        </>
      ) : null}

      {step === 2 && rows ? (
        <section className="section">
          {capped ? (
            <div className="notice">
              <Dot tone="warn" />
              <span className="pretty">
                Es wurden {issuesChecked || 50} zuletzt berührte Issues gelesen — die Grenze war erreicht, der Tag kann
                unvollständig sein.
              </span>
            </div>
          ) : null}

          {rows.length === 0 ? (
            <div className="soft-card">
              <span style={{ fontWeight: 500 }}>Keine buchbare Zeit an diesem Tag.</span>
              <span className="muted pretty">
                Entweder gab es keine Aktivität, oder die Regeln in Schritt 1 zählen die betroffenen Status nicht.
              </span>
            </div>
          ) : (
            <>
              {pending.length ? (
                <AgentHint
                  actions={
                    safe.length ? (
                      <button
                        className="btn"
                        onClick={() =>
                          setDrafts((d) => {
                            const next = { ...d };
                            for (const r of pending) {
                              next[r.issue] = { ...next[r.issue]!, confirmed: certaintyOf(r, next[r.issue]!).tone === "ok" };
                            }
                            return next;
                          })
                        }
                      >
                        Nur sichere auswählen
                      </button>
                    ) : null
                  }
                >
                  {safe.length} von {pending.length} Einträgen eindeutig zugeordnet.
                  {withoutTarget.length
                    ? ` ${withoutTarget.length} ${withoutTarget.length === 1 ? "hat" : "haben"} kein Ticket und keinen Kunden – zuordnen oder verwerfen.`
                    : ""}
                  {flagged.length ? ` ${flagged.length} mit Hinweis der Regeln – bitte ansehen.` : ""}
                </AgentHint>
              ) : null}

              <div className="table-scroll">
                <div className="table">
                  <div className="thead import-grid">
                    <span />
                    <span>Zeit</span>
                    <span>Issue</span>
                    <span>Aktivität</span>
                    <span>Ticket / Kunde</span>
                    <span>Sicherheit</span>
                    <span style={{ textAlign: "right" }}>Dauer</span>
                  </div>
                  {rows.map((row) => {
                    const draft = drafts[row.issue];
                    if (!draft) return null;
                    const c = certaintyOf(row, draft);
                    const locked = Boolean(row.bookedSupportId) || draft.dropped;
                    const expanded = open === row.issue;
                    const minutes = parseDuration(draft.duration);
                    return (
                      <div key={row.issue}>
                        <div
                          className={`trow tall clickable import-grid${expanded || draft.confirmed ? " selected" : ""}${draft.dropped ? " dropped" : ""}`}
                          onClick={() => setOpen(expanded ? null : row.issue)}
                          aria-expanded={expanded}
                        >
                          <span className="box">
                            <button
                              aria-label={draft.confirmed ? "Auswahl aufheben" : "zum Buchen auswählen"}
                              disabled={locked || !bookable(row)}
                              title={locked ? "" : bookable(row) ? "" : "Ohne Ticket oder Kunde und gültige Dauer kann nicht gebucht werden"}
                              onClick={(e) => {
                                e.stopPropagation();
                                patch(row.issue, { confirmed: !draft.confirmed });
                              }}
                            >
                              <CheckBox on={Boolean(row.bookedSupportId) || draft.confirmed} />
                            </button>
                          </span>
                          <span className="num-cell">{draft.start}</span>
                          <span className="muted">{row.issue}</span>
                          <span className="import-row-title">
                            <span className="t">{row.title}</span>
                            <span className="p">{row.project}</span>
                          </span>
                          <span className={`target-cell${draft.targetLabel ? "" : " missing"}`}>
                            {row.bookedSupportId ? `TANSS #${row.bookedSupportId}` : draft.targetLabel || "zuordnen"}
                          </span>
                          <span className="row" style={{ gap: 8 }}>
                            <Dot tone={c.tone} />
                            {c.label}
                          </span>
                          <span className="num-cell" style={{ textAlign: "right", fontWeight: 500 }}>
                            {minutes ? formatHm(minutes) : "—"}
                          </span>
                        </div>
                        {expanded ? (
                          <Editor
                            row={row}
                            draft={draft}
                            types={types}
                            agentReady={props.agentReady}
                            phrasing={phrasing}
                            onPatch={(change) => patch(row.issue, change)}
                            onPhrase={() => void phrase(row)}
                            onRemember={async (target) => {
                              try {
                                await api.import.remember(row.project, target);
                                props.onToast(`Zuordnung für „${row.project}" gemerkt`);
                              } catch (error) {
                                onError(error);
                              }
                            }}
                          />
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          )}
        </section>
      ) : null}

      {step === 3 ? (
        <>
          <div className="tiles">
            <Tile label="Buchungen" value={ready.length} />
            <Tile label="Summe" value={formatHours(readyMinutes)} />
            <Tile
              label="Tagessumme danach"
              value={bookedToday === null ? "…" : formatHours(bookedToday + readyMinutes)}
              hint={bookedToday === null ? undefined : `bisher ${formatHours(bookedToday)} gebucht`}
            />
          </div>
          <section className="section">
            <SectionTitle title="Wird gebucht" note={formatLongDate(day)} />
            <div className="table-scroll">
              <div className="table">
                <div className="thead book-grid">
                  <span>Zeit</span>
                  <span>Issue</span>
                  <span>Text</span>
                  <span>Ticket / Kunde</span>
                  <span style={{ textAlign: "right" }}>Dauer</span>
                </div>
                {ready.map((row) => {
                  const draft = drafts[row.issue]!;
                  return (
                    <div key={row.issue} className="trow book-grid">
                      <span className="num-cell">{draft.start}</span>
                      <span className="muted">{row.issue}</span>
                      <span className="ellipsis" style={{ paddingRight: 16 }} title={draft.text}>
                        {draft.text.trim() || <span className="muted">(ohne Text)</span>}
                      </span>
                      <span className="ellipsis" style={{ paddingRight: 12 }}>
                        {draft.targetLabel}
                      </span>
                      <span className="num-cell" style={{ textAlign: "right", fontWeight: 500 }}>
                        {formatHm(parseDuration(draft.duration) ?? 0)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>
        </>
      ) : null}

      <div className="wizard-foot">
        {step > 1 ? (
          <button className="btn lg" disabled={booking} onClick={() => setStep((step - 1) as Step)}>
            Zurück
          </button>
        ) : null}
        {step === 1 ? (
          <button
            className="btn primary lg"
            disabled={loading || !rules}
            onClick={async () => {
              if (await load()) setStep(2);
            }}
          >
            {loading ? "lädt aus Linear …" : rows ? "Neu aus Linear laden" : "Aus Linear laden"}
          </button>
        ) : null}
        {step === 1 && rows ? (
          <button className="btn lg" onClick={() => setStep(2)}>
            Weiter mit geladenem Stand
          </button>
        ) : null}
        {step === 2 ? (
          <button className="btn primary lg" disabled={ready.length === 0} onClick={() => setStep(3)}>
            Weiter{ready.length ? ` mit ${ready.length} ausgewählten` : ""}
          </button>
        ) : null}
        {step === 3 ? (
          <button className="btn primary lg" disabled={booking || ready.length === 0} onClick={() => void bookConfirmed()}>
            {booking ? "bucht …" : `${ready.length} ${ready.length === 1 ? "Leistung" : "Leistungen"} buchen`}
          </button>
        ) : null}
        <span className="note">
          {step === 1
            ? "Liest die eigenen Kommentare und Statuswechsel des Tages aus Linear."
            : step === 2
              ? `${ready.length} von ${pending.length} ausgewählt · ${formatHours(readyMinutes)} · Zeile anklicken zum Bearbeiten`
              : "Jede Leistung wird einzeln in TANSS angelegt; was scheitert, steht danach mit Grund in der Zeile."}
        </span>
      </div>
    </div>
  );
}

/** Everything about one suggestion that can be changed before booking. */
function Editor(props: {
  row: Row;
  draft: Draft;
  types: { id: number; name: string }[];
  agentReady: boolean;
  phrasing: string | null;
  onPatch: (change: Partial<Draft>) => void;
  onPhrase: () => void;
  onRemember: (target: Target) => Promise<void>;
}) {
  const { row, draft } = props;
  const minutes = parseDuration(draft.duration);

  if (row.bookedSupportId) {
    return (
      <div className="import-editor">
        <span className="pretty">
          Schon gebucht als Leistung <span className="mono">#{row.bookedSupportId}</span> in TANSS. Änderungen daran gehen über
          die Zeiten.
        </span>
      </div>
    );
  }

  if (draft.dropped) {
    return (
      <div className="import-editor">
        <div className="row wrap">
          <span className="muted">Verworfen — wird nicht gebucht.</span>
          <button className="btn" style={{ marginLeft: "auto" }} onClick={() => props.onPatch({ dropped: false })}>
            Zurückholen
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="import-editor">
      <div className="fields">
        <label className="field" style={{ width: 90 }}>
          <span>Beginn</span>
          <input className="input mono" value={draft.start} onChange={(e) => props.onPatch({ start: e.target.value })} />
        </label>
        <label className="field" style={{ width: 90 }}>
          <span>Dauer</span>
          <input
            className={`input mono${minutes ? "" : " invalid"}`}
            value={draft.duration}
            onChange={(e) => props.onPatch({ duration: e.target.value })}
          />
        </label>
        <span className="small muted" style={{ paddingBottom: 10 }}>
          {row.raw === row.minutes ? "exakt" : `${row.raw} min roh`} · Vorschlag {formatHm(row.minutes)}
        </span>
        <TargetPicker draft={draft} onPatch={props.onPatch} />
        <label className="field" style={{ minWidth: 160 }}>
          <span>Typ</span>
          <select className="select" value={draft.typeId} onChange={(e) => props.onPatch({ typeId: Number(e.target.value) })}>
            {props.types.length === 0 ? <option value={0}>— keine Typen —</option> : null}
            {props.types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="field">
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          Tätigkeitstext
          <button
            className="btn small"
            style={{ marginLeft: "auto" }}
            disabled={!props.agentReady || props.phrasing !== null}
            title={
              props.agentReady
                ? "Die Notizen aus Linear in einen Leistungstext in deinem Stil bringen"
                : "KI nicht eingerichtet (Einstellungen)"
            }
            onClick={props.onPhrase}
          >
            <Icon d={SPARK_SMALL} size={12} />
            {props.phrasing === row.issue ? "formuliert …" : "Aus Issue formulieren"}
          </button>
        </span>
        <textarea className="textarea" rows={3} value={draft.text} onChange={(e) => props.onPatch({ text: e.target.value })} />
        <span className="form-help">Formulieren nutzt deine Stilregeln und Musterbeispiele aus den Einstellungen.</span>
      </div>

      {row.flags.length ? (
        <div className="flags">
          {row.flags.map((flag, i) => (
            <span key={i} className="flag">
              <Dot tone="warn" />
              <span className="pretty">
                <span style={{ fontWeight: 500, color: "var(--ink)" }}>{flag.label}.</span> {flag.reason}
              </span>
            </span>
          ))}
        </div>
      ) : null}
      {draft.error ? (
        <span className="small" style={{ color: "var(--red)", fontWeight: 500 }}>
          {draft.error}
        </span>
      ) : null}

      <div className="foot">
        <button className="btn danger-hover" onClick={() => props.onPatch({ dropped: true, confirmed: false })}>
          Verwerfen
        </button>
        {draft.ticketId || draft.companyId ? (
          <button
            className="btn"
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
            Für „{row.project}" merken
          </button>
        ) : null}
        <button
          className={`btn${draft.confirmed ? "" : " primary"}`}
          style={{ marginLeft: "auto" }}
          disabled={!(draft.ticketId || draft.companyId) || !minutes}
          title={draft.ticketId || draft.companyId ? "" : "Ohne Ticket oder Kunde kann nicht gebucht werden"}
          onClick={() => props.onPatch({ confirmed: !draft.confirmed })}
        >
          {draft.confirmed ? "Ausgewählt ✓" : "Zum Buchen auswählen"}
        </button>
      </div>
    </div>
  );
}

/** Ticket or customer for one suggestion. */
function TargetPicker(props: { draft: Draft; onPatch: (change: Partial<Draft>) => void }) {
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
    <div className="field target" style={{ flex: "1 1 260px", minWidth: 220 }}>
      <span>Zuweisung</span>
      {draft.targetLabel ? (
        <span className="row" style={{ gap: 8, minHeight: 42 }}>
          <span className="target-pill">
            <span>{draft.targetLabel}</span>
          </span>
          <button className="linkish" style={{ fontSize: 13 }} onClick={() => props.onPatch({ ticketId: null, companyId: null, targetLabel: "", confirmed: false })}>
            ändern
          </button>
        </span>
      ) : (
        <>
          <input
            className="input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Ticketnummer, Betreff oder Kunde suchen …"
          />
          {hits.length ? (
            <div className="popover" style={{ top: "100%", left: 0, right: 0, marginTop: 4, maxHeight: 220, overflow: "auto" }}>
              {hits.map((hit) => (
                <button
                  key={`${hit.kind}${hit.id}`}
                  className="popover-item"
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
                  <span className="badge" style={{ flex: "none" }}>
                    {hit.kind === "ticket" ? "Ticket" : "Kunde"}
                  </span>
                  <span className="ellipsis">{hit.label}</span>
                </button>
              ))}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
