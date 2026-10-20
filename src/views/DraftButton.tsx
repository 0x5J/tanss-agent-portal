import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { DRAFT_INTENTS, type DraftIntent } from "../../shared/agent.ts";
import { Icon, SPARK_SMALL } from "../ui/kit.tsx";

type Props = {
  ticketIds: number[];
  internal: boolean;
  ready: boolean;
  hasText: boolean;
  onDraft: (text: string) => void;
  onError: (error: unknown) => void;
};

/**
 * "Entwurf vom Agenten ▾": pick an intent, the agent writes into the comment box. The
 * person edits and sends; nothing leaves without that.
 */
export function DraftButton(props: Props) {
  const [open, setOpen] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState<DraftIntent | null>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest?.("[data-draft]")) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  async function run(intent: DraftIntent) {
    if (intent === "custom" && !instruction.trim()) return;
    setBusy(intent);
    try {
      const result = await api.agent.draft({ ticketIds: props.ticketIds, intent, instruction: instruction.trim(), internal: props.internal });
      props.onDraft(result.text);
      setOpen(false);
    } catch (error) {
      props.onError(error);
    } finally {
      setBusy(null);
    }
  }

  return (
    <span className="filter-wrap" data-draft>
      <button
        className="btn"
        disabled={!props.ready || busy !== null}
        title={props.ready ? "Kommentar vom Agenten entwerfen lassen" : "KI nicht eingerichtet (Einstellungen)"}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {busy ? (
          <>
            <span className="dot xs pulse" style={{ background: "currentColor" }} /> entwirft …
          </>
        ) : (
          <>
            <Icon d={SPARK_SMALL} size={14} />
            Entwurf vom Agenten
            <span aria-hidden="true" style={{ fontSize: 10, opacity: 0.6 }}>▾</span>
          </>
        )}
      </button>
      {open ? (
        <div className="popover" style={{ minWidth: 300, left: 0, bottom: "calc(100% + 6px)" }}>
          <span className="popover-label">{props.hasText ? "Ersetzt den vorhandenen Text." : "Was soll der Agent entwerfen?"}</span>
          {DRAFT_INTENTS.filter((i) => i.id !== "custom").map((i) => (
            <button key={i.id} className="popover-item" onClick={() => void run(i.id)}>
              {i.label}
            </button>
          ))}
          <div style={{ padding: "6px 2px 2px", display: "flex", gap: 6 }}>
            <input
              className="input"
              placeholder="Eigene Anweisung …"
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void run("custom");
              }}
              style={{ flex: 1 }}
              autoFocus
            />
            <button className="btn primary" disabled={!instruction.trim()} onClick={() => void run("custom")} aria-label="Entwerfen">
              ⏎
            </button>
          </div>
        </div>
      ) : null}
    </span>
  );
}
