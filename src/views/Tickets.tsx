import { useEffect, useMemo, useRef, useState } from "react";
import { api, type ActivityResult, type Meta } from "../api.ts";
import {
  activityLabel,
  elapsedSeconds,
  formatElapsed,
  ticketIdleDays,
  type Activity,
} from "../../shared/activity.ts";
import { dayAndClock, todayYmd } from "../format.ts";
import { formatShortDate, shiftYmd } from "../../shared/days.ts";
import {
  LISTS,
  rowsForList,
  formatUpdated,
  matchesQuery,
  rowTone,
  type ListId,
  type TicketRow,
} from "../../shared/tickets.ts";
import { fullDate, nowUnix } from "../format.ts";
import {
  EMPTY_FILTERS,
  FILTER_COLUMNS,
  applyFilters,
  columnOptions,
  hasFilters,
  toggleValue,
  type ColumnFilters,
  presetFilters,
  type FilterKey,
  type SavedView,
} from "../../shared/filters.ts";
import { rangeSelection } from "../../shared/selection.ts";
import { loadActiveTab, loadViews, newViewId, storeActiveTab, storeViews } from "../savedViews.ts";
import { AgentPanel } from "./AgentPanel.tsx";
import { DraftButton } from "./DraftButton.tsx";
import { CheckBox, Dot, Icon, PageHeader } from "../ui/kit.tsx";
import "../styles/tickets.css";

type Props = {
  query: string;
  meta: Meta | null;
  reload: number;
  active: boolean;
  onOpen: (id: number) => void;
  onSubtitle: (text: string) => void;
  onError: (error: unknown) => void;
  onToast: (text: string) => void;
  onChanged: () => void;
  agentReady: boolean;
  /** The board's rows and activity, for whoever needs them as context. */
  onData: (rows: TicketRow[], activity: Record<number, Activity>) => void;
};

const ACTIVITY_LOOKBACK = 365;

type ColumnId = "source" | "id" | "title" | "customer" | "status" | "type" | "assignee" | "department" | "age" | "idle" | "updated";
type ColumnDef = { id: ColumnId; label: string; width: string; min: number };

/** Every column the board can show, in order; the grid is built from the visible ones. */
const COLUMNS: ColumnDef[] = [
  { id: "source", label: "Quelle", width: "80px", min: 80 },
  { id: "id", label: "ID", width: "84px", min: 84 },
  { id: "title", label: "Betreff", width: "minmax(280px, 1fr)", min: 280 },
  { id: "customer", label: "Kunde", width: "170px", min: 170 },
  { id: "status", label: "Status", width: "160px", min: 160 },
  { id: "type", label: "Typ", width: "120px", min: 120 },
  { id: "assignee", label: "Zuständig", width: "150px", min: 150 },
  { id: "department", label: "Abteilung", width: "130px", min: 130 },
  { id: "age", label: "Alter", width: "72px", min: 72 },
  { id: "idle", label: "Inaktiv", width: "80px", min: 80 },
  { id: "updated", label: "Aktualisiert", width: "104px", min: 104 },
];
const DEFAULT_COLUMNS: ColumnId[] = ["id", "title", "customer", "status", "type", "assignee", "age", "idle", "updated"];
const COLUMNS_KEY = "agent-portal:columns";

function loadColumns(): ColumnId[] {
  try {
    const stored = JSON.parse(localStorage.getItem(COLUMNS_KEY) ?? "null") as unknown;
    if (Array.isArray(stored)) {
      const known = stored.filter((id): id is ColumnId => COLUMNS.some((c) => c.id === id));
      if (known.length) return known;
    }
  } catch {
    /* private mode or junk: fall back */
  }
  return DEFAULT_COLUMNS;
}

const ids = (list: number[]) => [...new Set(list)];

export function TicketsView(props: Props) {
  const [list, setList] = useState<ListId>("own");
  const [rows, setRows] = useState<TicketRow[]>([]);
  const [employeeId, setEmployeeId] = useState(0);
  const [employeeName, setEmployeeName] = useState("");
  const [missing, setMissing] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [focus, setFocus] = useState(0);
  const [selected, setSelected] = useState<number[]>([]);
  /** The row last picked without shift — where a shift-click reaches from. */
  const [anchor, setAnchor] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [statusPick, setStatusPick] = useState(false);
  const [assignPick, setAssignPick] = useState(false);
  const [assignSearch, setAssignSearch] = useState("");
  const [duePick, setDuePick] = useState(false);
  const [dueDay, setDueDay] = useState("");
  // "Due on X" means "by the end of business" — the field says so and stays editable.
  const [dueTime, setDueTime] = useState("17:00");
  const [filters, setFilters] = useState<ColumnFilters>(EMPTY_FILTERS);
  /** The open dropdown: a column filter or the column picker. */
  const [openFilter, setOpenFilter] = useState<FilterKey | "__columns" | null>(null);
  const [columns, setColumns] = useState<ColumnId[]>(loadColumns);
  const [views, setViews] = useState<SavedView[]>([]);
  const [activeView, setActiveView] = useState<string | null>(null);
  const [saveName, setSaveName] = useState<string | null>(null);
  const [commentOpen, setCommentOpen] = useState(false);
  const [commentText, setCommentText] = useState("");
  const [commentInternal, setCommentInternal] = useState(true);
  /** Activity per ticket, filled for whatever has been visible so far. */
  const [activityMap, setActivityMap] = useState<Record<number, Activity>>({});
  const [activityMeta, setActivityMeta] = useState<Pick<ActivityResult, "today" | "since" | "supportsRead"> | null>(null);
  const [activityPending, setActivityPending] = useState<Set<number>>(new Set());
  const [activityError, setActivityError] = useState<string | null>(null);
  const [unreadHistories, setUnreadHistories] = useState(0);
  const loadedRef = useRef<Set<number>>(new Set());
  const [sort, setSort] = useState<"modified" | "age" | "idle">("modified");
  const { onSubtitle, onError, onOpen, onToast, onChanged, active, onData } = props;

  useEffect(() => {
    onData(rows, activityMap);
  }, [rows, activityMap, onData]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .tickets()
      .then((result) => {
        if (cancelled) return;
        setRows(result.rows);
        setEmployeeId(result.employeeId);
        setEmployeeName(result.employeeName);
        setMissing(result.missing);
        setSelected([]);
        setFocus(0);
        // First load: bring back the saved lists and the tab that was open,
        // and spell the tab out as filters. A later reload (after a write)
        // keeps whatever filters the user has set meanwhile.
        if (!restoredRef.current) {
          restoredRef.current = true;
          void loadViews(result.employeeId).then((storedViews) => {
            if (cancelled) return;
            setViews(storedViews);
            const last = loadActiveTab(result.employeeId);
            const lastView = storedViews.find((v) => v.id === last);
            let listId = listRef.current;
            if (lastView) {
              setActiveView(lastView.id);
              listId = lastView.list;
              setList(listId);
            } else if (LISTS.some((l) => l.id === last)) {
              listId = last as ListId;
              setList(listId);
            }
            setFilters(
              lastView
                ? lastView.filters
                : presetFilters(listId, result.rows, { id: result.employeeId, name: result.employeeName }),
            );
          });
        }
        // A reload after a write may have changed histories: forget them.
        loadedRef.current = new Set();
        setActivityMap({});
        setUnreadHistories(0);
        setActivityError(null);
      })
      .catch((error: unknown) => {
        if (!cancelled) onError(error);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [props.reload, onError]);

  // Refs so the one-time load can read the current tab without re-running.
  const listRef = useRef(list);
  const restoredRef = useRef(false);
  listRef.current = list;

  // Remember the open tab across reloads.
  useEffect(() => {
    if (employeeId && restoredRef.current) storeActiveTab(employeeId, activeView ?? list);
  }, [employeeId, activeView, list]);

  // A click outside the open dropdown closes it — and still reaches its target,
  // so switching from one column's menu straight to another's takes one click.
  useEffect(() => {
    if (!openFilter) return;
    function onDown(event: MouseEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.closest(`[data-filter="${openFilter}"]`)) return;
      setOpenFilter(null);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [openFilter]);

  useEffect(() => {
    try {
      localStorage.setItem(COLUMNS_KEY, JSON.stringify(columns));
    } catch {
      /* ignore */
    }
  }, [columns]);

  function toggleColumn(id: ColumnId) {
    if (id === "title") return;
    setColumns((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  }

  // Minutes go stale in a way days never did: tick once a minute so the age
  // and idle columns keep telling the truth without a reload. No request.
  const [now, setNow] = useState(() => nowUnix());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(nowUnix()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const today = activityMeta?.today ?? todayYmd();
  const since = activityMeta?.since ?? "";
  const NONE: Activity = { at: 0, kind: "none", historyRead: false };
  const ageOf = (row: TicketRow) => elapsedSeconds(row.creationDate, now);
  const idleOf = (row: TicketRow) => {
    const a = activityMap[row.id];
    return a ? ticketIdleDays(row.creationDate, a, today, since) : null;
  };
  // Sorting needs the exact distance, not the shown unit — ten minutes and
  // fifty would otherwise tie. A lower bound has no moment, so its days count.
  const idleSecondsOf = (row: TicketRow) => {
    const idle = idleOf(row);
    if (!idle) return 0;
    return idle.atLeast ? idle.days * 86_400 : elapsedSeconds(idle.at, now);
  };

  // Projects and day-to-day tickets are disjoint halves of the same set: the
  // Projekte tab shows only projects, every other tab only the rest. A
  // months-long project in "Alle" would distort the counts and the age chart.
  const base = useMemo(() => rowsForList(rows, list), [rows, list]);
  const filtered = useMemo(() => applyFilters(base, filters), [base, filters]);
  const visible = useMemo(() => {
    const list = filtered.filter((row) => matchesQuery(row, props.query));
    if (sort === "age") return [...list].sort((a, b) => ageOf(b) - ageOf(a) || b.id - a.id);
    if (sort === "idle") {
      return [...list].sort((a, b) => idleSecondsOf(b) - idleSecondsOf(a) || b.id - a.id);
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, props.query, sort, activityMap, today]);

  // Histories only for what is on screen: whoever filters to ten tickets pays
  // for ten, not for the whole board. Already loaded ones are kept.
  useEffect(() => {
    const missing = visible.map((r) => r.id).filter((id) => !loadedRef.current.has(id));
    if (missing.length === 0) return;
    const batch = missing.slice(0, 200);
    for (const id of batch) loadedRef.current.add(id);
    setActivityPending((p) => new Set([...p, ...batch]));
    let cancelled = false;
    let sent = false;
    const handle = window.setTimeout(() => {
      sent = true;
      api
        .activity(batch)
        .then((result) => {
          if (cancelled) return;
          setActivityMeta({ today: result.today, since: result.since, supportsRead: result.supportsRead });
          setActivityMap((m) => {
            const next = { ...m };
            for (const [id, a] of Object.entries(result.activity)) next[Number(id)] = a;
            return next;
          });
          setUnreadHistories((n) => n + (result.historyChecked - result.historyRead));
          setActivityError(null);
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          for (const id of batch) loadedRef.current.delete(id);
          setActivityError(error instanceof Error ? error.message : "Verlauf nicht lesbar");
        })
        .finally(() => {
          if (!cancelled) setActivityPending((p) => new Set([...p].filter((id) => !batch.includes(id))));
        });
    }, 250);
    return () => {
      // A request already on its way is left to finish and merge; only a
      // batch still waiting in the debounce is given back.
      if (sent) return;
      cancelled = true;
      window.clearTimeout(handle);
      for (const id of batch) loadedRef.current.delete(id);
      setActivityPending((p) => new Set([...p].filter((id) => !batch.includes(id))));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const coverageNotes: string[] = [];
  if (unreadHistories > 0) {
    coverageNotes.push(
      activityMeta?.supportsRead !== false
        ? `Für ${unreadHistories} Ticket${unreadHistories === 1 ? "" : "s"} ließ sich der Verlauf nicht lesen — dort zählt nur die letzte Leistung der letzten ${ACTIVITY_LOOKBACK} Tage.`
        : `Für ${unreadHistories} Ticket${unreadHistories === 1 ? "" : "s"} ließ sich weder Verlauf noch Leistungsliste lesen — „Inaktiv" zeigt dort nur das Alter.`,
    );
  }
  if (missing.length) {
    const names = missing.map((m) => LISTS.find((l) => l.id === m)?.label ?? m).join(", ");
    coverageNotes.push(`Liste nicht lesbar (fehlendes Recht?): ${names} — diese Tickets fehlen in allen Tabs.`);
  }
  if (activityError) coverageNotes.push(`Inaktivität nicht ermittelbar: ${activityError}`);

  function selectList(id: ListId) {
    setList(id);
    setActiveView(null);
    setFilters(presetFilters(id, rows, { id: employeeId, name: employeeName }));
  }

  function selectView(view: SavedView) {
    setList(view.list);
    setActiveView(view.id);
    setFilters(view.filters);
  }

  function persist(next: SavedView[]) {
    setViews(next);
    if (employeeId) storeViews(employeeId, next).catch(onError);
  }

  function saveView(name: string, asNew = false) {
    const trimmed = name.trim();
    setSaveName(null);
    if (!trimmed) return;
    if (activeView && !asNew) {
      persist(views.map((v) => (v.id === activeView ? { ...v, name: trimmed, list, filters } : v)));
      onToast(`Liste „${trimmed}" aktualisiert`);
      return;
    }
    const view: SavedView = { id: newViewId(), name: trimmed, list, filters };
    persist([...views, view]);
    setActiveView(view.id);
    onToast(`Liste „${trimmed}" gespeichert`);
  }

  function deleteView(id: string) {
    const view = views.find((v) => v.id === id);
    persist(views.filter((v) => v.id !== id));
    if (activeView === id) {
      setActiveView(null);
      setFilters(EMPTY_FILTERS);
    }
    if (view) onToast(`Liste „${view.name}" gelöscht`);
  }

  const currentView = views.find((v) => v.id === activeView) ?? null;
  const viewDirty =
    currentView !== null &&
    (currentView.list !== list || JSON.stringify(currentView.filters) !== JSON.stringify(filters));

  useEffect(() => {
    const label = currentView?.name ?? LISTS.find((l) => l.id === list)?.label ?? "";
    onSubtitle(loading ? "lädt …" : `${visible.length} Einträge · ${label}`);
  }, [visible.length, list, loading, onSubtitle, currentView?.name]);

  useEffect(() => {
    setFocus((f) => Math.min(f, Math.max(0, visible.length - 1)));
  }, [visible.length]);

  /** Picking a row: alone, or — holding shift — everything back to the anchor. */
  function pick(id: number, extend: boolean) {
    const ids = visible.map((r) => r.id);
    const from = extend ? anchor : null;
    setSelected((s) => rangeSelection(s, ids, from, id));
    // A pick that could not reach anywhere becomes the new anchor.
    if (from === null || !ids.includes(from)) setAnchor(id);
  }

  function clearSelection() {
    setSelected([]);
    setAnchor(null);
  }

  const targets = selected.length ? selected : visible[focus] ? [visible[focus].id] : [];

  async function assignToMe() {
    if (!targets.length || !employeeId) return;
    await apply(targets, { assignedToEmployeeId: employeeId }, `Zugewiesen an mich`);
  }

  function openAssignPick() {
    if (!targets.length) return;
    setAssignSearch("");
    setAssignPick(true);
  }

  async function assignTo(technician: { id: number; name: string }) {
    setAssignPick(false);
    if (!targets.length) return;
    await apply(targets, { assignedToEmployeeId: technician.id }, `Zugewiesen an ${technician.name}`);
  }

  async function setStatus(statusId: number) {
    setStatusPick(false);
    if (!targets.length) return;
    const name = props.meta?.states.find((s) => s.id === statusId)?.name ?? String(statusId);
    await apply(targets, { statusId }, `Status „${name}"`);
  }

  /** The due date of every selected ticket; an empty day clears it. */
  async function setDue(day: string, time: string) {
    setDuePick(false);
    if (!targets.length) return;
    const [h, m] = time.split(":").map(Number);
    const minute = Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : 17 * 60;
    await apply(
      targets,
      { dueDate: day, dueMinute: minute },
      day ? `Fällig ${formatShortDate(day)} ${time}` : "Fälligkeit entfernt",
    );
  }

  /** TANSS has no bulk route: one read-modify-write per ticket, each reported. */
  async function apply(
    ids: number[],
    patch: { statusId?: number; assignedToEmployeeId?: number; dueDate?: string; dueMinute?: number },
    label: string,
  ) {
    setBusy(true);
    let ok = 0;
    const failed: string[] = [];
    for (const id of ids) {
      try {
        const result = await api.patchTicket(id, patch);
        setRows((r) => r.map((row) => (row.id === id ? { ...row, ...result.ticket, waiting: row.waiting } : row)));
        ok++;
      } catch (error) {
        failed.push(`#${id}: ${error instanceof Error ? error.message : "Fehler"}`);
      }
    }
    setBusy(false);
    setSelected([]);
    onToast(
      failed.length
        ? `${label}: ${ok} gesetzt, ${failed.length} abgelehnt — ${failed[0]}`
        : `${label}: ${ok} Ticket${ok === 1 ? "" : "s"}`,
    );
    onChanged();
  }

  /** One comment into every selected ticket, each reported on its own. */
  async function commentAll() {
    const text = commentText.trim();
    if (!text || !targets.length) return;
    setBusy(true);
    let ok = 0;
    const failed: string[] = [];
    for (const id of ids(targets)) {
      try {
        await api.comment(id, text, commentInternal);
        ok++;
      } catch (error) {
        failed.push(`#${id}: ${error instanceof Error ? error.message : "Fehler"}`);
      }
    }
    setBusy(false);
    setCommentOpen(false);
    setCommentText("");
    setSelected([]);
    const label = commentInternal ? "Interne Notiz" : "Kommentar";
    onToast(
      failed.length
        ? `${label}: in ${ok} Tickets gespeichert, ${failed.length} abgelehnt — ${failed[0]}`
        : `${label} in ${ok} Ticket${ok === 1 ? "" : "s"} gespeichert`,
    );
    onChanged();
  }

  useEffect(() => {
    if (!active) return;
    function onKey(event: KeyboardEvent) {
      const tag = (event.target as HTMLElement | null)?.tagName?.toLowerCase() ?? "";
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (saveName !== null || openFilter || commentOpen || statusPick || assignPick || duePick) {
        if (event.key === "Escape") {
          setSaveName(null);
          setOpenFilter(null);
          setCommentOpen(false);
          setStatusPick(false);
          setAssignPick(false);
          setDuePick(false);
        }
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "j" || key === "k") {
        event.preventDefault();
        setFocus((f) => Math.max(0, Math.min(visible.length - 1, f + (key === "j" ? 1 : -1))));
      } else if (key === "x" && visible[focus]) {
        event.preventDefault();
        pick(visible[focus].id, event.shiftKey);
      } else if (event.key === "Enter" && visible[focus]) {
        event.preventDefault();
        onOpen(visible[focus].id);
      } else if (key === "a" && event.shiftKey) {
        event.preventDefault();
        openAssignPick();
      } else if (key === "a") {
        event.preventDefault();
        void assignToMe();
      } else if (key === "s") {
        event.preventDefault();
        setStatusPick(true);
      } else if (key === "f") {
        event.preventDefault();
        setDueDay(todayYmd());
        setDuePick(true);
      } else if (key === "c" && targets.length) {
        event.preventDefault();
        setCommentOpen(true);
      } else if (event.key === "Escape" && selected.length) {
        clearSelection();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, visible, focus, selected.length, anchor, employeeId, saveName, openFilter, commentOpen, statusPick, assignPick, duePick]);

  const assignNeedle = assignSearch.trim().toLowerCase();
  const assignHits = (props.meta?.technicians ?? []).filter((t) => t.name.toLowerCase().includes(assignNeedle));

  const allSelected = visible.length > 0 && visible.every((row) => selected.includes(row.id));
  const shown = COLUMNS.filter((c) => c.id === "title" || columns.includes(c.id));
  const gridTemplate = `44px ${shown.map((c) => c.width).join(" ")}`;
  const gridMinWidth = 44 + shown.reduce((sum, c) => sum + c.min, 0);
  const firstRank = Math.min(...(props.meta?.states ?? []).map((s) => s.rank));
  const statusTone = (row: TicketRow): "warn" | "flat" | "ink" => {
    if (row.waiting) return "warn";
    const state = props.meta?.states.find((s) => s.id === row.statusId);
    return state && state.rank === firstRank ? "flat" : "ink";
  };
  const me = { id: employeeId, name: employeeName };
  const listCount = (id: ListId) => applyFilters(rowsForList(rows, id), presetFilters(id, rows, me)).length;

  function cell(row: TicketRow, column: ColumnId, tone: string) {
    const due = row.deadlineDate || row.dueDate;
    switch (column) {
      case "source":
        return <span className="small muted">TANSS</span>;
      case "id":
        return <span className="muted num-cell">#{row.id}</span>;
      case "title":
        return (
          <span className="tk-title">
            <span className="text">{row.title}</span>
            {row.isProject ? <span className="chip">Projekt</span> : null}
            {due ? (
              <span className={`chip mono${tone === "overdue" ? " danger" : ""}`} title={row.deadlineDate ? "Deadline" : "Fällig"}>
                {tone === "overdue" ? <Dot tone="danger" size={6} /> : null}
                {row.deadlineDate ? "Deadline " : "fällig "}
                {fullDate(due).slice(0, 6)}
              </span>
            ) : null}
          </span>
        );
      case "customer":
        return (
          <span className="muted ellipsis tk-pad">
            {row.companyName || "—"}
            {row.projectName ? <span className="tiny"> · {row.projectName}</span> : null}
          </span>
        );
      case "status":
        return (
          <span className="tk-status">
            <Dot tone={statusTone(row)} />
            <span className="ellipsis">{row.statusName || "—"}</span>
          </span>
        );
      case "type":
        return <span className="muted ellipsis tk-pad">{row.typeName || "—"}</span>;
      case "assignee":
        return row.assigneeId ? (
          <span className="ellipsis tk-pad">{row.assigneeName || `#${row.assigneeId}`}</span>
        ) : (
          <span>
            <span className="assignee-suggest" title="Kein Mitarbeiter zugewiesen">offen</span>
          </span>
        );
      case "department":
        return <span className="muted ellipsis tk-pad">{row.departmentName || "—"}</span>;
      case "age":
        return (
          <span className="num muted" title={row.creationDate ? `Angelegt ${dayAndClock(row.creationDate)}` : ""}>
            {formatElapsed(row.creationDate, now)}
          </span>
        );
      case "idle": {
        const idle = idleOf(row);
        if (!idle) {
          return (
            <span className="num muted" title={activityPending.has(row.id) ? "Verlauf wird geladen" : ""}>
              {activityError && !activityPending.has(row.id) ? "—" : "…"}
            </span>
          );
        }
        const a = activityMap[row.id] ?? NONE;
        const idleTone = idle.days >= 30 ? " dead" : idle.days >= 7 ? " stale" : "";
        const title = a.at
          ? `Letzte Spur: ${activityLabel(a.kind)} am ${dayAndClock(a.at)}`
          : a.historyRead
            ? "Keine Kommentare oder Leistungen seit Anlage"
            : `Verlauf nicht lesbar; keine Leistung in den letzten ${ACTIVITY_LOOKBACK} Tagen`;
        return (
          <span className={`num${idleTone}`} title={title}>
            {idle.atLeast ? `> ${idle.days} d` : formatElapsed(idle.at, now)}
          </span>
        );
      }
      case "updated":
        return <span className="num muted updated">{formatUpdated(row.modified, now)}</span>;
    }
  }

  function head(column: ColumnDef) {
    if (column.id === "age" || column.id === "idle") {
      const key = column.id;
      return (
        <span
          key={key}
          className={`num sortable${sort === key ? " on" : ""}`}
          title={key === "age" ? "Tage seit Anlage · klicken zum Sortieren" : "Tage seit letztem Kommentar oder letzter Leistung · klicken zum Sortieren"}
          onClick={() => setSort(sort === key ? "modified" : key)}
        >
          {column.label}
          {sort === key ? " ↓" : ""}
        </span>
      );
    }
    return (
      <span key={column.id} className={column.id === "updated" ? "num" : undefined}>
        {column.label}
      </span>
    );
  }

  const listLabel = currentView?.name ?? LISTS.find((l) => l.id === list)?.label ?? list;
  const subtitle = loading ? "lädt …" : `${visible.length} Einträge · ${listLabel}`;

  return (
    <div className="tk-page">
      <div className="tk-top">
        <PageHeader title="Tickets" subtitle={subtitle} />

        <div className="tk-controls">
          <div className="seg" role="tablist" aria-label="Listen">
            {LISTS.map((item) => {
              const on = list === item.id && !activeView;
              return (
                <button key={item.id} role="tab" aria-selected={on} className={`seg-item${on ? " active" : ""}`} onClick={() => selectList(item.id)}>
                  {item.label}
                  <span className="count">{on ? visible.length : listCount(item.id)}</span>
                </button>
              );
            })}
            {views.map((view) => {
              const on = activeView === view.id;
              return (
                <button
                  key={view.id}
                  role="tab"
                  aria-selected={on}
                  className={`seg-item tk-saved${on ? " active" : ""}`}
                  onClick={() => selectView(view)}
                  title={`${LISTS.find((l) => l.id === view.list)?.label} · ${FILTER_COLUMNS.filter((c) => view.filters[c.key].length).map((c) => `${c.label}: ${view.filters[c.key].join(", ")}`).join(" · ") || "ohne Filter"}`}
                >
                  {view.name}
                  {on && viewDirty ? (
                    <span className="tk-dirty" title="Filter geändert, noch nicht gespeichert">•</span>
                  ) : null}
                  {on ? <span className="count">{visible.length}</span> : null}
                  <span
                    className="tk-x"
                    role="button"
                    aria-label={`Liste ${view.name} löschen`}
                    title="Liste löschen"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteView(view.id);
                    }}
                  >
                    ×
                  </span>
                </button>
              );
            })}
            {currentView && viewDirty ? null : (
              <button className="seg-item tk-add" onClick={() => setSaveName("")} title="Aktuelle Filter als Liste speichern">
                + Liste
              </button>
            )}
          </div>
          {currentView && viewDirty ? (
            <span className="row" style={{ gap: 6 }}>
              <button className="btn primary small" onClick={() => saveView(currentView.name)} title="Geänderte Filter in diese Liste übernehmen">
                „{currentView.name}" speichern
              </button>
              <button className="btn small" onClick={() => setSaveName("")} title="Als neue Liste speichern">
                als neue Liste
              </button>
            </span>
          ) : null}

          <div className="tk-filters">
            {FILTER_COLUMNS.map((column) => {
              const chosen = filters[column.key];
              const options = columnOptions(rows, column.key);
              return (
                <div key={column.key} className="filter-wrap" data-filter={column.key}>
                  <button
                    className={`filter-chip${chosen.length ? " on" : ""}`}
                    onClick={() => setOpenFilter(openFilter === column.key ? null : column.key)}
                  >
                    <span>{column.label}</span>
                    <span className="value ellipsis" style={{ maxWidth: 180 }}>
                      {chosen.length === 0 ? "alle" : chosen.length === 1 ? chosen[0] : `${chosen.length} gewählt`}
                    </span>
                    <Icon d="m6 9 6 6 6-6" size={12} stroke={2} />
                  </button>
                  {openFilter === column.key ? (
                    <div className="filter-menu tk-menu">
                      {options.length === 0 ? <div className="popover-label">keine Werte</div> : null}
                      {options.map((option) => {
                        const on = chosen.includes(option.value);
                        return (
                          <button
                            key={option.value}
                            className="filter-option"
                            onClick={() => setFilters(toggleValue(filters, column.key, option.value))}
                          >
                            <CheckBox on={on} />
                            <span className="ellipsis">{option.value}</span>
                            <span className="n">{option.count}</span>
                          </button>
                        );
                      })}
                      {chosen.length ? (
                        <button className="filter-option muted" onClick={() => setFilters({ ...filters, [column.key]: [] })}>
                          zurücksetzen
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
            <div className="filter-wrap" data-filter="__columns">
              <button className="filter-chip" onClick={() => setOpenFilter(openFilter === "__columns" ? null : "__columns")} title="Sichtbare Spalten">
                <Icon d="M12 3v18M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" size={16} />
                <span className="value">Spalten</span>
              </button>
              {openFilter === "__columns" ? (
                <div className="popover tk-cols">
                  <span className="popover-label">Sichtbare Spalten</span>
                  {COLUMNS.map((c) => {
                    const on = c.id === "title" || columns.includes(c.id);
                    return (
                      <button
                        key={c.id}
                        className="popover-item"
                        disabled={c.id === "title"}
                        title={c.id === "title" ? "Der Betreff bleibt immer sichtbar" : undefined}
                        onClick={() => toggleColumn(c.id)}
                      >
                        <CheckBox on={on} />
                        <span>{c.label}</span>
                      </button>
                    );
                  })}
                  <button className="popover-item muted" onClick={() => setColumns(DEFAULT_COLUMNS)}>
                    Standard wiederherstellen
                  </button>
                </div>
              ) : null}
            </div>
            {hasFilters(filters) ? (
              <button className="linkish muted" onClick={() => setFilters(EMPTY_FILTERS)}>
                Filter löschen
              </button>
            ) : null}
          </div>
        </div>

        {!loading && rows.length > 0 ? (
          <AgentPanel
            ready={props.agentReady}
            rows={rows}
            visible={visible}
            activity={activityMap}
            listKey={activeView ?? list}
            listLabel={listLabel}
            onOpen={onOpen}
            onError={onError}
          />
        ) : null}

        {coverageNotes.length ? (
          <div className="tk-notes">
            {coverageNotes.map((note) => (
              <span key={note} className="row small muted">
                <Dot tone="warn" />
                {note}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      <div className="tk-grid" style={{ minWidth: gridMinWidth + 64 }}>
        <div className="tk-head" style={{ gridTemplateColumns: gridTemplate }}>
          <span>
            <button
              className="tk-check"
              aria-label="Alle wählen"
              onClick={() => {
                setAnchor(null);
                setSelected(allSelected ? [] : visible.map((r) => r.id));
              }}
            >
              <CheckBox on={allSelected} />
            </button>
          </span>
          {shown.map(head)}
        </div>

        {loading && rows.length === 0 ? <div className="tk-empty">Lädt aus TANSS …</div> : null}
        {!loading && visible.length === 0 ? (
          <div className="tk-empty">
            {props.query
              ? `Keine Tickets für „${props.query}“.`
              : hasFilters(filters) && base.length
                ? "Nichts passt zu den Filtern."
                : "Diese Liste ist in TANSS leer."}
          </div>
        ) : null}

        {visible.map((row, index) => {
          const isSelected = selected.includes(row.id);
          const tone = rowTone(row, now);
          return (
            <div
              key={row.id}
              className={`tk-row ${tone}${index === focus ? " focused" : ""}${isSelected ? " selected" : ""}`}
              style={{ gridTemplateColumns: gridTemplate }}
              onClick={(e) => {
                // With shift the row selects instead of opening; the browser
                // would otherwise paint a text range across the list.
                if (!e.shiftKey) return onOpen(row.id);
                e.preventDefault();
                pick(row.id, true);
              }}
              onMouseEnter={() => setFocus(index)}
            >
              <button
                className="tk-check"
                aria-label="wählen"
                onClick={(e) => {
                  e.stopPropagation();
                  pick(row.id, e.shiftKey);
                }}
              >
                <CheckBox on={isSelected} />
              </button>
              {shown.map((c) => (
                <span key={c.id} className="tk-cell">
                  {cell(row, c.id, tone)}
                </span>
              ))}
            </div>
          );
        })}
        <div className="tk-keys tiny muted">
          j/k Fokus · x wählen (Shift: Bereich) · ⏎ öffnen · a mir zuweisen · ⇧A zuweisen an … · s Status · f Fällig · c Kommentar · Esc Auswahl aufheben
        </div>
      </div>

      {selected.length ? (
        <div className="tk-selbar" role="toolbar" aria-label="Auswahl">
          <span className="count">{selected.length} ausgewählt</span>
          <button className="tk-selbtn" disabled={busy} onClick={assignToMe} title="Mir zuweisen (A)">
            Mir zuweisen
          </button>
          <button className="tk-selbtn" disabled={busy} onClick={openAssignPick} title="Einem Techniker zuweisen (⇧A)">
            Zuweisen an …
          </button>
          <button className="tk-selbtn" disabled={busy} onClick={() => setStatusPick(true)} title="Status ändern (S)">
            Status ändern
          </button>
          <button
            className="tk-selbtn"
            disabled={busy}
            onClick={() => {
              setDueDay(todayYmd());
              setDuePick(true);
            }}
            title="Fälligkeit setzen (F)"
          >
            Fällig
          </button>
          <button className="tk-selbtn" disabled={busy} onClick={() => setCommentOpen(true)} title="Kommentar schreiben (C)">
            Kommentar
          </button>
          <button className="tk-selbtn done" onClick={clearSelection} title="Auswahl aufheben (Esc)">
            Fertig
          </button>
        </div>
      ) : null}

      {saveName !== null ? (
        <div className="palette-backdrop" onClick={() => setSaveName(null)}>
          <form
            className="palette"
            style={{ width: "min(420px, 92vw)" }}
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              saveView(saveName, true);
            }}
          >
            <div className="palette-input">
              <input
                autoFocus
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                placeholder="Name der Liste"
              />
            </div>
            <div style={{ padding: "10px 13px", display: "flex", flexDirection: "column", gap: 8 }}>
              <span className="small muted">
                Basis: {LISTS.find((l) => l.id === list)?.label} ·{" "}
                {hasFilters(filters)
                  ? FILTER_COLUMNS.filter((c) => filters[c.key].length)
                      .map((c) => `${c.label}: ${filters[c.key].join(", ")}`)
                      .join(" · ")
                  : "ohne Spaltenfilter"}
              </span>
              <span className="tiny muted">Gespeichert wird in diesem Browser, je Mitarbeiter.</span>
              <div className="row">
                <button type="button" className="btn ghost" onClick={() => setSaveName(null)}>
                  Abbrechen
                </button>
                <button type="submit" className="btn primary" style={{ marginLeft: "auto" }} disabled={!saveName.trim()}>
                  Speichern
                </button>
              </div>
            </div>
          </form>
        </div>
      ) : null}

      {commentOpen ? (
        <div className="palette-backdrop" onClick={() => (busy ? null : setCommentOpen(false))}>
          <div className="palette" style={{ width: "min(560px, 92vw)" }} onClick={(e) => e.stopPropagation()}>
            <div className="palette-input">
              <span className="small">
                Kommentar in {targets.length} Ticket{targets.length === 1 ? "" : "s"} schreiben
              </span>
              <span className="mono tiny muted ellipsis" style={{ marginLeft: "auto", maxWidth: 260 }}>
                {ids(targets).map((id) => `#${id}`).join(" ")}
              </span>
            </div>
            <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
              <div className="reply-tabs" style={{ padding: 0, borderBottom: 0 }}>
                <button className={`tab${commentInternal ? " active" : ""}`} onClick={() => setCommentInternal(true)}>
                  Interne Notiz
                </button>
                <button className={`tab${!commentInternal ? " active" : ""}`} onClick={() => setCommentInternal(false)}>
                  Kommentar
                </button>
              </div>
              <textarea
                className="textarea"
                rows={5}
                autoFocus
                value={commentText}
                onChange={(e) => setCommentText(e.target.value)}
                placeholder={commentInternal ? "Interne Notiz – nur für Mitarbeiter sichtbar" : "Kommentar – wird in jedem gewählten Ticket gespeichert"}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void commentAll();
                }}
              />
              <div className="row">
                <DraftButton
                  ticketIds={ids(targets)}
                  internal={commentInternal}
                  ready={props.agentReady}
                  hasText={Boolean(commentText.trim())}
                  onDraft={setCommentText}
                  onError={onError}
                />
                <span className="tiny muted">
                  Je Ticket ein POST /tickets/{"{id}"}/comments · ⌘⏎ speichert
                </span>
                <button className="btn ghost" style={{ marginLeft: "auto" }} disabled={busy} onClick={() => setCommentOpen(false)}>
                  Abbrechen
                </button>
                <button className="btn primary" disabled={busy || !commentText.trim()} onClick={() => void commentAll()}>
                  {busy ? "Speichert …" : `In ${ids(targets).length} Tickets speichern`}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {duePick ? (
        <div className="palette-backdrop" onClick={() => setDuePick(false)}>
          <div className="palette" onClick={(e) => e.stopPropagation()} style={{ width: "min(420px, 92vw)" }}>
            <div className="palette-input">
              <span className="small">
                Fälligkeit setzen für {targets.length} Ticket{targets.length === 1 ? "" : "s"}
              </span>
            </div>
            <div className="palette-group">
              <div className="row" style={{ gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
                {/* The quick picks only fill the field — nothing is written until "Setzen". */}
                <button className="btn ghost small" onClick={() => setDueDay(todayYmd())}>
                  Heute
                </button>
                <button className="btn ghost small" onClick={() => setDueDay(shiftYmd(todayYmd(), 1))}>
                  Morgen
                </button>
                <button className="btn ghost small" onClick={() => setDueDay(shiftYmd(todayYmd(), 7))}>
                  +1 Woche
                </button>
              </div>
              <div className="row" style={{ gap: 8, alignItems: "flex-end" }}>
                <div className="field" style={{ flex: 1 }}>
                  <label htmlFor="due-day">Datum</label>
                  <input id="due-day" type="date" className="input" value={dueDay} onChange={(e) => setDueDay(e.target.value)} />
                </div>
                <div className="field" style={{ width: 120 }}>
                  <label htmlFor="due-time">Uhrzeit</label>
                  <input id="due-time" type="time" className="input" value={dueTime} onChange={(e) => setDueTime(e.target.value)} />
                </div>
              </div>
              <div className="row" style={{ gap: 8, marginTop: 12 }}>
                <button className="btn ghost small" disabled={busy} onClick={() => void setDue("", dueTime)}>
                  Fälligkeit entfernen
                </button>
                <button
                  className="btn"
                  style={{ marginLeft: "auto" }}
                  disabled={busy || !dueDay}
                  onClick={() => void setDue(dueDay, dueTime)}
                >
                  Setzen
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {statusPick ? (
        <div className="palette-backdrop" onClick={() => setStatusPick(false)}>
          <div className="palette" onClick={(e) => e.stopPropagation()} style={{ width: "min(420px, 92vw)" }}>
            <div className="palette-input">
              <span className="small">
                Status setzen für {targets.length} Ticket{targets.length === 1 ? "" : "s"}
              </span>
            </div>
            {props.meta?.states.length ? (
              props.meta.states.map((state) => (
                <button key={state.id} className="palette-item" onClick={() => void setStatus(state.id)}>
                  <span>{state.name}</span>
                  {state.waiting ? <span className="hint">wartend</span> : null}
                </button>
              ))
            ) : (
              <div className="palette-group">Statusliste nicht verfügbar (Recht fehlt?)</div>
            )}
          </div>
        </div>
      ) : null}

      {assignPick ? (
        <div className="palette-backdrop" onClick={() => setAssignPick(false)}>
          <div className="palette" onClick={(e) => e.stopPropagation()} style={{ width: "min(420px, 92vw)" }}>
            <div className="palette-input">
              <span className="small">
                Zuweisen: {targets.length} Ticket{targets.length === 1 ? "" : "s"}
              </span>
            </div>
            {props.meta?.technicians.length ? (
              <>
                <div className="palette-input">
                  <input
                    autoFocus
                    value={assignSearch}
                    placeholder="Techniker suchen"
                    onChange={(e) => setAssignSearch(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        e.preventDefault();
                        setAssignPick(false);
                      } else if (e.key === "Enter" && assignHits[0]) {
                        e.preventDefault();
                        void assignTo(assignHits[0]);
                      }
                    }}
                  />
                </div>
                {assignHits.map((technician) => (
                  <button key={technician.id} className="palette-item" onClick={() => void assignTo(technician)}>
                    <span>{technician.name}</span>
                  </button>
                ))}
              </>
            ) : (
              <div className="palette-group">Technikerliste nicht verfügbar (Recht fehlt?)</div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
