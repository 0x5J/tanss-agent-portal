import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type DeliveryRow, type Meta, type WebhookInput } from "../api.ts";
import { dayAndClock } from "../format.ts";
import { DEFAULT_TEMPLATE, MAX_TEMPLATE_LENGTH, PLACEHOLDERS, type ListedWebhook } from "../../shared/webhooks.ts";
import { CheckBox, Dot, SectionTitle, Switch } from "../ui/kit.tsx";

type Props = {
  onError: (error: unknown) => void;
  onToast: (text: string) => void;
};

type Form = {
  /** Null while a new webhook is being written. */
  id: string | null;
  name: string;
  url: string;
  statusFilter: number[];
  template: string;
  secret: string;
  hadSecret: boolean;
  /** An existing secret is to be dropped on save. */
  dropSecret: boolean;
};

const BLANK: Form = {
  id: null,
  name: "",
  url: "",
  statusFilter: [],
  template: DEFAULT_TEMPLATE,
  secret: "",
  hadSecret: false,
  dropSecret: false,
};

function formOf(w: ListedWebhook): Form {
  return {
    id: w.id,
    name: w.name,
    url: w.url,
    statusFilter: w.statusFilter,
    template: w.template,
    secret: "",
    hadSecret: w.hasSecret,
    dropSecret: false,
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * The technician's webhook targets and the log of what was sent. The secret
 * never comes back from the server, so the field only ever holds a new one.
 */
export function WebhooksSettings(props: Props) {
  const { onError, onToast } = props;
  const [webhooks, setWebhooks] = useState<ListedWebhook[] | null>(null);
  const [states, setStates] = useState<Meta["states"]>([]);
  const [deliveries, setDeliveries] = useState<DeliveryRow[] | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  const templateRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.webhooks.list(), api.meta(), api.webhooks.deliveries()])
      .then(([list, meta, log]) => {
        if (cancelled) return;
        setWebhooks(list.webhooks);
        setStates([...meta.states].sort((a, b) => a.rank - b.rank));
        setDeliveries(log.deliveries);
      })
      .catch((error: unknown) => !cancelled && onError(error));
    return () => {
      cancelled = true;
    };
  }, [onError]);

  const reloadLog = useCallback(async () => {
    setReloading(true);
    try {
      setDeliveries((await api.webhooks.deliveries()).deliveries);
    } catch (error) {
      onError(error);
    } finally {
      setReloading(false);
    }
  }, [onError]);

  const stateName = (id: number) => states.find((s) => s.id === id)?.name ?? `Status ${id}`;
  const filterText = (w: ListedWebhook) =>
    w.statusFilter.length === 0 ? "jeder Wechsel" : w.statusFilter.map(stateName).join(", ");

  function open(next: Form) {
    setForm(next);
    setFormError("");
  }

  function patch(change: Partial<Form>) {
    setForm((current) => (current ? { ...current, ...change } : current));
  }

  function toggleState(id: number) {
    if (!form) return;
    patch({ statusFilter: form.statusFilter.includes(id) ? form.statusFilter.filter((x) => x !== id) : [...form.statusFilter, id] });
  }

  function insertPlaceholder(name: string) {
    if (!form) return;
    const token = `{{${name}}}`;
    const area = templateRef.current;
    const from = area ? area.selectionStart : form.template.length;
    const to = area ? area.selectionEnd : form.template.length;
    patch({ template: form.template.slice(0, from) + token + form.template.slice(to) });
    requestAnimationFrame(() => {
      area?.focus();
      area?.setSelectionRange(from + token.length, from + token.length);
    });
  }

  async function save() {
    if (!form) return;
    const input: WebhookInput = {
      name: form.name,
      url: form.url,
      statusFilter: form.statusFilter,
      template: form.template,
    };
    if (form.secret) input.secret = form.secret;
    else if (form.dropSecret) input.secret = "";
    setSaving(true);
    setFormError("");
    try {
      if (form.id) {
        const { webhook } = await api.webhooks.update(form.id, input);
        setWebhooks((list) => (list ?? []).map((w) => (w.id === webhook.id ? webhook : w)));
        onToast("Webhook gespeichert");
      } else {
        const { webhook } = await api.webhooks.create(input);
        setWebhooks((list) => [...(list ?? []), webhook]);
        onToast("Webhook angelegt");
      }
      setForm(null);
    } catch (error) {
      // Only a refused input belongs at the form; a dead session or a lost connection is for the banner.
      if (error instanceof ApiError && (error.status === 400 || error.status === 409)) setFormError(error.message);
      else onError(error);
    } finally {
      setSaving(false);
    }
  }

  async function setActive(w: ListedWebhook, active: boolean) {
    setBusy(w.id);
    try {
      const { webhook } = await api.webhooks.update(w.id, { name: w.name, url: w.url, active });
      setWebhooks((list) => (list ?? []).map((x) => (x.id === webhook.id ? webhook : x)));
      onToast(active ? "Webhook eingeschaltet" : "Webhook ausgeschaltet");
    } catch (error) {
      onError(error);
    } finally {
      setBusy(null);
    }
  }

  async function test(w: ListedWebhook) {
    setBusy(w.id);
    try {
      const result = await api.webhooks.test(w.id);
      onToast(result.ok ? `Test erfolgreich (${result.status})` : `Test fehlgeschlagen: ${result.error}`);
    } catch (error) {
      onError(error);
    } finally {
      setBusy(null);
    }
  }

  async function remove(w: ListedWebhook) {
    if (!window.confirm(`Webhook „${w.name}“ löschen? Er wird auch von allen Tickets gelöst.`)) return;
    setBusy(w.id);
    try {
      await api.webhooks.remove(w.id);
      setWebhooks((list) => (list ?? []).filter((x) => x.id !== w.id));
      if (form?.id === w.id) setForm(null);
      onToast("Webhook gelöscht");
    } catch (error) {
      onError(error);
    } finally {
      setBusy(null);
    }
  }

  async function resend(d: DeliveryRow) {
    setBusy(d.id);
    try {
      await api.webhooks.resend(d.id);
      onToast("Zustellung wird erneut gesendet");
      await reloadLog();
    } catch (error) {
      onError(error);
    } finally {
      setBusy(null);
    }
  }

  if (webhooks === null) return null;
  const knownIds = new Set(states.map((s) => s.id));
  const unknownIds = form ? form.statusFilter.filter((id) => !knownIds.has(id)) : [];
  const canSave = form !== null && form.name.trim() !== "" && form.url.trim() !== "" && !saving;

  return (
    <>
      <section className="section" style={{ gap: 12 }}>
        <SectionTitle title="Webhooks">
          <button className="btn primary" disabled={form !== null && form.id === null} onClick={() => open({ ...BLANK })}>
            Webhook anlegen
          </button>
        </SectionTitle>
        {webhooks.length === 0 && !form ? (
          <p className="lead">
            Ein Webhook ruft eine Adresse auf, sobald sich der Status eines Tickets ändert — zum Beispiel, um einen
            Ablauf in n8n anzustoßen. Im Ticket erscheint die Auswahl erst, nachdem du hier einen Webhook angelegt hast.
          </p>
        ) : null}

        {form ? (
          <form
            className="form-card wh-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (canSave) void save();
            }}
          >
            <label className="field">
              <span>Name</span>
              <input
                className="input"
                value={form.name}
                maxLength={80}
                placeholder="z. B. Statusmeldung an n8n"
                onChange={(e) => patch({ name: e.target.value })}
                autoFocus
              />
            </label>
            <label className="field">
              <span>URL</span>
              <input
                className="input"
                type="url"
                value={form.url}
                maxLength={2000}
                placeholder="https://n8n.example.com/webhook/…"
                onChange={(e) => patch({ url: e.target.value })}
              />
              <span className="form-help">Es wird per POST mit JSON aufgerufen. Erlaubt sind http und https.</span>
            </label>
            <div className="field">
              <span>Zielstatus</span>
              <div className="wh-states" role="group" aria-label="Zielstatus">
                {[...states.map((s) => ({ id: s.id, name: s.name })), ...unknownIds.map((id) => ({ id, name: stateName(id) }))].map(
                  (s) => {
                    const on = form.statusFilter.includes(s.id);
                    return (
                      <button
                        key={s.id}
                        type="button"
                        className={`wh-state${on ? " on" : ""}`}
                        role="checkbox"
                        aria-checked={on}
                        onClick={() => toggleState(s.id)}
                      >
                        <CheckBox on={on} />
                        {s.name}
                      </button>
                    );
                  },
                )}
              </div>
              <span className="form-help">
                {form.statusFilter.length === 0
                  ? "Nichts gewählt: der Webhook feuert bei jedem Statuswechsel."
                  : "Der Webhook feuert nur, wenn das Ticket in einen der gewählten Status wechselt."}
              </span>
            </div>
            <div className="field">
              <label htmlFor="wh-template">Vorlage</label>
              <textarea
                id="wh-template"
                ref={templateRef}
                className="textarea wh-template"
                rows={6}
                value={form.template}
                maxLength={MAX_TEMPLATE_LENGTH}
                spellCheck={false}
                onChange={(e) => patch({ template: e.target.value })}
              />
              <div className="wh-placeholders" aria-label="Platzhalter">
                {PLACEHOLDERS.map((p) => (
                  <button key={p} type="button" className="wh-placeholder" onClick={() => insertPlaceholder(p)} title="an der Schreibmarke einfügen">
                    {`{{${p}}}`}
                  </button>
                ))}
              </div>
              <span className="form-help">
                Der Rumpf muss gültiges JSON ergeben. {"{{json}}"} ist die vollständige Meldung; Text-Platzhalter werden
                passend maskiert, setze sie also in Anführungszeichen.
              </span>
            </div>
            <div className="field">
              <label htmlFor="wh-secret">Geheimnis</label>
              <div className="wh-secret">
                <input
                  id="wh-secret"
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  value={form.secret}
                  maxLength={200}
                  disabled={form.dropSecret}
                  placeholder={form.hadSecret ? (form.dropSecret ? "wird beim Speichern entfernt" : "gesetzt – leer lassen zum Behalten") : "optional"}
                  onChange={(e) => patch({ secret: e.target.value })}
                />
                {form.hadSecret ? (
                  <button type="button" className="btn small" onClick={() => patch({ dropSecret: !form.dropSecret, secret: "" })}>
                    {form.dropSecret ? "behalten" : "entfernen"}
                  </button>
                ) : null}
              </div>
              <span className="form-help">
                Mit Geheimnis signiert das Portal jeden Aufruf (Kopfzeile X-Portal-Signature, HMAC-SHA256 über
                „Zeitstempel.Rumpf“). Es wird nach dem Speichern nicht mehr angezeigt.
              </span>
            </div>
            {formError ? <span className="form-help danger" role="alert">{formError}</span> : null}
            <div className="form-foot">
              <button className="btn primary" type="submit" disabled={!canSave}>
                {saving ? "Speichert …" : form.id ? "Speichern" : "Anlegen"}
              </button>
              <button className="btn" type="button" disabled={saving} onClick={() => setForm(null)}>
                Abbrechen
              </button>
            </div>
          </form>
        ) : null}

        {webhooks.map((w) => (
          <div key={w.id} className={`status-card wh-item${w.active ? "" : " off"}`}>
            <div className="name">
              <strong>{w.name}</strong>
              <span className="small muted wh-meta">
                {hostOf(w.url)} · {filterText(w)}
                {w.hasSecret ? " · signiert" : ""}
                {w.linkCount > 0 ? ` · ${w.linkCount} ${w.linkCount === 1 ? "Ticket" : "Tickets"}` : ""}
              </span>
            </div>
            <span className="state">
              <Switch on={w.active} label={`${w.name} aktiv`} disabled={busy === w.id} onChange={(on) => void setActive(w, on)} />
              {w.active ? "aktiv" : "aus"}
            </span>
            <div className="actions">
              <button className="btn small" disabled={busy === w.id} onClick={() => void test(w)}>
                Testen
              </button>
              <button className="btn small" onClick={() => open(formOf(w))}>
                Bearbeiten
              </button>
              <button className="btn small danger-hover" disabled={busy === w.id} onClick={() => void remove(w)}>
                Löschen
              </button>
            </div>
          </div>
        ))}
      </section>

      {webhooks.length > 0 || (deliveries ?? []).length > 0 ? (
        <section className="section" style={{ gap: 12 }}>
          <SectionTitle title="Protokoll" note="Neueste zuerst">
            <button className="btn small" disabled={reloading} onClick={() => void reloadLog()}>
              {reloading ? "Lädt …" : "Aktualisieren"}
            </button>
          </SectionTitle>
          {(deliveries ?? []).length === 0 ? (
            <p className="lead">Noch nichts gesendet. Sobald ein Ticket mit einem Webhook den Status wechselt, steht es hier.</p>
          ) : (
            <div className="table-scroll">
              <div className="table wh-log">
                <div className="thead wh-row">
                  <span>Zeit</span>
                  <span>Webhook</span>
                  <span>Ticket</span>
                  <span>Status</span>
                  <span>Ergebnis</span>
                  <span />
                </div>
                {(deliveries ?? []).map((d) => (
                  <div key={d.id} className="trow wh-row">
                    <span className="mono">{dayAndClock(d.createdAt)}</span>
                    <span className="ellipsis" title={d.url}>{d.webhookName}</span>
                    <span className="mono">#{d.ticketId}</span>
                    <span className="wh-wrap">
                      {d.statusOld} → {d.statusNew}
                    </span>
                    <DeliveryResult d={d} />
                    <span className="wh-act">
                      {d.state !== "pending" ? (
                        <button className="btn small" disabled={busy === d.id} onClick={() => void resend(d)}>
                          Erneut senden
                        </button>
                      ) : null}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      ) : null}
    </>
  );
}

function DeliveryResult({ d }: { d: DeliveryRow }) {
  if (d.state === "pending") {
    return (
      <span className="wh-result" title={d.result || undefined}>
        <Dot tone="warn" />
        <span className="wh-nowrap">wartet (Versuch {d.attempts + 1})</span>
      </span>
    );
  }
  return (
    <span className="wh-result" title={d.result || undefined}>
      <Dot tone={d.state === "ok" ? "ok" : "danger"} />
      <span className="wh-wrap">{d.result || (d.state === "ok" ? "ok" : "fehlgeschlagen")}</span>
    </span>
  );
}
