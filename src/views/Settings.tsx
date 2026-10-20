import { useEffect, useState } from "react";
import { api, ApiError, type AgentSettings, type AuthConfig } from "../api.ts";
import { dayAndClock } from "../format.ts";
import { updateIndicator, type UpdateOverview } from "../../shared/update.ts";
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
import { confirmAndStartUpdate } from "../UpdateBanner.tsx";
import { Dot, Icon, PageHeader, SectionTitle, Segmented } from "../ui/kit.tsx";
import "../styles/settings.css";

type Theme = "light" | "dark";

type Props = {
  onSubtitle: (text: string) => void;
  onError: (error: unknown) => void;
  onToast: (text: string) => void;
  onSaved: (settings: AgentSettings) => void;
  /** A fresh check result, so the navigation shows it right away. */
  onUpdateOverview: (overview: UpdateOverview) => void;
  /** Current theme and its setter; without them the row points to the navigation toggle. */
  theme?: Theme;
  onTheme?: (theme: Theme) => void;
};

type Tab = "general" | "connections" | "ai" | "agent" | "texts";

const TABS: { id: Tab; label: string }[] = [
  { id: "general", label: "Allgemein" },
  { id: "connections", label: "Verbindungen" },
  { id: "ai", label: "Lokale KI" },
  { id: "agent", label: "Agent" },
  { id: "texts", label: "Texte & Bausteine" },
];

const TAB_KEY = "agent-portal:settings-tab";

function readTab(): Tab {
  try {
    const stored = localStorage.getItem(TAB_KEY);
    if (TABS.some((t) => t.id === stored)) return stored as Tab;
  } catch {
    /* private mode */
  }
  return "general";
}

const AGENT_DOES: { where: string; what: string }[] = [
  { where: "Tickets", what: "Briefing und Muster über die sichtbaren Zeilen." },
  { where: "Ticket", what: "Verlauf zusammenfassen, Kommentar entwerfen, nächsten Schritt vorschlagen." },
  { where: "Mehrfachauswahl", what: "Gemeinsamen Kommentar für alle gewählten Tickets entwerfen." },
  { where: "Zeiten", what: "Schlägt vor, was in die Lücken des Tages passt, und entwirft Leistungstexte." },
  { where: "Tagesimport", what: "Bringt die Notizen aus Linear in die Form eines Leistungstexts." },
  { where: "Chat", what: "Beantwortet Fragen zu Tickets und dem Tag; liest dafür selbst in TANSS nach." },
];

/**
 * Everything adjustable, sorted into five tabs. The local model's form lives
 * here at the top so its unsaved edits survive switching tabs; the key is
 * stored on the server only and sent just when the field was touched.
 */
export function SettingsView(props: Props) {
  const [tab, setTab] = useState<Tab>(readTab);
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

  const tabLabel = TABS.find((t) => t.id === tab)?.label ?? "";
  useEffect(() => {
    onSubtitle(tabLabel);
  }, [onSubtitle, tabLabel]);

  useEffect(() => {
    try {
      localStorage.setItem(TAB_KEY, tab);
    } catch {
      /* ignore */
    }
  }, [tab]);

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

  /** One short request to the model; shared by the KI tab and the connection card. */
  async function testModel(): Promise<{ ok: boolean; text: string }> {
    try {
      const result = await api.agent.test();
      const toolsNote = result.tools
        ? "Das Modell kann Werkzeuge — der Chat sieht selbst in TANSS nach."
        : "Das Modell kann keine Werkzeuge; der Chat nutzt den festen Kontext und Tickets mit # in der Frage.";
      return { ok: true, text: `Antwort in ${(result.durationMs / 1000).toFixed(1)} s: „${result.answer}" ${toolsNote}` };
    } catch (error) {
      return { ok: false, text: error instanceof Error ? error.message : "Test fehlgeschlagen" };
    }
  }

  async function test() {
    setTesting(true);
    setTestResult(null);
    setTestResult((await testModel()).text);
    setTesting(false);
  }

  return (
    <div className="view">
      <PageHeader title="Einstellungen" />
      <div className="settings-layout">
        <nav className="settings-tabs" aria-label="Bereiche">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`settings-tab${tab === t.id ? " active" : ""}`}
              aria-current={tab === t.id ? "page" : undefined}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className="settings-body">
          {tab === "general" ? (
            <>
              <div className="settings-rows">
                <div className="settings-row">
                  <span className="label">Erscheinungsbild</span>
                  {props.onTheme && props.theme ? (
                    <Segmented
                      label="Erscheinungsbild"
                      options={[
                        { id: "light", label: "Hell" },
                        { id: "dark", label: "Dunkel" },
                      ]}
                      value={props.theme}
                      onChange={(t) => props.onTheme?.(t)}
                    />
                  ) : (
                    <span className="muted">Umschalten unten in der Navigation</span>
                  )}
                </div>
                <div className="settings-row">
                  <span className="label">Sprache</span>
                  <span className="muted">Deutsch</span>
                </div>
              </div>
              <VersionSection onError={onError} onToast={props.onToast} onChecked={props.onUpdateOverview} />
            </>
          ) : null}

          {tab === "connections" ? (
            <>
              <ConnectionsSection
                agent={stored}
                onError={onError}
                onTestModel={testModel}
                onSetup={() => setTab("ai")}
              />
              <CollectorSection onError={onError} onToast={props.onToast} />
            </>
          ) : null}

          {tab === "ai" ? (
            <section className="section">
              <p className="lead">
                Ein OpenAI-kompatibler Endpoint auf dem eigenen Rechner oder im eigenen Netz — oMLX, Ollama, LM Studio
                oder vLLM. Ticket- und Kundendaten gehen nur dorthin. Aus dem Container heraus ist der Host als{" "}
                <span className="mono">host.docker.internal</span> erreichbar.
              </p>

              <div className="form-card">
                <label className="field">
                  <span>Basis-URL</span>
                  <input
                    className="input"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder="http://host.docker.internal:11434/v1"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <span className="form-help">„/v1" wird ergänzt, wenn es fehlt.</span>
                </label>

                <label className="field">
                  <span>API-Key (optional)</span>
                  <input
                    className="input"
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
                    <span className="form-help warn">Speichern löscht den gespeicherten Key.</span>
                  ) : (
                    <span className="form-help">Wird nur auf dem Server gespeichert und nie vollständig angezeigt.</span>
                  )}
                </label>

                <div className="field">
                  <span>Modell</span>
                  <div className="row wrap">
                    {models.length ? (
                      <Segmented
                        label="Modell"
                        small
                        onSoft
                        options={models.map((m) => ({ id: m, label: m }))}
                        value={model}
                        onChange={setModel}
                      />
                    ) : (
                      <input
                        className="input"
                        value={model}
                        onChange={(e) => setModel(e.target.value)}
                        placeholder="Modellname"
                        style={{ width: "auto", minWidth: 260 }}
                        spellCheck={false}
                      />
                    )}
                    <button className="btn" disabled={!baseUrl.trim() || loadingModels} onClick={() => void loadModels()}>
                      {loadingModels ? "lädt …" : models.length ? "Neu laden" : "Modelle laden"}
                    </button>
                  </div>
                  {modelsError ? <span className="form-help danger">{modelsError}</span> : null}
                </div>

                <label className="field">
                  <span>Kontextfenster des Modells (Tokens)</span>
                  <div className="row wrap" style={{ gap: 12 }}>
                    <input
                      className={`input mono${contextOk ? "" : " invalid"}`}
                      type="number"
                      min={2048}
                      step={1024}
                      value={contextText}
                      onChange={(e) => setContextText(e.target.value)}
                      style={{ width: 140 }}
                    />
                    <span className="small muted pretty" style={{ flex: "1 1 280px" }}>
                      Daraus folgt, wie viel Ticketverlauf ein Prompt bekommt: bei {contextTokens.toLocaleString("de-DE")} Tokens
                      etwa {threadBudget(contextTokens).toLocaleString("de-DE")} Zeichen je Ticket.
                    </span>
                  </div>
                  <span className="form-help">
                    Typisch: 32.768 (Qwen3, Mistral), 131.072 (Gemma 3 27B, Llama 3.x). Was oMLX tatsächlich lädt, steht in
                    dessen Konfiguration.
                  </span>
                </label>

                <div className="form-foot">
                  <button
                    className="btn primary"
                    disabled={saving || !dirty || !baseUrl.trim() || !model.trim() || !contextOk}
                    onClick={() => void save()}
                  >
                    {saving ? "Speichert …" : "Speichern"}
                  </button>
                  <button
                    className="btn"
                    disabled={testing || !stored?.ready || dirty}
                    onClick={() => void test()}
                    title={dirty ? "Erst speichern" : "Kurze Testanfrage an das Modell"}
                  >
                    {testing ? "Fragt …" : "Verbindung testen"}
                  </button>
                  {testResult ? <span className="result">{testResult}</span> : null}
                  {stored && !stored.ready && !dirty && !testResult ? (
                    <span className="result">Noch nicht eingerichtet — die Agent-Funktionen sind bis dahin inaktiv.</span>
                  ) : null}
                </div>
              </div>
            </section>
          ) : null}

          {tab === "agent" ? (
            <>
              <div className="status-card">
                <Dot tone={stored?.ready ? "ok" : "flat"} />
                <span className="pretty" style={{ flex: "1 1 280px" }}>
                  {stored?.ready ? (
                    <>
                      Modell <span style={{ fontWeight: 500 }}>{stored.model}</span> ist eingerichtet. Alle Funktionen unten
                      sind aktiv.
                    </>
                  ) : (
                    "Kein Modell eingerichtet — bis dahin sind die Agent-Funktionen aus."
                  )}
                </span>
                <button className="btn" onClick={() => setTab("ai")}>
                  {stored?.ready ? "Modell ändern" : "KI einrichten"}
                </button>
              </div>
              <section className="section">
                <SectionTitle title="Was der Agent tut" />
                <div className="table">
                  {AGENT_DOES.map((d) => (
                    <div key={d.where} className="does-row">
                      <span className="where">{d.where}</span>
                      <span className="what">{d.what}</span>
                    </div>
                  ))}
                </div>
                <p className="lead">
                  Der Agent schreibt nie selbst nach TANSS. Entwürfe landen im Textfeld, Buchungen machst du selbst.
                </p>
              </section>
            </>
          ) : null}

          {tab === "texts" ? (
            <>
              <StyleSection onError={onError} onToast={props.onToast} />
              <RoutinesSection onError={onError} onToast={props.onToast} />
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

type CardState = { tone: "ok" | "danger" | "flat" | "warn"; state: string; result: string; busy: boolean };

/**
 * One card per system the portal talks to. Each "testen" makes one real,
 * read-only call; nothing here changes a setting.
 */
function ConnectionsSection(props: {
  agent: AgentSettings | null;
  onError: (error: unknown) => void;
  onTestModel: () => Promise<{ ok: boolean; text: string }>;
  onSetup: () => void;
}) {
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [tanss, setTanss] = useState<CardState>({ tone: "flat", state: "nicht geprüft", result: "", busy: false });
  const [linear, setLinear] = useState<CardState>({ tone: "flat", state: "nicht geprüft", result: "", busy: false });
  const [model, setModel] = useState<CardState>({ tone: "flat", state: "nicht geprüft", result: "", busy: false });
  const { onError } = props;

  useEffect(() => {
    let cancelled = false;
    api
      .config()
      .then((c) => !cancelled && setConfig(c))
      .catch((error: unknown) => !cancelled && onError(error));
    return () => {
      cancelled = true;
    };
  }, [onError]);

  async function testTanss() {
    setTanss((s) => ({ ...s, busy: true }));
    try {
      const meta = await api.meta();
      setTanss({
        tone: "ok",
        state: "verbunden",
        result: `Antwort von TANSS: ${meta.states.length} Status, ${meta.technicians.length} Techniker, ${meta.supportTypes.length} Leistungsarten.`,
        busy: false,
      });
    } catch (error) {
      setTanss({ tone: "danger", state: "gestört", result: error instanceof Error ? error.message : "Keine Antwort", busy: false });
    }
  }

  async function testLinear() {
    setLinear((s) => ({ ...s, busy: true }));
    try {
      const result = await api.import.states();
      setLinear({
        tone: result.enabled ? "ok" : "warn",
        state: result.enabled ? "verbunden" : "nicht eingerichtet",
        result: result.enabled ? `${result.items.length} Workflow-Status gelesen.` : "Der Server hat keinen Linear-Key.",
        busy: false,
      });
    } catch (error) {
      setLinear({ tone: "danger", state: "gestört", result: error instanceof Error ? error.message : "Keine Antwort", busy: false });
    }
  }

  async function testModel() {
    setModel((s) => ({ ...s, busy: true }));
    const result = await props.onTestModel();
    setModel({ tone: result.ok ? "ok" : "danger", state: result.ok ? "antwortet" : "gestört", result: result.text, busy: false });
  }

  const linearOn = config?.linear ?? false;
  const agentReady = props.agent?.ready ?? false;
  const host = (url: string) => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  };

  return (
    <section className="section">
      <div className="status-card big">
        <div className="name">
          <strong>TANSS</strong>
          <span className="small muted">
            Tickets, Zeiten und Anmeldung ·{" "}
            {config ? (config.tokenRequired ? "2FA-Code bei der Anmeldung" : "2FA aus hinterlegtem Token-Schlüssel") : "…"}
          </span>
        </div>
        <span className="state">
          <Dot tone={tanss.tone} />
          {tanss.state}
        </span>
        <button className="btn" disabled={tanss.busy} onClick={() => void testTanss()}>
          {tanss.busy ? "Prüfe …" : "Verbindung testen"}
        </button>
        {tanss.result ? <span className="result">{tanss.result}</span> : null}
      </div>

      <div className="status-card big">
        <div className="name">
          <strong>Linear</strong>
          <span className="small muted">
            {linearOn ? "Quelle für den Tagesimport" : "Nicht eingerichtet — LINEAR_API_KEY in der .env setzen"}
          </span>
        </div>
        <span className="state">
          <Dot tone={linearOn ? linear.tone : "flat"} />
          {linearOn ? linear.state : "aus"}
        </span>
        {linearOn ? (
          <button className="btn" disabled={linear.busy} onClick={() => void testLinear()}>
            {linear.busy ? "Prüfe …" : "Verbindung testen"}
          </button>
        ) : null}
        {linear.result ? <span className="result">{linear.result}</span> : null}
      </div>

      <div className="status-card big">
        <div className="name">
          <strong>Lokale KI</strong>
          <span className="small muted">
            {agentReady && props.agent ? `${props.agent.model} · ${host(props.agent.baseUrl)}` : "Kein Modell eingerichtet"}
          </span>
        </div>
        <span className="state">
          <Dot tone={agentReady ? model.tone : "flat"} />
          {agentReady ? model.state : "aus"}
        </span>
        {agentReady ? (
          <button className="btn" disabled={model.busy} onClick={() => void testModel()}>
            {model.busy ? "Fragt …" : "Verbindung testen"}
          </button>
        ) : (
          <button className="btn primary" onClick={props.onSetup}>
            Einrichten
          </button>
        )}
        {model.result ? <span className="result">{model.result}</span> : null}
      </div>
    </section>
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

  const indicator = updateIndicator(overview, Date.now(), __APP_VERSION__);

  return (
    <section className="section" style={{ gap: 12 }}>
      <SectionTitle title="Version" />
      <p className="lead">
        Agent-Portal {__APP_VERSION__} ·{" "}
        <a href="https://github.com/0x5J/tanss-agent-portal/releases" target="_blank" rel="noreferrer">
          Versionshinweise
        </a>
      </p>
      {overview ? (
        <div className="status-card">
          {overview.enabled ? (
            <>
              <span>Kanal: {overview.channel === "staging" ? "Staging" : "stabil"}</span>
              {overview.checkError ? (
                <span className="small" style={{ color: "var(--danger)" }}>
                  Prüfung fehlgeschlagen: {overview.checkError}
                </span>
              ) : overview.checkedAt ? (
                <span className="small muted">zuletzt geprüft {dayAndClock(Math.floor(overview.checkedAt / 1000))}</span>
              ) : null}
              <span className="actions">
                {indicator.start ? (
                  <button
                    className="btn primary"
                    onClick={() =>
                      void confirmAndStartUpdate(indicator.start!, {
                        onOverview: (next) => {
                          setOverview(next);
                          onChecked(next);
                        },
                        onToast,
                        onError,
                      })
                    }
                  >
                    Auf {indicator.start} aktualisieren
                  </button>
                ) : null}
                <button className="btn" disabled={checking} onClick={() => void check()}>
                  {checking ? "Prüfe …" : "Jetzt prüfen"}
                </button>
              </span>
            </>
          ) : (
            <span className="small muted">Update-Prüfung abgeschaltet (UPDATE_CHECK=0)</span>
          )}
        </div>
      ) : null}
    </section>
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
    <section className="section" style={{ gap: 12 }}>
      <SectionTitle title="Dashboard-Sammler" />
      <p className="lead">
        Der Sammler zählt alle 5 Minuten die Ticketlisten und schreibt die Messpunkte für Verlauf, Eingangs-Historie und
        Übernahmen. Er nutzt dafür die Sitzung aus deiner Anmeldung — es liegt kein Passwort auf dem Server. Abmelden
        meldet alle Browser ab, nicht aber den Sammler.
      </p>
      {state?.present ? (
        <div className="status-card">
          <Dot tone="ok" />
          <span style={{ fontWeight: 500 }}>Sitzung aktiv</span>
          <span className="small muted">
            zuletzt erneuert {when(state.updatedAt)} · ohne Nutzung gültig bis {when(state.deadline)}
          </span>
          <span className="actions">
            <button className="btn danger-hover" disabled={busy} onClick={() => void stop()}>
              Sammler stoppen
            </button>
          </span>
        </div>
      ) : state ? (
        <div className="status-card">
          <Dot tone="flat" />
          <span className="pretty">Keine Sitzung hinterlegt — melde dich einmal neu an, dann läuft der Sammler wieder.</span>
        </div>
      ) : null}
    </section>
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
  const normalise = (id: string) =>
    void save(list.map((x) => (x.id === id ? { ...x, ...normaliseRange(x.minMinutes, x.maxMinutes) } : x)));
  return (
    <section className="section" style={{ gap: 12 }}>
      <SectionTitle title="Bausteine" />
      <p className="lead">
        Wiederkehrende Arbeit, die nirgends eine Spur hinterlässt — Mail, Monitoring, Triage. Unter jeder Lücke im Tag wird
        angeboten, was hineinpasst; die Dauer ist eine Spanne, aus der die Lücke das Passende nimmt. Höchstens{" "}
        {MAX_ROUTINES} Stück.
      </p>
      <div className="form-card" style={{ gap: 12 }}>
        {list.map((r) => (
          <div key={r.id} className="routine-row">
            <input
              className="input text"
              value={r.text}
              placeholder="Was wird getan?"
              onChange={(e) => patch(r.id, { text: e.target.value })}
              onBlur={() => (r.text.trim() ? void save(list) : undefined)}
            />
            <input
              className="input minutes"
              value={String(r.minMinutes)}
              onChange={(e) => patch(r.id, { minMinutes: Number(e.target.value) || 0 })}
              onBlur={() => normalise(r.id)}
              title="kürzeste Dauer"
              aria-label="kürzeste Dauer in Minuten"
            />
            <span className="unit">bis</span>
            <input
              className="input minutes"
              value={String(r.maxMinutes)}
              onChange={(e) => patch(r.id, { maxMinutes: Number(e.target.value) || 0 })}
              onBlur={() => normalise(r.id)}
              title="längste Dauer"
              aria-label="längste Dauer in Minuten"
            />
            <span className="unit">min</span>
            <button
              className="round-x"
              onClick={() => void save(list.filter((x) => x.id !== r.id))}
              title="Baustein löschen"
              aria-label="Baustein löschen"
            >
              <Icon d="M18 6 6 18M6 6l12 12" size={14} stroke={2} />
            </button>
          </div>
        ))}
        <div className={list.length ? "divider-row" : "row wrap"} style={list.length ? undefined : { gap: 12 }}>
          <button
            className="btn primary"
            disabled={saving || list.length >= MAX_ROUTINES}
            onClick={() =>
              // Added locally only: an empty routine has nothing to store yet.
              setRoutines([
                ...list,
                { id: newRoutineId(), text: "", minMinutes: 15, maxMinutes: 30, companyId: null, companyLabel: "", ticketId: null, ticketLabel: "", typeId: null },
              ])
            }
          >
            Baustein hinzufügen
          </button>
          <span className="small muted">
            {list.length === 0
              ? "Noch keiner angelegt — dann bleibt die Lückenzeile leer."
              : saving
                ? "speichert …"
                : list.some((r) => !r.text.trim())
                  ? "Ein Baustein ohne Text wird nicht gespeichert."
                  : `${list.length} von ${MAX_ROUTINES} · wird beim Verlassen des Feldes gespeichert`}
          </span>
        </div>
      </div>
    </section>
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
    <section className="section" style={{ gap: 12 }}>
      <SectionTitle title="Stil der Leistungstexte" />
      <p className="lead">
        Gilt für „Aus dem Verlauf entwerfen" und die Vorschläge des Tagesassistenten — nicht für Mail- und
        Kommentarentwürfe, das ist eine andere Textsorte. Höchstens {MAX_EXAMPLES} Beispiele: mehr verdrängen im Prompt das
        Material, um das es eigentlich geht.
      </p>
      <div className="form-card">
        <label className="field">
          <span>Regeln</span>
          <textarea
            className="textarea"
            rows={4}
            value={style.rules}
            onChange={(e) => setStyle({ ...style, rules: e.target.value })}
            onBlur={() => void save(style)}
            style={{ lineHeight: "22px" }}
          />
          {style.rules.trim() !== DEFAULT_STYLE_RULES ? (
            <button className="linkish" style={{ alignSelf: "flex-start", fontSize: 13 }} onClick={() => void save({ ...style, rules: DEFAULT_STYLE_RULES })}>
              Auf Standard zurücksetzen
            </button>
          ) : null}
        </label>
        <div className="field" style={{ gap: 8 }}>
          <span>Eigene Musterbeispiele</span>
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
            />
          ))}
          <span className="form-help">
            {saving ? "speichert …" : "In den Zeiten kannst du einen gebuchten Text mit „als Beispiel“ hierher übernehmen."}
          </span>
        </div>
      </div>
    </section>
  );
}
