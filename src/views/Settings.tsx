import { useEffect, useState } from "react";
import { api, ApiError, type AgentSettings } from "../api.ts";
import { dayAndClock } from "../format.ts";
import type { UpdateOverview } from "../../shared/update.ts";
import { threadBudget } from "../../shared/agent.ts";
import {
  MAX_ROUTINES,
  mergeSavedRoutines,
  newRoutineId,
  normaliseRange,
  splitRoutines,
  type Routine,
} from "../../shared/routines.ts";
import { DEFAULT_STYLE_RULES, MAX_EXAMPLES, type StyleSettings } from "../../shared/style.ts";

type Props = {
  onSubtitle: (text: string) => void;
  onError: (error: unknown) => void;
  onToast: (text: string) => void;
  onSaved: (settings: AgentSettings) => void;
  /** A fresh check result, so the navigation shows it right away. */
  onUpdateOverview: (overview: UpdateOverview) => void;
};

/**
 * Where the local model lives. The key is stored on the server only; the
 * form shows a hint and sends a new value just when the field was touched.
 */
export function SettingsView(props: Props) {
  const [stored, setStored] = useState<AgentSettings | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [keyTouched, setKeyTouched] = useState(false);
  const [model, setModel] = useState("");
  const [contextText, setContextText] = useState("32768");
  const contextTokens = Math.round(Number(contextText)) || 0;
  const contextOk = contextTokens >= 2048;
  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const { onSubtitle, onError } = props;

  useEffect(() => {
    onSubtitle("Lokales KI-Modell");
  }, [onSubtitle]);

  useEffect(() => {
    let cancelled = false;
    api.agent
      .settings()
      .then((s) => {
        if (cancelled) return;
        setStored(s);
        setBaseUrl(s.baseUrl);
        setModel(s.model);
        setContextText(String(s.contextTokens));
      })
      .catch((error: unknown) => {
        if (!cancelled) onError(error);
      });
    return () => {
      cancelled = true;
    };
  }, [onError]);

  const dirty =
    stored !== null && (baseUrl !== stored.baseUrl || model !== stored.model || contextTokens !== stored.contextTokens || keyTouched);

  async function loadModels() {
    setLoadingModels(true);
    setModelsError(null);
    try {
      const result = await api.agent.models({ baseUrl, ...(keyTouched ? { apiKey } : {}) });
      setModels(result.models);
      if (result.models.length === 0) setModelsError("Der Endpoint meldet keine Modelle.");
      else if (!result.models.includes(model)) setModel(result.models[0]);
    } catch (error) {
      setModels([]);
      setModelsError(error instanceof Error ? error.message : "Modelle nicht lesbar");
    } finally {
      setLoadingModels(false);
    }
  }

  async function save() {
    setSaving(true);
    try {
      const saved = await api.agent.saveSettings({ baseUrl, model, contextTokens, ...(keyTouched ? { apiKey } : {}) });
      setStored(saved);
      setBaseUrl(saved.baseUrl);
      setApiKey("");
      setKeyTouched(false);
      setTestResult(null);
      props.onSaved(saved);
      props.onToast("KI-Einstellungen gespeichert");
    } catch (error) {
      onError(error);
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api.agent.test();
      const toolsNote = result.tools
        ? "Das Modell kann Werkzeuge — der Chat sieht selbst in TANSS nach."
        : "Das Modell kann keine Werkzeuge; der Chat nutzt den festen Kontext und Tickets mit # in der Frage.";
      setTestResult(`Antwort in ${(result.durationMs / 1000).toFixed(1)} s: „${result.answer}" ${toolsNote}`);
    } catch (error) {
      setTestResult(error instanceof Error ? error.message : "Test fehlgeschlagen");
    } finally {
      setTesting(false);
    }
  }

  return (
    <div style={{ padding: 16, maxWidth: 720 }}>
      <h2 style={{ fontSize: 15, marginBottom: 4 }}>Lokale KI</h2>
      <p className="small muted pretty" style={{ marginBottom: 14, maxWidth: "68ch" }}>
        Ein OpenAI-kompatibler Endpoint auf dem eigenen Rechner oder im eigenen Netz — oMLX, Ollama,
        LM Studio oder vLLM. Ticket- und Kundendaten gehen nur dorthin. Aus dem Container heraus ist
        der Host als <span className="mono">host.docker.internal</span> erreichbar.
      </p>

      <div className="card pad" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <label className="field">
          <span className="small muted">Basis-URL</span>
          <input
            className="input mono"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="http://host.docker.internal:11434/v1"
            autoComplete="off"
            spellCheck={false}
          />
          <span className="tiny muted">„/v1" wird ergänzt, wenn es fehlt.</span>
        </label>

        <label className="field">
          <span className="small muted">API-Key (optional)</span>
          <input
            className="input mono"
            type="password"
            value={apiKey}
            onChange={(e) => {
              setApiKey(e.target.value);
              setKeyTouched(true);
            }}
            placeholder={stored?.hasKey ? `gespeichert (${stored.keyHint}) — leer lassen zum Behalten` : "kein Key"}
            autoComplete="new-password"
          />
          {stored?.hasKey && keyTouched && apiKey === "" ? (
            <span className="tiny" style={{ color: "var(--warn)" }}>Speichern löscht den gespeicherten Key.</span>
          ) : (
            <span className="tiny muted">Wird nur auf dem Server gespeichert und nie vollständig angezeigt.</span>
          )}
        </label>

        <div className="field">
          <span className="small muted">Modell</span>
          <div className="row">
            {models.length ? (
              <select className="select" value={model} onChange={(e) => setModel(e.target.value)} style={{ minWidth: 260 }}>
                {models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className="input mono"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="Modellname"
                style={{ minWidth: 260 }}
                spellCheck={false}
              />
            )}
            <button className="btn" disabled={!baseUrl.trim() || loadingModels} onClick={() => void loadModels()}>
              {loadingModels ? "lädt …" : "Modelle laden"}
            </button>
          </div>
          {modelsError ? <span className="tiny" style={{ color: "var(--danger)" }}>{modelsError}</span> : null}
        </div>

        <label className="field">
          <span className="small muted">Kontextfenster des Modells (Tokens)</span>
          <div className="row">
            <input
              className="input mono"
              type="number"
              min={2048}
              step={1024}
              value={contextText}
              onChange={(e) => setContextText(e.target.value)}
              style={{ width: 140, borderColor: contextOk ? undefined : "var(--danger)" }}
            />
            <span className="tiny muted">
              Daraus folgt, wie viel Ticketverlauf ein Prompt bekommt: bei {contextTokens.toLocaleString("de-DE")} Tokens etwa{" "}
              {threadBudget(contextTokens).toLocaleString("de-DE")} Zeichen je Ticket.
            </span>
          </div>
          <span className="tiny muted">Typisch: 32.768 (Qwen3, Mistral), 131.072 (Gemma 3 27B, Llama 3.x). Was oMLX tatsächlich lädt, steht in dessen Konfiguration.</span>
        </label>

        <div className="row" style={{ marginTop: 4 }}>
          <button className="btn primary" disabled={saving || !dirty || !baseUrl.trim() || !model.trim() || !contextOk} onClick={() => void save()}>
            {saving ? "Speichert …" : "Speichern"}
          </button>
          <button className="btn agent" disabled={testing || !stored?.ready || dirty} onClick={() => void test()} title={dirty ? "Erst speichern" : "Kurze Testanfrage an das Modell"}>
            {testing ? "Fragt …" : "Verbindung testen"}
          </button>
          {testResult ? <span className="small muted">{testResult}</span> : null}
          {stored && !stored.ready && !dirty ? (
            <span className="small muted">Noch nicht eingerichtet — die Agent-Funktionen sind bis dahin inaktiv.</span>
          ) : null}
        </div>
      </div>

      <CollectorSection onError={onError} onToast={props.onToast} />

      <StyleSection onError={onError} onToast={props.onToast} />

      <RoutinesSection onError={onError} onToast={props.onToast} />

      <h2 style={{ fontSize: 15, margin: "22px 0 4px" }}>Was der Agent tut</h2>
      <div className="small muted pretty" style={{ maxWidth: "68ch", display: "flex", flexDirection: "column", gap: 4 }}>
        <span>· Tickets: Briefing und Muster über die sichtbaren Zeilen.</span>
        <span>· Ticket-Drawer: Thread zusammenfassen, Kommentar entwerfen.</span>
        <span>· Mehrfachauswahl: gemeinsamen Kommentar entwerfen.</span>
        <span>· Zeiten: Assistent schlägt vor, was in die Lücken des Tages passt.</span>
        <span>Der Agent schreibt nie selbst nach TANSS. Entwürfe landen im Textfeld, Buchungen machst du selbst.</span>
      </div>

      <VersionSection onError={props.onError} onToast={props.onToast} onChecked={props.onUpdateOverview} />
    </div>
  );
}

/**
 * Installed version plus the update check. Without an update service (the
 * routes answer 404) it is just the version line.
 */
function VersionSection(props: {
  onError: (error: unknown) => void;
  onToast: (text: string) => void;
  onChecked: (overview: UpdateOverview) => void;
}) {
  const [overview, setOverview] = useState<UpdateOverview | null>(null);
  const [checking, setChecking] = useState(false);
  const { onError, onToast, onChecked } = props;

  useEffect(() => {
    let cancelled = false;
    api
      .update()
      .then((o) => !cancelled && setOverview(o))
      .catch((error: unknown) => {
        if (!cancelled && !(error instanceof ApiError && error.status === 404)) onError(error);
      });
    return () => {
      cancelled = true;
    };
  }, [onError]);

  async function check() {
    setChecking(true);
    try {
      const next = await api.checkUpdate();
      setOverview(next);
      onChecked(next);
      if (next.checkError) return;
      onToast(next.latest && next.latest.version !== next.current ? `Version ${next.latest.version} gefunden` : "Du bist auf dem neuesten Stand");
    } catch (error) {
      onError(error);
    } finally {
      setChecking(false);
    }
  }

  return (
    <>
      <h2 style={{ fontSize: 15, margin: "22px 0 4px" }}>Version</h2>
      <p className="small muted">
        Agent-Portal {__APP_VERSION__} ·{" "}
        <a href="https://github.com/0x5J/tanss-agent-portal/releases" target="_blank" rel="noreferrer">
          Versionshinweise
        </a>
      </p>
      {overview ? (
        <div className="row" style={{ gap: 10, flexWrap: "wrap", marginTop: 6 }}>
          {overview.enabled ? (
            <>
              <span className="small muted">Kanal: {overview.channel === "staging" ? "Staging" : "stabil"}</span>
              {overview.checkError ? (
                <span className="small" style={{ color: "var(--danger)" }}>
                  Prüfung fehlgeschlagen: {overview.checkError}
                </span>
              ) : overview.checkedAt ? (
                <span className="small muted">zuletzt geprüft {dayAndClock(Math.floor(overview.checkedAt / 1000))}</span>
              ) : null}
              <button className="btn" disabled={checking} onClick={() => void check()}>
                {checking ? "Prüfe …" : "Jetzt prüfen"}
              </button>
            </>
          ) : (
            <span className="small muted">Update-Prüfung abgeschaltet (UPDATE_CHECK=0)</span>
          )}
        </div>
      ) : null}
    </>
  );
}

/**
 * The session the dashboard collector runs on. It comes from the login mask,
 * so there is no password anywhere — but it also ends when nothing renews it
 * for five days, and then only a fresh login helps.
 */
function CollectorSection(props: { onError: (error: unknown) => void; onToast: (text: string) => void }) {
  const [state, setState] = useState<{ present: boolean; expire: number; updatedAt: number; deadline: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const { onError } = props;

  useEffect(() => {
    let cancelled = false;
    api
      .session()
      .then((s) => !cancelled && setState(s))
      .catch((error: unknown) => !cancelled && onError(error));
    return () => {
      cancelled = true;
    };
  }, [version, onError]);

  async function stop() {
    setBusy(true);
    try {
      await api.stopCollector();
      props.onToast("Sammler gestoppt — beim nächsten Anmelden läuft er wieder an");
      setVersion((v) => v + 1);
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  }

  const when = (unix: number) =>
    unix ? new Date(unix * 1000).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" }) : "—";

  return (
    <>
      <h2 style={{ fontSize: 15, margin: "22px 0 4px" }}>Dashboard-Sammler</h2>
      <p className="small muted pretty" style={{ marginBottom: 10, maxWidth: "68ch" }}>
        Der Sammler zählt alle 5 Minuten die Ticketlisten und schreibt die Messpunkte für Verlauf,
        Eingangs-Historie und Übernahmen. Er nutzt dafür die Sitzung aus deiner Anmeldung — es liegt
        kein Passwort auf dem Server. Abmelden meldet alle Browser ab, nicht aber den Sammler.
      </p>
      <div className="card pad">
        {state?.present ? (
          <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
            <span className="dot sm ok" />
            <span className="small">Sitzung aktiv</span>
            <span className="tiny muted">zuletzt erneuert {when(state.updatedAt)}</span>
            <span className="tiny muted">· ohne Nutzung gültig bis {when(state.deadline)}</span>
            <button className="btn ghost small danger-hover" style={{ marginLeft: "auto" }} disabled={busy} onClick={() => void stop()}>
              Sammler stoppen
            </button>
          </div>
        ) : (
          <div className="row" style={{ gap: 10 }}>
            <span className="dot sm flat" />
            <span className="small pretty">
              Keine Sitzung hinterlegt — melde dich einmal neu an, dann läuft der Sammler wieder.
            </span>
          </div>
        )}
      </div>
    </>
  );
}

/**
 * Recurring work that leaves no trace anywhere — mail, monitoring, triage.
 * The duration is a range, because such a task is twenty minutes on one day
 * and an hour on the next; the gap it lands in decides the rest.
 */
function RoutinesSection(props: { onError: (error: unknown) => void; onToast: (text: string) => void }) {
  const [routines, setRoutines] = useState<Routine[] | null>(null);
  const [saving, setSaving] = useState(false);
  const { onError } = props;

  useEffect(() => {
    let cancelled = false;
    api
      .routines()
      .then((r) => !cancelled && setRoutines(r.routines))
      .catch((error: unknown) => !cancelled && onError(error));
    return () => {
      cancelled = true;
    };
  }, [onError]);

  /**
   * Only finished entries go to the server — it drops anything without text,
   * and a row that vanishes while being filled in is worse than useless.
   * Rows still being typed stay here until they have a text.
   */
  async function save(next: Routine[]) {
    setRoutines(next);
    const { complete, pending } = splitRoutines(next);
    setSaving(true);
    try {
      const saved = await api.saveRoutines(complete);
      setRoutines(mergeSavedRoutines(saved.routines, pending));
    } catch (error) {
      onError(error);
    } finally {
      setSaving(false);
    }
  }

  function patch(id: string, change: Partial<Routine>) {
    setRoutines((current) => (current ?? []).map((r) => (r.id === id ? { ...r, ...change } : r)));
  }

  const list = routines ?? [];
  return (
    <>
      <h2 style={{ fontSize: 15, margin: "22px 0 4px" }}>Bausteine</h2>
      <p className="small muted pretty" style={{ marginBottom: 10, maxWidth: "68ch" }}>
        Wiederkehrende Arbeit, die nirgends eine Spur hinterlässt — Mail, Monitoring, Triage.
        Unter jeder Lücke im Tag wird angeboten, was hineinpasst; die Dauer ist eine Spanne, aus der
        die Lücke das Passende nimmt. Höchstens {MAX_ROUTINES} Stück.
      </p>
      <div className="card pad" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {list.map((r) => (
          <div key={r.id} className="row" style={{ gap: 8 }}>
            <input
              className="input"
              value={r.text}
              placeholder="Was wird getan?"
              onChange={(e) => patch(r.id, { text: e.target.value })}
              onBlur={() => (r.text.trim() ? void save(list) : undefined)}
              style={{ flex: 1, minWidth: 160 }}
            />
            <input
              className="input mono"
              value={String(r.minMinutes)}
              onChange={(e) => patch(r.id, { minMinutes: Number(e.target.value) || 0 })}
              onBlur={() => void save(list.map((x) => (x.id === r.id ? { ...x, ...normaliseRange(x.minMinutes, x.maxMinutes) } : x)))}
              style={{ width: 58 }}
              title="kürzeste Dauer"
            />
            <span className="tiny muted">bis</span>
            <input
              className="input mono"
              value={String(r.maxMinutes)}
              onChange={(e) => patch(r.id, { maxMinutes: Number(e.target.value) || 0 })}
              onBlur={() => void save(list.map((x) => (x.id === r.id ? { ...x, ...normaliseRange(x.minMinutes, x.maxMinutes) } : x)))}
              style={{ width: 58 }}
              title="längste Dauer"
            />
            <span className="tiny muted">min</span>
            <button
              className="btn ghost small danger-hover"
              onClick={() => void save(list.filter((x) => x.id !== r.id))}
              title="Baustein löschen"
            >
              ×
            </button>
          </div>
        ))}
        <div className="row">
          <button
            className="btn"
            disabled={saving || list.length >= MAX_ROUTINES}
            onClick={() =>
              // Added locally only: an empty routine has nothing to store yet.
              setRoutines([
                ...list,
                { id: newRoutineId(), text: "", minMinutes: 15, maxMinutes: 30, companyId: null, companyLabel: "", ticketId: null, ticketLabel: "", typeId: null },
              ])
            }
          >
            + Baustein
          </button>
          {list.length === 0 ? (
            <span className="tiny muted">Noch keiner angelegt — dann bleibt die Lückenzeile leer.</span>
          ) : (
            <span className="tiny muted">
              {saving
                ? "speichert …"
                : list.some((r) => !r.text.trim())
                  ? "Ein Baustein ohne Text wird nicht gespeichert."
                  : "wird beim Verlassen des Feldes gespeichert"}
            </span>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * How generated booking texts should read. A model imitates an example far
 * better than it follows a rule, so three of the user's own texts do more
 * than any amount of prose — and three is the cap, because every example
 * crowds out the material the text is actually about.
 */
function StyleSection(props: { onError: (error: unknown) => void; onToast: (text: string) => void }) {
  const [style, setStyle] = useState<StyleSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const { onError } = props;

  useEffect(() => {
    let cancelled = false;
    api
      .style()
      .then((r) => !cancelled && setStyle(r.style))
      .catch((error: unknown) => !cancelled && onError(error));
    return () => {
      cancelled = true;
    };
  }, [onError]);

  async function save(next: StyleSettings) {
    setStyle(next);
    setSaving(true);
    try {
      setStyle((await api.saveStyle(next)).style);
    } catch (error) {
      onError(error);
    } finally {
      setSaving(false);
    }
  }

  if (!style) return null;
  const examples = [...style.examples, "", "", ""].slice(0, MAX_EXAMPLES);
  return (
    <>
      <h2 style={{ fontSize: 15, margin: "22px 0 4px" }}>Stil der Leistungstexte</h2>
      <p className="small muted pretty" style={{ marginBottom: 10, maxWidth: "68ch" }}>
        Gilt für „Aus dem Verlauf entwerfen" und die Vorschläge des Tagesassistenten — nicht für
        Mail- und Kommentarentwürfe, das ist eine andere Textsorte. Höchstens {MAX_EXAMPLES}{" "}
        Beispiele: mehr verdrängen im Prompt das Material, um das es eigentlich geht.
      </p>
      <div className="card pad" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <label className="field">
          <span className="small muted">Regeln</span>
          <textarea
            className="textarea"
            rows={4}
            value={style.rules}
            onChange={(e) => setStyle({ ...style, rules: e.target.value })}
            onBlur={() => void save(style)}
          />
          {style.rules.trim() !== DEFAULT_STYLE_RULES ? (
            <button
              className="btn ghost small"
              style={{ alignSelf: "flex-start" }}
              onClick={() => void save({ ...style, rules: DEFAULT_STYLE_RULES })}
            >
              auf Standard zurücksetzen
            </button>
          ) : null}
        </label>
        <div className="field">
          <span className="small muted">Eigene Musterbeispiele</span>
          {examples.map((example, i) => (
            <input
              key={i}
              className="input"
              value={example}
              placeholder={i === 0 ? "Ein eigener Leistungstext, der genau richtig klingt" : "optional"}
              onChange={(e) => {
                const next = [...examples];
                next[i] = e.target.value;
                setStyle({ ...style, examples: next });
              }}
              onBlur={() => void save({ ...style, examples: style.examples.filter((x) => x.trim()) })}
              style={{ marginBottom: 5 }}
            />
          ))}
          <span className="tiny muted">
            {saving ? "speichert …" : "In den Zeiten kannst du einen gebuchten Text mit „als Beispiel“ hierher übernehmen."}
          </span>
        </div>
      </div>
    </>
  );
}
