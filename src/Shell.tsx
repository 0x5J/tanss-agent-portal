import type { ReactNode } from "react";
import type { UpdateIndicator } from "../shared/update.ts";

export type View = "dashboard" | "tickets" | "approvals" | "times" | "analysis" | "import" | "log" | "settings";

const NAV: { id: View; label: string; key: string; icon: string }[] = [
  { id: "dashboard", label: "Dashboard", key: "G D", icon: "M4 20V10m6 10V4m6 16v-7M3 20h18" },
  { id: "tickets", label: "Tickets", key: "G T", icon: "M4 6h16M4 12h16M4 18h10" },
  { id: "approvals", label: "Freigaben", key: "G F", icon: "M20 6 9 17l-5-5" },
  { id: "times", label: "Zeiten", key: "G Z", icon: "M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0" },
  { id: "analysis", label: "Auswertung", key: "G W", icon: "M4 19h16M7 16V9m5 7V5m5 11v-4" },
  { id: "import", label: "Import", key: "G I", icon: "M12 3v12m0 0-4-4m4 4 4-4M4 19h16" },
  { id: "log", label: "Log", key: "G L", icon: "M6 3h9l4 4v14H6zM9 12h7M9 16h5" },
  { id: "settings", label: "Einstellungen", key: "G S", icon: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4 12h2M18 12h2M12 4v2M12 18v2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M6.3 17.7l1.4-1.4M16.3 7.7l1.4-1.4" },
];

const UPDATE_DOT: Record<UpdateIndicator["tone"], string> = {
  idle: "flat",
  available: "warn",
  progress: "agent",
  error: "danger",
};

const TITLES: Record<View, string> = {
  dashboard: "Dashboard",
  tickets: "Tickets",
  approvals: "Freigaben",
  times: "Zeiten",
  analysis: "Auswertung",
  import: "Tagesimport",
  log: "Log",
  settings: "Einstellungen",
};

type Props = {
  view: View;
  onView: (view: View) => void;
  theme: "dark" | "light";
  onToggleTheme: () => void;
  tanssState: string;
  /** Model name when the local AI is set up, empty otherwise. */
  agentModel: string;
  approvalCount: number;
  /** Running version or pending update; a click opens the settings. */
  update: UpdateIndicator;
  subtitle: string;
  query: string;
  onQuery: (query: string) => void;
  showSearch: boolean;
  onPalette: () => void;
  onLogout: () => void;
  banner: ReactNode;
  /** The agent sidebar (or its rail), right of the main column. */
  side: ReactNode;
  children: ReactNode;
};

export function Shell(props: Props) {
  return (
    <div className="shell">
      <nav className="nav">
        <div className="nav-brand">
          <span className="dot" />
          <span>Agent-Portal</span>
        </div>
        <div className="nav-items">
          {NAV.map((item) => (
            <button
              key={item.id}
              className={`nav-item${props.view === item.id ? " active" : ""}`}
              onClick={() => props.onView(item.id)}
            >
              <span className="label">
                <span className="icon">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d={item.icon} />
                  </svg>
                </span>
                <span>{item.label}</span>
              </span>
              {item.id === "approvals" && props.approvalCount > 0 ? (
                <span className="nav-count">{props.approvalCount}</span>
              ) : null}
              <span className="key">{item.key}</span>
            </button>
          ))}
        </div>
        <div className="nav-foot">
          <div className="nav-status">
            <span className={`dot sm ${props.tanssState === "online" ? "ok" : props.tanssState === "gestört" ? "warn" : "flat"}`} />
            <span>TANSS</span>
            <span className="state">{props.tanssState}</span>
          </div>
          <div className="nav-status" title={props.agentModel || "Kein Modell eingerichtet (Einstellungen)"}>
            <span className={`dot sm ${props.agentModel ? "agent" : "flat"}`} />
            <span>KI</span>
            <span className="state ellipsis">{props.agentModel || "aus"}</span>
          </div>
          <button
            className={`nav-status nav-version ${props.update.tone}`}
            title={props.update.title}
            onClick={() => props.onView("settings")}
          >
            <span className={`dot sm ${UPDATE_DOT[props.update.tone]}`} />
            <span>Version</span>
            <span className="state ellipsis">{props.update.text}</span>
          </button>
          <button className="btn muted" style={{ justifyContent: "space-between" }} onClick={props.onToggleTheme}>
            <span>Erscheinungsbild</span>
            <span className="kbd">{props.theme === "dark" ? "dunkel" : "hell"}</span>
          </button>
          <button className="btn ghost small" style={{ justifyContent: "flex-start" }} onClick={props.onLogout}>
            Abmelden
          </button>
        </div>
      </nav>

      <main className="main">
        <header className="topbar">
          <h1>{TITLES[props.view]}</h1>
          <span className="subtitle ellipsis">{props.subtitle}</span>
          <div className="topbar-right">
            {props.showSearch ? (
              <div className="search">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text2)" strokeWidth="1.5">
                  <circle cx="11" cy="11" r="7" />
                  <path d="m20 20-3.5-3.5" />
                </svg>
                <input
                  id="board-search"
                  value={props.query}
                  onChange={(e) => props.onQuery(e.target.value)}
                  placeholder="Suchen  /"
                />
              </div>
            ) : null}
            <button className="btn muted" onClick={props.onPalette}>
              <span className="kbd">⌘K</span>
              <span>Befehle</span>
            </button>
          </div>
        </header>
        {props.banner}
        <div className="content">{props.children}</div>
      </main>
      {props.side}
    </div>
  );
}
