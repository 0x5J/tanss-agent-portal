import { useEffect, useState } from "react";
import { api } from "../api.ts";
import type { PublicWebhook, WebhookLink } from "../../shared/webhooks.ts";
import { CheckBox } from "../ui/kit.tsx";

type Props = {
  ticketId: number;
  onError: (error: unknown) => void;
  onToast: (text: string) => void;
};

/**
 * The webhooks hanging on this ticket, and a way to hang another one on it.
 * A technician without any webhook never sees this block, so it stays out of
 * the way for everyone who does not use the feature.
 */
export function TicketWebhooks(props: Props) {
  const { ticketId, onError, onToast } = props;
  const [webhooks, setWebhooks] = useState<PublicWebhook[] | null>(null);
  const [links, setLinks] = useState<WebhookLink[]>([]);
  const [pick, setPick] = useState("");
  const [once, setOnce] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setWebhooks(null);
    setLinks([]);
    setPick("");
    setOnce(false);
    Promise.all([api.webhooks.list(), api.webhooks.links(ticketId)])
      .then(([list, attached]) => {
        if (cancelled) return;
        setWebhooks(list.webhooks);
        setLinks(attached.links);
      })
      .catch((error: unknown) => !cancelled && onError(error));
    return () => {
      cancelled = true;
    };
  }, [ticketId, onError]);

  if (webhooks === null || webhooks.length === 0) return null;

  const attached = links.flatMap((l) => {
    const webhook = webhooks.find((w) => w.id === l.webhookId);
    return webhook ? [{ link: l, webhook }] : [];
  });
  const free = webhooks.filter((w) => w.active && !links.some((l) => l.webhookId === w.id));
  const chosen = free.some((w) => w.id === pick) ? pick : (free[0]?.id ?? "");

  async function attach() {
    if (!chosen) return;
    setBusy(true);
    try {
      const { link } = await api.webhooks.attach(ticketId, chosen, once);
      setLinks((current) => [...current.filter((l) => l.webhookId !== link.webhookId), link]);
      setPick("");
      setOnce(false);
      onToast("Webhook angehängt");
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  }

  async function detach(webhookId: string) {
    setBusy(true);
    try {
      await api.webhooks.detach(ticketId, webhookId);
      setLinks((current) => current.filter((l) => l.webhookId !== webhookId));
      onToast("Webhook gelöst");
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="td-prop wh-ticket">
      <span className="k">Webhooks</span>
      {attached.map(({ link, webhook }) => (
        <div key={webhook.id} className="wh-attached">
          <span className="wh-name ellipsis" title={webhook.name}>{webhook.name}</span>
          {link.once ? <span className="chip">einmalig</span> : null}
          {webhook.active ? null : <span className="chip warn">aus</span>}
          <button className="btn small ghost" disabled={busy} onClick={() => void detach(webhook.id)}>
            Lösen
          </button>
        </div>
      ))}
      {free.length > 0 ? (
        <div className="wh-attach">
          <select className="select" value={chosen} aria-label="Webhook wählen" onChange={(e) => setPick(e.target.value)}>
            {free.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
          <div className="wh-attach-row">
            <button type="button" className="wh-once" role="checkbox" aria-checked={once} onClick={() => setOnce(!once)}>
              <CheckBox on={once} />
              einmalig
            </button>
            <button className="btn small" disabled={busy} onClick={() => void attach()}>
              Anhängen
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
