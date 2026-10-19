import { parseTotpConfig, type TotpConfig } from "./totp.ts";

export type ServerConfig = {
  bind: string;
  port: number;
  sessionSecret: string;
  tanssBaseUrl: string;
  serveStatic: boolean;
  uiOrigin: string;
  /** Prefix of the TANSS web view of a ticket; the ticket id is appended. */
  tanssTicketUrl: string;
  /** Token seed for the 2FA code. Null means the user types the code. */
  totp: TotpConfig | null;
  /** Where the agent keeps its settings and proposals. */
  dataDir: string;
  /**
   * TANSS login of the portal user. When set (with TOTP_SECRET for 2FA), the
   * server heals dead sessions itself and the dashboard poller runs.
   */
  tanssCredentials: { username: string; password: string } | null;
  /** Personal Linear API key; without it the import tab says so. */
  linearApiKey: string;
};

export function loadConfig(env: NodeJS.ProcessEnv): ServerConfig {
  const bind = env.BIND ?? "127.0.0.1";
  // In a container the process must listen on all of its own interfaces; the
  // published port is bound to the host's loopback in compose.yaml.
  const allowAll = env.ALLOW_ALL_INTERFACES === "1";
  const allowed = allowAll
    ? ["127.0.0.1", "localhost", "0.0.0.0"]
    : ["127.0.0.1", "localhost"];
  if (!allowed.includes(bind)) {
    throw new Error(
      allowAll
        ? "BIND darf nur 127.0.0.1, localhost oder 0.0.0.0 sein"
        : "BIND darf nur 127.0.0.1 oder localhost sein (0.0.0.0 nur mit ALLOW_ALL_INTERFACES=1)",
    );
  }
  const sessionSecret = env.SESSION_SECRET ?? "";
  if (sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET muss mindestens 32 Zeichen lang sein");
  }
  const tanssBaseUrl = (env.TANSS_BASE_URL ?? "").replace(/\/$/, "");
  if (!tanssBaseUrl) {
    throw new Error("TANSS_BASE_URL fehlt");
  }
  const port = Number(env.PORT ?? 3848);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT ist ungültig");
  }
  return {
    bind,
    port,
    sessionSecret,
    tanssBaseUrl,
    serveStatic: env.SERVE_STATIC === "1",
    uiOrigin: env.UI_ORIGIN ?? "http://127.0.0.1:5173",
    tanssTicketUrl: parseTicketUrl(env.TANSS_TICKET_URL, tanssBaseUrl),
    totp: parseTotp(env.TOTP_SECRET),
    dataDir: env.DATA_DIR || "data",
    tanssCredentials: parseCredentials(env.TANSS_USERNAME, env.TANSS_PASSWORD),
    linearApiKey: (env.LINEAR_API_KEY ?? "").trim(),
  };
}

function parseCredentials(
  username: string | undefined,
  password: string | undefined,
): { username: string; password: string } | null {
  const user = (username ?? "").trim();
  const pass = password ?? "";
  if (!user && !pass) return null;
  if (!user || !pass) {
    throw new Error("TANSS_USERNAME und TANSS_PASSWORD gehören zusammen — eines allein hilft nicht");
  }
  return { username: user, password: pass };
}

export function parseTicketUrl(raw: string | undefined, tanssBaseUrl: string): string {
  const configured = (raw ?? "").trim();
  if (configured) {
    if (!/^https?:\/\//.test(configured)) {
      throw new Error("TANSS_TICKET_URL muss mit http oder https beginnen");
    }
    return configured;
  }
  try {
    return `${new URL(tanssBaseUrl).origin}/index.php?section=bug&sub=view&bugID=`;
  } catch {
    return "";
  }
}

function parseTotp(raw: string | undefined): TotpConfig | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  // An invalid seed fails at startup, not at the first login attempt.
  return parseTotpConfig(value);
}
