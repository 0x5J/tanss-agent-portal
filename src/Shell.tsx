import type { ReactNode } from "react";
import type { UpdateIndicator } from "../shared/update.ts";

export type View = "dashboard" | "tickets" | "times" | "analysis" | "import" | "log" | "settings";

type NavItem = { id: View; label: string; key: string; icon: string };

// Grouped as in the redesign: daily work, looking back, the system itself.
const NAV: { label: string; items: NavItem[] }[] = [
  {
    label: "Arbeit",
    items: [
      { id: "tickets", label: "Tickets", key: "G T", icon: "M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" },
      { id: "times", label: "Zeiten", key: "G Z", icon: "M12 6v6l4 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0" },
      { id: "import", label: "Import", key: "G I", icon: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" },
    ],
  },
  {
    label: "Analyse",
    items: [
      { id: "dashboard", label: "Dashboard", key: "G D", icon: "M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z" },
      { id: "analysis", label: "Auswertung", key: "G W", icon: "M3 3v18h18M18 17V9M13 17V5M8 17v-3" },
    ],
  },
  {
    label: "System",
    items: [
      { id: "log", label: "Log", key: "G L", icon: "M6 3h9l4 4v14H6zM9 12h7M9 16h5" },
      { id: "settings", label: "Einstellungen", key: "G S", icon: "M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" },
    ],
  },
];

const GROUP: Record<View, string> = Object.fromEntries(
  NAV.flatMap((group) => group.items.map((item) => [item.id, group.label])),
) as Record<View, string>;

/** The agent's mark: a four-pointed sparkle. */
export const SPARK = "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 3v4M21 5h-4";
const SUN = "M12 3v1M12 20v1M4.2 4.2l.7.7M19.1 19.1l.7.7M3 12h1M20 12h1M4.2 19.8l.7-.7M19.1 4.9l.7-.7M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0";
const MOON = "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z";
const LOGOUT = "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9";

function Icon({ d, size = 18 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none" }}>
      <path d={d} />
    </svg>
  );
}

/** "Sören Jacobsen" → "SJ"; one word gives its first two letters. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

const UPDATE_DOT: Record<UpdateIndicator["tone"], string> = {
  idle: "flat",
  available: "warn",
  progress: "agent",
  error: "danger",
};

const TITLES: Record<View, string> = {
  dashboard: "Dashboard",
  tickets: "Tickets",
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
  /** Running version or pending update; a click starts the update (after asking) or opens the settings. */
  update: UpdateIndicator;
  onStartUpdate: (version: string) => void;
  /** The signed-in technician; empty until the TANSS metadata is in. */
  userName: string;
  employeeId: number;
  subtitle: string;
  query: string;
  onQuery: (query: string) => void;
  showSearch: boolean;
  onPalette: () => void;
  agentOpen: boolean;
  onToggleAgent: () => void;
  onLogout: () => void;
  banner: ReactNode;
  /** The agent sidebar, right of the main column. */
  side: ReactNode;
  children: ReactNode;
};

export function Shell(props: Props) {
  const tanssDot = props.tanssState === "online" ? "ok" : props.tanssState === "gestört" ? "warn" : "flat";
  return (
    <div className="shell">
      <nav className="nav">
        <div className="nav-brand">
          <span className="name">Agent-Portal</span>
          <span className="sub">für TANSS</span>
        </div>
        <div className="nav-items">
          {NAV.map((group) => (
            <div key={group.label} className="nav-group">
              <span className="nav-group-label">{group.label}</span>
              {group.items.map((item) => (
                <button
                  key={item.id}
                  className={`nav-item${props.view === item.id ? " active" : ""}`}
                  onClick={() => props.onView(item.id)}
                  title={`${item.label} (${item.key})`}
                >
                  <span className="icon">
                    <Icon d={item.icon} />
                  </span>
                  <span className="label">{item.label}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
        <div className="nav-foot">
          <div className="nav-status">
            <span className={`dot ${tanssDot}`} />
            <span>TANSS</span>
            <span className="state">{props.tanssState}</span>
          </div>
          <div className="nav-status" title={props.agentModel || "Kein Modell eingerichtet (Einstellungen)"}>
            <span className={`dot ${props.agentModel ? "ok" : "flat"}`} />
            <span>KI</span>
            <span className="state ellipsis">{props.agentModel || "aus"}</span>
          </div>
          <button
            className={`nav-status nav-version ${props.update.tone}`}
            title={props.update.title}
            onClick={() => {
              const version = props.update.start;
              if (version) props.onStartUpdate(version);
              else props.onView("settings");
            }}
          >
            <span className={`dot ${UPDATE_DOT[props.update.tone]}`} />
            <span>Version</span>
            <span className="state ellipsis">{props.update.text}</span>
          </button>
          <div className="nav-user">
            <div className="who">
              <span className="avatar">{initials(props.userName)}</span>
              <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                <span className="name ellipsis">{props.userName || "Angemeldet"}</span>
                <span className="role">TANSS · Mitarbeiter {props.employeeId}</span>
              </div>
            </div>
            <div className="nav-actions">
              <button className="btn" onClick={props.onToggleTheme} title="Erscheinungsbild umschalten">
                <Icon d={props.theme === "dark" ? SUN : MOON} size={14} />
                {props.theme === "dark" ? "Hell" : "Dunkel"}
              </button>
              <button className="btn" onClick={props.onLogout}>
                <Icon d={LOGOUT} size={14} />
                Abmelden
              </button>
            </div>
          </div>
        </div>
      </nav>

      <main className="main">
        <header className="topbar">
          <div className="crumbs">
            <span className="group">{GROUP[props.view]}</span>
            <span className="sep">/</span>
            <h1 className="title">{TITLES[props.view]}</h1>
          </div>
          <span className="subtitle ellipsis">{props.subtitle}</span>
          <div className="topbar-right">
            {props.showSearch ? (
              <div className="search" onClick={() => document.getElementById("board-search")?.focus()}>
                <Icon d="M21 21l-4.3-4.3M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0" size={16} />
                <input
                  id="board-search"
                  value={props.query}
                  onChange={(e) => props.onQuery(e.target.value)}
                  placeholder="Tickets, Kunden, IDs filtern"
                />
                <span className="kbd">/</span>
              </div>
            ) : (
              <button className="search" onClick={props.onPalette}>
                <Icon d="M21 21l-4.3-4.3M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0" size={16} />
                <span className="label">Suchen und springen</span>
                <span className="kbd">⌘K</span>
              </button>
            )}
            {props.showSearch ? (
              <button className="btn ghost" onClick={props.onPalette} title="Befehle und Tickets (⌘K)">
                ⌘K
              </button>
            ) : null}
            <button
              className={`btn agent-toggle${props.agentOpen ? "" : " primary"}`}
              onClick={props.onToggleAgent}
              title={props.agentOpen ? "Agent ausblenden (g a)" : "Agent einblenden (g a)"}
            >
              <Icon d={SPARK} size={16} />
              <span>Agent</span>
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
