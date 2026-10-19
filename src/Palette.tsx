import { useEffect, useState } from "react";
import { api } from "./api.ts";
import type { TicketRow } from "../shared/tickets.ts";
import type { View } from "./Shell.tsx";

type Props = {
  onClose: () => void;
  onView: (view: View) => void;
  onOpen: (ticketId: number) => void;
  onError: (error: unknown) => void;
};

type Item = { group: string; label: string; hint: string; run: () => void };

export function Palette(props: Props) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<TicketRow[]>([]);
  const [active, setActive] = useState(0);
  const { onError } = props;

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setHits([]);
      return;
    }
    const handle = window.setTimeout(() => {
      api
        .search(q.replace(/^#/, ""))
        .then((result) => setHits(result.tickets))
        .catch(onError);
    }, 250);
    return () => window.clearTimeout(handle);
  }, [query, onError]);

  const q = query.trim().toLowerCase();
  const jump: Item[] = [
    { group: "Springen", label: "Dashboard", hint: "G D", run: () => props.onView("dashboard") },
    { group: "Springen", label: "Tickets", hint: "G T", run: () => props.onView("tickets") },
    { group: "Springen", label: "Freigaben", hint: "G F", run: () => props.onView("approvals") },
    { group: "Springen", label: "Zeiten", hint: "G Z", run: () => props.onView("times") },
    { group: "Springen", label: "Auswertung", hint: "G W", run: () => props.onView("analysis") },
    { group: "Springen", label: "Tagesimport", hint: "G I", run: () => props.onView("import") },
    { group: "Springen", label: "Log", hint: "G L", run: () => props.onView("log") },
  ].filter((item) => !q || item.label.toLowerCase().includes(q));
  const direct = /^#?\d+$/.test(q)
    ? [{ group: "ID-Sprung", label: `Ticket #${q.replace("#", "")} öffnen`, hint: "⏎", run: () => props.onOpen(Number(q.replace("#", ""))) }]
    : [];
  const found: Item[] = hits.map((t) => ({
    group: "Treffer",
    label: `#${t.id} · ${t.title}${t.companyName ? ` · ${t.companyName}` : ""}`,
    hint: t.statusName,
    run: () => props.onOpen(t.id),
  }));
  const items = [...direct, ...found, ...jump];

  useEffect(() => {
    setActive(0);
  }, [query, hits.length]);

  function onKey(event: React.KeyboardEvent) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((a) => Math.min(items.length - 1, a + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (event.key === "Enter" && items[active]) {
      event.preventDefault();
      items[active].run();
    }
  }

  let lastGroup = "";
  return (
    <div className="palette-backdrop" onClick={props.onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <div className="palette-input">
          <span className="mono small" style={{ color: "var(--agent)" }}>⌘K</span>
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            placeholder="Springen oder Ticket suchen …"
          />
        </div>
        <div style={{ padding: "4px 0 6px", maxHeight: "50vh", overflow: "auto" }}>
          {items.map((item, index) => {
            const header = item.group !== lastGroup ? <div className="palette-group">{item.group}</div> : null;
            lastGroup = item.group;
            return (
              <div key={`${item.group}:${item.label}`}>
                {header}
                <button className={`palette-item${index === active ? " active" : ""}`} onClick={item.run} onMouseEnter={() => setActive(index)}>
                  <span className="ellipsis">{item.label}</span>
                  <span className="hint">{item.hint}</span>
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
