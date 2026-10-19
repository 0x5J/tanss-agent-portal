import "dotenv/config";
import path from "node:path";
import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { createCallLog, loggableBody } from "./log.ts";
import { createTanssClient } from "./tanss.ts";
import { createFileStore } from "./store.ts";
import { createPoller } from "./poller.ts";
import { createLoginGate } from "./login.ts";
import { createSharedSession } from "./shared-session.ts";
import { createLinearClient } from "./linear.ts";
import { createReleaseSource } from "./releases.ts";
import { createUpdateService } from "./updates.ts";
import { VERSION } from "./version.ts";

const config = loadConfig(process.env);
const traceAll = process.env.DEBUG_TANSS === "1";
const callLog = createCallLog();

const tanss = createTanssClient({
  baseUrl: config.tanssBaseUrl,
  onCall(entry) {
    callLog.add({
      kind: "tanss",
      method: entry.method,
      path: entry.path,
      status: entry.status,
      ok: entry.ok,
      durationMs: entry.durationMs,
      message: entry.message,
      body: loggableBody(entry.path, entry.body),
      url: entry.url,
      redirected: entry.redirected,
      response: entry.responseBody,
      traceId: entry.traceId,
    });
    if (!entry.ok || traceAll) {
      console.log(
        `[tanss] ${entry.method} ${entry.path} -> ${entry.status} ${entry.durationMs}ms` +
          `${entry.redirected ? ` (umgeleitet nach ${entry.url})` : ""}` +
          `${entry.message ? ` "${entry.message}"` : ""}`,
      );
    }
  },
});

const store = createFileStore(config.dataDir);
const shared = createSharedSession({ store });
// Optional and off by default: only with stored credentials does the server
// log in by itself. Normally the session comes from the login mask.
const gate = config.tanssCredentials
  ? createLoginGate({
      tanss,
      credentials: config.tanssCredentials,
      totp: config.totp,
      onStop: (reason) => console.error(`[login] ${reason}`),
      onSuccess: ({ employeeId, durationMs, afterFailures }) =>
        console.log(
          `[login] Automatische Anmeldung erfolgreich (Mitarbeiter ${employeeId}, ${durationMs} ms` +
            `${afterFailures > 0 ? `, nach ${afterFailures} Fehlversuch${afterFailures === 1 ? "" : "en"}` : ""})`,
        ),
    })
  : null;
const poller = createPoller({
  tanss,
  store,
  shared,
  ...(gate ? { gate } : {}),
  onError: (message) => console.log(`[dashboard] Messung fehlgeschlagen: ${message}`),
});

/**
 * A measurement triggered by something the user did. Throttled, so a bulk
 * assignment does not send one board load per ticket.
 */
let lastNudge = 0;
function measureSoon(): void {
  const now = Date.now();
  if (now - lastNudge < 30_000) return;
  lastNudge = now;
  setTimeout(() => void poller.tick(), 1_500).unref?.();
}

const updates = createUpdateService({
  dir: path.join(config.dataDir, "update"),
  current: VERSION,
  channel: config.updateChannel,
  enabled: config.updateCheck,
  source: createReleaseSource({ repo: "0x5J/tanss-agent-portal" }),
});

const app = await buildApp({
  sessionSecret: config.sessionSecret,
  tanss,
  totp: config.totp,
  store,
  relogin: gate ? () => gate.login() : null,
  polling: true,
  collectorHealth: () => poller.health(),
  shared,
  ...(config.linearApiKey ? { linear: createLinearClient({ apiKey: config.linearApiKey }) } : {}),
  updates,
  onLogin: () => void poller.tick(),
  onAssignment: () => void measureSoon(),
  log: callLog,
  tanssTicketUrl: config.tanssTicketUrl,
  enableRateLimit: true,
  serveStatic: config.serveStatic,
  uiOrigin: config.uiOrigin,
});

await app.listen({ host: config.bind, port: config.port });
if (config.serveStatic) {
  console.log(`Agent-Portal auf http://${config.bind}:${config.port}`);
} else {
  console.log(`Oberfläche: ${config.uiOrigin}`);
  console.log(`API:        http://${config.bind}:${config.port}`);
}
console.log(`Agent-Daten in ${config.dataDir}`);
if (config.totp) console.log("2FA-Code wird aus TOTP_SECRET erzeugt");
poller.start();
updates.start();
console.log(`Update-Kanal: ${config.updateChannel}`);
if (!config.updateCheck) console.log("UPDATE_CHECK=0: die Suche nach neuen Versionen ist aus");
console.log(
  "Dashboard-Sammler alle 5 Minuten — er nutzt die Sitzung aus der Anmeldemaske, ohne gespeichertes Passwort",
);
if (gate) {
  console.log(
    "TANSS_USERNAME gesetzt: zusätzlich Selbstheilung aus gespeicherten Zugangsdaten " +
      "(abgelehnte werden nie wiederholt, sonst höchstens 4 Versuche: 5/15/45 min)",
  );
}
if (config.linearApiKey) console.log("LINEAR_API_KEY gesetzt: Tagesimport verfügbar");
if (traceAll) console.log("DEBUG_TANSS=1: jeder TANSS-Aufruf wird protokolliert");
