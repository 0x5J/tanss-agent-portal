import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type AgentSettings, type AuthConfig, type Meta } from "./api.ts";
import { Login } from "./Login.tsx";
import { Shell, type View } from "./Shell.tsx";
import { DashboardView } from "./views/Dashboard.tsx";
import { TicketsView } from "./views/Tickets.tsx";
import { TicketDrawer } from "./views/TicketDrawer.tsx";
import { TimesView } from "./views/Times.tsx";
import { AnalysisView } from "./views/Analysis.tsx";
import { LogView } from "./views/Log.tsx";
import { ImportView } from "./views/Import.tsx";
import { SettingsView } from "./views/Settings.tsx";
import { confirmAndStartUpdate, UpdateBanner } from "./UpdateBanner.tsx";
import { useUpdateOverview } from "./useUpdateOverview.ts";
import { updateIndicator } from "../shared/update.ts";
import { Palette } from "./Palette.tsx";
import { AgentSidebar } from "./AgentSidebar.tsx";
import type { TicketRow } from "../shared/tickets.ts";
import type { Activity } from "../shared/activity.ts";

type Theme = "dark" | "light";

function readSidebar(): boolean {
  try {
    return localStorage.getItem("agent-portal:sidebar") !== "closed";
  } catch {
    return true;
  }
}

function readTheme(): Theme {
  try {
    const stored = localStorage.getItem("theme");
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    /* private mode */
  }
  return "dark";
}

export function App() {
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [employeeId, setEmployeeId] = useState<number | null>(null);
  const [checking, setChecking] = useState(true);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [view, setView] = useState<View>("tickets");
  const [openTicket, setOpenTicket] = useState<number | null>(null);
  const [timesDay, setTimesDay] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [toast, setToastText] = useState<string | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [tanssDown, setTanssDown] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [subtitle, setSubtitle] = useState("");
  const [agent, setAgent] = useState<AgentSettings | null>(null);
  const [sidebar, setSidebar] = useState(readSidebar);
  const [board, setBoard] = useState<{ rows: TicketRow[]; activity: Record<number, Activity> }>({ rows: [], activity: {} });
  const onBoardData = useCallback((rows: TicketRow[], activity: Record<number, Activity>) => setBoard({ rows, activity }), []);

  useEffect(() => {
    try {
      localStorage.setItem("agent-portal:sidebar", sidebar ? "open" : "closed");
    } catch {
      /* ignore */
    }
  }, [sidebar]);
  const toastTimer = useRef<number | null>(null);
  /** Bumped after a write so the open view reloads. */
  const [reload, setReload] = useState(0);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("theme", theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [cfg, me] = await Promise.all([api.config(), api.me().catch(() => null)]);
        if (cancelled) return;
        setConfig(cfg);
        if (me) setEmployeeId(me.employeeId);
      } catch (error) {
        if (!cancelled) setLoginError(error instanceof Error ? error.message : "Fehler");
      } finally {
        if (!cancelled) setChecking(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Agent state: is a model set up.
  useEffect(() => {
    if (!employeeId) return;
    let cancelled = false;
    api.agent.settings().then((s) => !cancelled && setAgent(s)).catch(() => null);
    return () => {
      cancelled = true;
    };
  }, [employeeId, reload]);

  useEffect(() => {
    if (!employeeId) return;
    let cancelled = false;
    api
      .meta()
      .then((m) => {
        if (!cancelled) {
          setMeta(m);
          setTanssDown(null);
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 401) {
          setEmployeeId(null);
          return;
        }
        setTanssDown(error instanceof Error ? error.message : "TANSS antwortet nicht");
      });
    return () => {
      cancelled = true;
    };
  }, [employeeId, reload]);

  const showToast = useCallback((text: string) => {
    setToastText(text);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastText(null), 4000);
  }, []);

  /** Every failed call lands here, so a lost session logs out everywhere. */
  const report = useCallback(
    (error: unknown) => {
      if (error instanceof ApiError && error.status === 401) {
        setEmployeeId(null);
        setLoginError("Sitzung abgelaufen, bitte erneut anmelden");
        return;
      }
      const message = error instanceof Error ? error.message : "Unbekannter Fehler";
      if (error instanceof ApiError && (error.status === 0 || error.status >= 502)) {
        setTanssDown(message);
      }
      showToast(message);
    },
    [showToast],
  );

  const updates = useUpdateOverview(employeeId !== null, report);

  async function handleLogin(username: string, password: string, token: string) {
    setPending(true);
    setLoginError(null);
    try {
      const result = await api.login(username, password, token);
      setEmployeeId(result.employeeId);
      setView("tickets");
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : "Anmeldung fehlgeschlagen");
    } finally {
      setPending(false);
    }
  }

  async function handleLogout() {
    await api.logout().catch(() => null);
    setEmployeeId(null);
    setMeta(null);
    setOpenTicket(null);
  }

  const changed = useCallback(() => setReload((n) => n + 1), []);

  /** Every ordinary view change starts the day sheet at today again; only the
   *  jump from the analysis bars seeds a different day. */
  function goto(next: View) {
    setTimesDay(null);
    setView(next);
  }

  // g t / g z / g l, ⌘K, Escape, "/" — the chords of the artboard.
  const chord = useRef<number | null>(null);
  useEffect(() => {
    if (!employeeId) return;
    function onKey(event: KeyboardEvent) {
      const tag = (event.target as HTMLElement | null)?.tagName?.toLowerCase() ?? "";
      const typing = tag === "input" || tag === "textarea" || tag === "select";
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      if (event.key === "Escape") {
        if (paletteOpen) return setPaletteOpen(false);
        if (openTicket) return setOpenTicket(null);
        return;
      }
      if (typing || paletteOpen || openTicket) return;
      if (event.key === "/") {
        event.preventDefault();
        document.getElementById("board-search")?.focus();
        return;
      }
      if (chord.current) {
        window.clearTimeout(chord.current);
        chord.current = null;
        const key = event.key.toLowerCase();
        if (key === "a") {
          event.preventDefault();
          setSidebar((o) => !o);
          return;
        }
        const target = { d: "dashboard", t: "tickets", z: "times", w: "analysis", i: "import", l: "log", s: "settings" }[key];
        if (target) {
          event.preventDefault();
          goto(target as View);
          return;
        }
      }
      if (event.key.toLowerCase() === "g") {
        chord.current = window.setTimeout(() => {
          chord.current = null;
        }, 900);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [employeeId, paletteOpen, openTicket]);

  if (checking || !config) {
    return <main className="login"><p className="muted">Verbinde …</p></main>;
  }
  if (!employeeId) {
    return (
      <Login
        error={loginError}
        pending={pending}
        tokenRequired={config.tokenRequired}
        onSubmit={handleLogin}
      />
    );
  }

  return (
    <>
      <Shell
        view={view}
        onView={(v) => {
          goto(v);
          setQuery("");
        }}
        theme={theme}
        onToggleTheme={() => setTheme(theme === "dark" ? "light" : "dark")}
        tanssState={tanssDown ? "gestört" : meta ? "online" : "…"}
        agentModel={agent?.ready ? agent.model : ""}
        update={updateIndicator(updates.overview, updates.now, __APP_VERSION__)}
        onStartUpdate={(version) =>
          void confirmAndStartUpdate(version, { onOverview: updates.replace, onToast: showToast, onError: report })
        }
        subtitle={subtitle}
        query={query}
        onQuery={setQuery}
        showSearch={view === "tickets"}
        onPalette={() => setPaletteOpen(true)}
        onLogout={handleLogout}
        side={
          <AgentSidebar
            open={sidebar}
            onToggle={() => setSidebar((o) => !o)}
            ready={Boolean(agent?.ready)}
            model={agent?.model ?? ""}
            employeeId={employeeId}
            rows={board.rows}
            activity={board.activity}
            openTicketId={openTicket}
            onClearContext={() => setOpenTicket(null)}
            onOpen={setOpenTicket}
            onView={setView}
            onError={report}
          />
        }
        banner={
          <>
            {tanssDown ? (
              <div className="banner">
                <span className="dot sm warn" />
                <span>TANSS-API antwortet nicht: {tanssDown}</span>
                <button className="btn ghost" style={{ marginLeft: "auto" }} onClick={() => setTanssDown(null)}>
                  Ausblenden
                </button>
              </div>
            ) : null}
            <UpdateBanner
              overview={updates.overview}
              now={updates.now}
              onOverview={updates.replace}
              onToast={showToast}
              onError={report}
            />
          </>
        }
      >
        {view === "dashboard" ? (
          <DashboardView
            reload={reload}
            onSubtitle={setSubtitle}
            onError={report}
            onToast={showToast}
            onOpen={setOpenTicket}
          />
        ) : null}
        {view === "tickets" ? (
          <TicketsView
            query={query}
            meta={meta}
            reload={reload}
            onOpen={setOpenTicket}
            onSubtitle={setSubtitle}
            onError={report}
            onToast={showToast}
            onChanged={changed}
            active={!openTicket && !paletteOpen}
            agentReady={Boolean(agent?.ready)}
            onData={onBoardData}
          />
        ) : null}
        {view === "settings" ? (
          <SettingsView
            onSubtitle={setSubtitle}
            onError={report}
            onToast={showToast}
            onSaved={setAgent}
            onUpdateOverview={updates.replace}
          />
        ) : null}
        {view === "times" ? (
          <TimesView
            meta={meta}
            reload={reload}
            onSubtitle={setSubtitle}
            onError={report}
            onToast={showToast}
            onChanged={changed}
            onOpen={setOpenTicket}
            agentReady={Boolean(agent?.ready)}
            initialDay={timesDay ?? undefined}
          />
        ) : null}
        {view === "analysis" ? (
          <AnalysisView
            meta={meta}
            onSubtitle={setSubtitle}
            onError={report}
            onOpen={setOpenTicket}
            onDay={(day) => {
              setTimesDay(day);
              setView("times");
            }}
          />
        ) : null}
        {view === "import" ? (
          <ImportView
            configured={config.linear}
            agentReady={Boolean(agent?.ready)}
            meta={meta}
            reload={reload}
            onSubtitle={setSubtitle}
            onError={report}
            onToast={showToast}
            onChanged={changed}
          />
        ) : null}
        {view === "log" ? <LogView onSubtitle={setSubtitle} onError={report} /> : null}
      </Shell>

      {openTicket ? (
        <TicketDrawer
          ticketId={openTicket}
          meta={meta}
          ticketUrl={config.ticketUrl}
          onClose={() => setOpenTicket(null)}
          onError={report}
          onToast={showToast}
          onChanged={changed}
          agentReady={Boolean(agent?.ready)}
          boardRows={board.rows}
          onOpen={setOpenTicket}
        />
      ) : null}

      {paletteOpen ? (
        <Palette
          onClose={() => setPaletteOpen(false)}
          onView={(v) => {
            goto(v);
            setPaletteOpen(false);
          }}
          onOpen={(id) => {
            setOpenTicket(id);
            setPaletteOpen(false);
          }}
          onError={report}
        />
      ) : null}

      {toast ? (
        <div className="toast" role="status">
          <span className="dot xs ok" />
          <span>{toast}</span>
        </div>
      ) : null}
    </>
  );
}
