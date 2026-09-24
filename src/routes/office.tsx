import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { createClient } from "@supabase/supabase-js";

export const Route = createFileRoute("/office")({
  component: OfficePage,
});

// office_board isn't in the generated Supabase types (added after the last
// type-gen pass) -- a standalone client keeps this page decoupled from that
// regeneration rather than casting the shared typed client to `any`.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey =
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;
const officeClient = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

type RoomKey = "exec_suite" | "ops_tech" | "open_workspace" | "conference" | "breakroom" | "lobby";

interface BoardRow {
  id: string;
  role: string;
  status: string;
  description: string | null;
  model: string | null;
  model_routed_by: string | null;
  pipeline_name: string | null;
  pipeline_stage: number | null;
  pipeline_total: number | null;
  is_placeholder: boolean;
  started_at: string | null;
  updated_at: string;
  // Room simulation (see supabase/migrations/20260924210000_office_board_rooms.sql).
  // home_room is static per role; room only differs from it during a 5s
  // coffee break (breakroom) or a shared-pipeline meeting (conference).
  home_room: RoomKey | null;
  room: RoomKey | null;
  on_break_until: string | null;
}

const ROLE_ORDER = [
  "boss",
  "coder",
  "reviewer",
  "tester",
  "architect",
  "devops",
  "data-engineer",
  "product-manager",
  "ux-designer",
  "clinical-informaticist",
  "security-auditor",
  "analyst",
  "researcher",
];

const ROLE_LABEL: Record<string, string> = {
  boss: "boss",
  coder: "coder",
  reviewer: "reviewer",
  tester: "tester",
  architect: "architect",
  devops: "devops",
  "data-engineer": "data-engineer",
  "product-manager": "product-manager",
  "ux-designer": "ux-designer",
  "clinical-informaticist": "clinical-informaticist",
  "security-auditor": "security-auditor",
  analyst: "analyst",
  researcher: "researcher",
};

// Short on-avatar monograms so 13 chips stay legible at ~36px.
const ROLE_INITIALS: Record<string, string> = {
  coder: "Co",
  reviewer: "Rv",
  tester: "Te",
  architect: "Ar",
  devops: "Do",
  "data-engineer": "DE",
  "product-manager": "PM",
  "ux-designer": "UX",
  "clinical-informaticist": "CI",
  "security-auditor": "SA",
  analyst: "An",
  researcher: "Rs",
};

const PALETTE = [
  "#ff7a8f",
  "#3fe6c8",
  "#7aa6ff",
  "#ffdd7a",
  "#c1a3ff",
  "#7ad6f5",
  "#ffb583",
  "#9cf0b4",
  "#ff9ecf",
  "#8fd6ff",
  "#d9e26a",
  "#b98cff",
];
const BOSS_ACCENT = "#ffd700";

const MODEL_META: Record<string, { badge: string; color: string; label: string; tier: string }> = {
  haiku: {
    badge: "H",
    color: "#35e08a",
    label: "Haiku",
    tier: "Low complexity — simple/mechanical",
  },
  sonnet: {
    badge: "S",
    color: "#7aa6ff",
    label: "Sonnet",
    tier: "Medium complexity — default for typical work",
  },
  opus: {
    badge: "O",
    color: "#c1a3ff",
    label: "Opus",
    tier: "High complexity — architecture / high-stakes",
  },
};
const ROUTED_BY_LABEL: Record<string, string> = {
  "task-difficulty": "routed by task complexity",
  default: "standing roster (no task run yet)",
};

// Mirrors the migration's static home_room CASE -- only used as a fallback
// if a row somehow arrives without home_room/room populated.
const HOME_ROOM_BY_ROLE: Record<string, RoomKey> = {
  boss: "exec_suite",
  "security-auditor": "ops_tech",
  devops: "ops_tech",
  coder: "open_workspace",
  "data-engineer": "open_workspace",
  tester: "open_workspace",
  reviewer: "open_workspace",
};

const ROOMS: {
  key: RoomKey;
  label: string;
  sub: string;
  tint: string;
  door: "left" | "right" | null;
}[] = [
  {
    key: "exec_suite",
    label: "Executive Suite",
    sub: "the boss's desk",
    tint: BOSS_ACCENT,
    door: "right",
  },
  { key: "ops_tech", label: "Ops & Tech", sub: "security · devops", tint: "#7ad6f5", door: "left" },
  {
    key: "lobby",
    label: "Lobby",
    sub: "floating roles · connects every room",
    tint: "#9db2ff",
    door: null,
  },
  {
    key: "open_workspace",
    label: "Open Workspace",
    sub: "coder · data-eng · tester · reviewer",
    tint: "#3fe6c8",
    door: "left",
  },
  {
    key: "breakroom",
    label: "Breakroom",
    sub: "5s coffee after every finished task",
    tint: "#ffb583",
    door: "right",
  },
  {
    key: "conference",
    label: "Conference",
    sub: "2+ agents on one pipeline",
    tint: "#c1a3ff",
    door: "left",
  },
];
const ROOM_KEYS = new Set<string>(ROOMS.map((r) => r.key));
const ROOM_LABEL: Record<string, string> = Object.fromEntries(ROOMS.map((r) => [r.key, r.label]));

// The backend's room logic keys off status='working'. The bridge script has
// historically written 'active' for dispatched tasks, so treat both as "at
// work" here rather than letting a live agent render as idle.
function isWorking(r: BoardRow) {
  return r.status === "working" || r.status === "active";
}

function roomOf(r: BoardRow): RoomKey {
  const cand = r.room ?? r.home_room ?? HOME_ROOM_BY_ROLE[r.role] ?? "lobby";
  return (ROOM_KEYS.has(cand) ? cand : "lobby") as RoomKey;
}

function roleRank(role: string) {
  const i = ROLE_ORDER.indexOf(role);
  return i === -1 ? ROLE_ORDER.length : i;
}

function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function elapsed(iso: string | null, now: number): string {
  if (!iso) return "—";
  const s = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  const h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60),
    sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

function pipelineTag(row: BoardRow | undefined | null) {
  if (!row || !row.pipeline_name) return null;
  const stageStr =
    row.pipeline_stage && row.pipeline_total ? ` ${row.pipeline_stage}/${row.pipeline_total}` : "";
  return `🔗 ${row.pipeline_name}${stageStr}`;
}

function CoffeeIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M5 1.5c-.6.8.6 1.4 0 2.3M8 1.5c-.6.8.6 1.4 0 2.3"
        stroke="#e7eaf3"
        strokeWidth="1"
        fill="none"
        strokeLinecap="round"
        opacity=".7"
      />
      <path d="M2.5 6h9v4.2A3.8 3.8 0 0 1 7.7 14H6.3a3.8 3.8 0 0 1-3.8-3.8z" fill="#c98a55" />
      <path
        d="M11.5 7.2h1a1.8 1.8 0 0 1 0 3.6h-1.2"
        stroke="#c98a55"
        strokeWidth="1.3"
        fill="none"
      />
    </svg>
  );
}

interface TickerItem {
  id: string;
  text: string;
}
interface PopPos {
  top: number;
  left: number;
}

const MOVE_MS = 750;
const POP_W = 290;

function OfficePage() {
  const [rows, setRows] = useState<BoardRow[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filterText, setFilterText] = useState("");
  const [ticker, setTicker] = useState<TickerItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [popPos, setPopPos] = useState<PopPos | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const prevState = useRef<Map<string, { working: boolean; room: RoomKey }> | null>(null);
  const tickIdRef = useRef(0);
  const floorRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const avatarEls = useRef(new Map<string, HTMLButtonElement>());
  const lastPos = useRef(new Map<string, { x: number; y: number }>());

  const pushTick = useCallback((text: string) => {
    const id = `t${tickIdRef.current++}`;
    setTicker((cur) => [...cur.slice(-3), { id, text }]);
    setTimeout(() => setTicker((cur) => cur.filter((t) => t.id !== id)), 4000);
  }, []);

  const fetchBoard = useCallback(async () => {
    if (!officeClient) {
      setError("Supabase client not configured for this deploy.");
      return;
    }
    const { data, error: err } = await officeClient
      .from("office_board")
      .select(
        "id, role, status, description, model, model_routed_by, pipeline_name, pipeline_stage, pipeline_total, is_placeholder, started_at, updated_at, home_room, room, on_break_until",
      )
      .order("started_at", { ascending: true });
    if (err) {
      setConnected(false);
      setError(err.message);
      return;
    }
    setConnected(true);
    setError(null);
    const next = (data ?? []) as BoardRow[];

    const nextState = new Map(next.map((r) => [r.id, { working: isWorking(r), room: roomOf(r) }]));
    if (prevState.current) {
      for (const r of next) {
        const label = ROLE_LABEL[r.role] ?? r.role;
        const before = prevState.current.get(r.id);
        const after = nextState.get(r.id)!;
        if (after.working && !before?.working) {
          pushTick(`🟢 ${label} started: ${r.description ?? "(no description)"}`);
        } else if (before?.working && !after.working) {
          pushTick(
            after.room === "breakroom"
              ? `☕ ${label} finished — coffee break`
              : `✅ ${label} finished`,
          );
        }
        if (after.room === "conference" && before && before.room !== "conference") {
          pushTick(`🤝 ${label} joined ${r.pipeline_name ?? "a"} meeting`);
        }
      }
      for (const [id, s] of prevState.current) {
        if (!nextState.has(id) && s.working) pushTick("✅ finished");
      }
    }
    prevState.current = nextState;
    setRows(next);
  }, [pushTick]);

  useEffect(() => {
    fetchBoard();
    const poll = setInterval(fetchBoard, 4000);
    return () => clearInterval(poll);
  }, [fetchBoard]);

  const accentByRole = useMemo(() => {
    const map = new Map<string, string>();
    ROLE_ORDER.forEach((role, i) =>
      map.set(role, role === "boss" ? BOSS_ACCENT : PALETTE[i % PALETTE.length]),
    );
    return map;
  }, []);
  const accentFor = (role: string) => accentByRole.get(role) ?? "#7aa6ff";

  const byRoom = useMemo(() => {
    const m = new Map<RoomKey, BoardRow[]>();
    for (const r of ROOMS) m.set(r.key, []);
    for (const row of rows) m.get(roomOf(row))!.push(row);
    for (const list of m.values())
      list.sort((a, b) => roleRank(a.role) - roleRank(b.role) || a.id.localeCompare(b.id));
    return m;
  }, [rows]);

  const workingEntries = rows.filter(isWorking);
  const selected = selectedId ? (rows.find((r) => r.id === selectedId) ?? null) : null;

  // ---------- FLIP room-change animation ----------
  // Agents re-parent into a different room panel when `room` changes, so a
  // plain CSS transition can't animate it. Instead: remember each avatar's
  // position (relative to the floor plan) after every layout, and when the
  // placement changes, start the avatar at its old spot and transition the
  // transform back to zero.
  const layoutKey = rows
    .map((r) => `${r.id}:${roomOf(r)}:${r.pipeline_name ?? ""}:${isWorking(r) ? 1 : 0}`)
    .join("|");

  const measureAll = useCallback(() => {
    const floor = floorRef.current;
    if (!floor) return new Map<string, { x: number; y: number }>();
    const base = floor.getBoundingClientRect();
    const m = new Map<string, { x: number; y: number }>();
    avatarEls.current.forEach((el, id) => {
      const r = el.getBoundingClientRect();
      m.set(id, { x: r.left - base.left, y: r.top - base.top });
    });
    return m;
  }, []);

  useLayoutEffect(() => {
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    // Clear any in-flight transforms before measuring the new layout.
    avatarEls.current.forEach((el) => {
      el.style.transition = "none";
      el.style.transform = "";
    });
    const next = measureAll();
    if (!reduce) {
      next.forEach((pos, id) => {
        const prev = lastPos.current.get(id);
        const el = avatarEls.current.get(id);
        if (!prev || !el) return;
        const dx = prev.x - pos.x,
          dy = prev.y - pos.y;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
        el.style.transform = `translate(${dx}px, ${dy}px)`;
        el.classList.add("moving");
        void el.offsetWidth; // commit the starting position
        requestAnimationFrame(() => {
          el.style.transition = `transform ${MOVE_MS}ms cubic-bezier(.22,.8,.24,1)`;
          el.style.transform = "";
          window.setTimeout(() => el.classList.remove("moving"), MOVE_MS + 50);
        });
      });
    }
    lastPos.current = next;
  }, [layoutKey, measureAll]);

  useEffect(() => {
    const onResize = () => {
      lastPos.current = measureAll();
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [measureAll]);

  // ---------- Inspect popover ----------
  const placePopover = useCallback(() => {
    if (!selectedId) return;
    const el = avatarEls.current.get(selectedId);
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth,
      vh = window.innerHeight;
    const popH = popRef.current?.offsetHeight ?? 220;
    let left = r.left + r.width / 2 - POP_W / 2;
    left = Math.max(12, Math.min(left, vw - POP_W - 12));
    let top = r.bottom + 10;
    if (top + popH > vh - 12 && r.top - popH - 10 > 12) top = r.top - popH - 10;
    setPopPos({ top, left });
  }, [selectedId]);

  useLayoutEffect(() => {
    if (!selectedId) {
      setPopPos(null);
      return;
    }
    placePopover();
    // Re-place once the transition (if any) has landed.
    const t = window.setTimeout(placePopover, MOVE_MS + 80);
    return () => window.clearTimeout(t);
  }, [selectedId, layoutKey, placePopover]);

  useEffect(() => {
    if (!selectedId) return;
    const closeAndRefocus = () => {
      const trigger = avatarEls.current.get(selectedId);
      setSelectedId(null);
      trigger?.focus();
    };
    const onDown = (e: MouseEvent | TouchEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t)) return;
      if (avatarEls.current.get(selectedId)?.contains(t)) return;
      if ((t as Element).closest?.("[data-agent-trigger]")) return; // another avatar/row: its own onClick switches selection
      setSelectedId(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeAndRefocus();
    };
    const onScroll = () => placePopover();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    setNow(Date.now());
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
      window.clearInterval(tick);
    };
  }, [selectedId, placePopover]);

  // If the selected agent vanishes from the board (bridge row deleted), close.
  useEffect(() => {
    if (selectedId && !rows.some((r) => r.id === selectedId)) setSelectedId(null);
  }, [rows, selectedId]);

  const toggleSelect = (id: string) => setSelectedId((cur) => (cur === id ? null : id));

  const filterLc = filterText.trim().toLowerCase();
  const matchesFilter = (r: BoardRow) =>
    !filterLc || (ROLE_LABEL[r.role] ?? r.role).toLowerCase().includes(filterLc);

  const renderAgent = (r: BoardRow, style?: CSSProperties) => {
    const working = isWorking(r);
    const room = roomOf(r);
    const onBreak = room === "breakroom";
    const accent = accentFor(r.role);
    const m = working && r.model ? MODEL_META[r.model] : undefined;
    const label = ROLE_LABEL[r.role] ?? r.role;
    const isSel = selectedId === r.id;
    const stateText = onBreak ? "on break" : working ? "working" : "idle";
    return (
      <button
        key={r.id}
        type="button"
        data-agent-trigger=""
        ref={(el) => {
          if (el) avatarEls.current.set(r.id, el);
          else avatarEls.current.delete(r.id);
        }}
        className={`agent ${working ? "working" : ""} ${onBreak ? "on-break" : ""} ${isSel ? "selected" : ""} ${matchesFilter(r) ? "" : "dimmed"}`}
        style={{ ["--accent" as string]: accent, ...style }}
        onClick={() => toggleSelect(r.id)}
        aria-haspopup="dialog"
        aria-expanded={isSel}
        aria-label={`${label}, ${stateText}${working && r.description ? `: ${r.description}` : ""}. Show details`}
        title={`${label} · ${stateText}`}
      >
        <span className="agent-av">
          <span className="agent-mono">
            {r.role === "boss" ? "👑" : (ROLE_INITIALS[r.role] ?? r.role.slice(0, 2))}
          </span>
          {working && <span className="presence" aria-hidden="true" />}
          {m && (
            <span className="model-badge" style={{ background: m.color }} aria-hidden="true">
              {m.badge}
            </span>
          )}
          {onBreak && (
            <span className="cup" aria-hidden="true">
              <CoffeeIcon />
            </span>
          )}
        </span>
        <span className="agent-name">{label}</span>
        {onBreak && <span className="agent-state brk">on break</span>}
      </button>
    );
  };

  const renderConference = (list: BoardRow[]) => {
    // Cluster by pipeline: each 2+ group of working agents sits around its
    // own table. Anyone else in here (shouldn't normally happen) renders as a
    // plain occupant so the page never breaks on an odd row.
    const groups = new Map<string, BoardRow[]>();
    const loose: BoardRow[] = [];
    for (const r of list) {
      if (isWorking(r) && r.pipeline_name) {
        const g = groups.get(r.pipeline_name) ?? [];
        g.push(r);
        groups.set(r.pipeline_name, g);
      } else loose.push(r);
    }
    const meetings: [string, BoardRow[]][] = [];
    for (const [name, g] of groups) {
      if (g.length >= 2) meetings.push([name, g]);
      else loose.push(...g);
    }
    return (
      <>
        {meetings.map(([name, g]) => {
          const n = g.length;
          const w = Math.min(300, 170 + n * 14),
            h = Math.min(220, 140 + n * 8);
          const rx = w / 2 - 26,
            ry = h / 2 - 26;
          const sample = g[0];
          const stage = sample.pipeline_total
            ? ` · ${g.length} of ${sample.pipeline_total} stages`
            : "";
          return (
            <div key={name} className="meeting">
              <div className="meeting-label">
                <span className="meeting-dot" />
                meeting · 🔗 {name}
                {stage}
              </div>
              <div className="meeting-floor" style={{ width: w, height: h }}>
                <div className="meeting-table" style={{ width: w - 110, height: h - 100 }} />
                {g.map((r, i) => {
                  const a = (2 * Math.PI * i) / n - Math.PI / 2;
                  return renderAgent(r, {
                    position: "absolute",
                    left: w / 2 + rx * Math.cos(a) - 30,
                    top: h / 2 + ry * Math.sin(a) - 20,
                  });
                })}
              </div>
            </div>
          );
        })}
        {loose.length > 0 && <div className="occupants">{loose.map((r) => renderAgent(r))}</div>}
      </>
    );
  };

  let popBody: ReactNode = null;
  if (selected) {
    const working = isWorking(selected);
    const room = roomOf(selected);
    const m = selected.model ? MODEL_META[selected.model] : undefined;
    const accent = accentFor(selected.role);
    popBody = (
      <>
        <div className="pop-head">
          <div>
            <div className="pop-title" id="agent-pop-title" style={{ color: accent }}>
              {selected.role === "boss" ? "👑 " : ""}
              {(ROLE_LABEL[selected.role] ?? selected.role).toUpperCase()}
            </div>
            <div className="pop-sub">
              <span className={`pop-state ${working ? "on" : ""}`} />
              {room === "breakroom" ? "on a coffee break" : working ? "working" : "idle"} ·{" "}
              {ROOM_LABEL[room]}
              {room !== (selected.home_room ?? room)
                ? ` (home: ${ROOM_LABEL[selected.home_room ?? ""] ?? selected.home_room})`
                : ""}
            </div>
          </div>
          <button
            type="button"
            className="pop-close"
            onClick={() => {
              const t = avatarEls.current.get(selected.id);
              setSelectedId(null);
              t?.focus();
            }}
            aria-label="Close details"
          >
            &times;
          </button>
        </div>
        <div className="pop-task">
          {working ? (
            (selected.description ?? "(no description)")
          ) : (
            <span className="muted">Idle — no active task.</span>
          )}
        </div>
        <dl className="pop-grid">
          {m && (
            <>
              <dt>Model</dt>
              <dd>
                <span
                  className="model-chip"
                  style={{ background: `${m.color}22`, color: m.color }}
                  title={m.tier}
                >
                  <span className="sw" style={{ background: m.color }} />
                  {m.label}
                </span>
                <span className="muted">
                  {" "}
                  · {ROUTED_BY_LABEL[selected.model_routed_by ?? ""] ?? "routing unknown"}
                </span>
              </dd>
            </>
          )}
          {selected.pipeline_name && (
            <>
              <dt>Pipeline</dt>
              <dd>
                <span className="pipeline-tag" style={{ marginTop: 0 }}>
                  🔗 {selected.pipeline_name}
                </span>
                {selected.pipeline_stage != null && (
                  <span className="muted">
                    {" "}
                    stage {selected.pipeline_stage}
                    {selected.pipeline_total ? `/${selected.pipeline_total}` : ""}
                  </span>
                )}
              </dd>
            </>
          )}
          {working && (
            <>
              <dt>Elapsed</dt>
              <dd className="mono">{elapsed(selected.started_at, now)}</dd>
            </>
          )}
          {room === "breakroom" && selected.on_break_until && (
            <>
              <dt>Break</dt>
              <dd className="mono">
                {new Date(selected.on_break_until).getTime() > now
                  ? `${Math.ceil((new Date(selected.on_break_until).getTime() - now) / 1000)}s left`
                  : "heading back"}
              </dd>
            </>
          )}
          <dt>Row</dt>
          <dd className="mono muted">{selected.id}</dd>
        </dl>
      </>
    );
  }

  return (
    <>
      <style>{`
        .office-root { color-scheme: dark; }
        .office-root * { box-sizing: border-box; }
        .office-root {
          margin: 0; min-height: 100vh; position: relative;
          background: radial-gradient(ellipse 90% 70% at 50% 38%, #1a2540 0%, #0a0c14 62%, #060709 100%);
          color: #e7eaf3; font: 13px/1.4 -apple-system, "Segoe UI", Roboto, sans-serif;
        }
        @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }

        /* ================= MASTHEAD ================= */
        header.office-header { position: sticky; top: 0; z-index: 30; display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 14px 22px; background: rgba(6,7,10,.78); backdrop-filter: blur(10px); border-bottom: 1px solid rgba(255,255,255,.06); }
        .brand { font-weight: 800; letter-spacing: .12em; font-size: 13px; color: #cfd6ea; white-space: nowrap; }
        .brand span { color: #6d7690; font-weight: 600; }
        .brand .live { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #35e08a; margin-right: 8px; box-shadow: 0 0 8px #35e08a; animation: pulse 1.6s infinite; vertical-align: 1px; }
        .swarm-count { font-size: 11px; color: #9aa2ba; margin-left: 12px; letter-spacing: .02em; font-weight: 600; }
        .swarm-count b { color: #35e08a; }
        .conn-row { display: flex; gap: 6px; align-items: center; }
        .conn-chip { display: flex; align-items: center; gap: 6px; background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.08); padding: 5px 10px; border-radius: 999px; font-size: 11px; color: #9aa2ba; }
        .conn-chip .dot { width: 6px; height: 6px; border-radius: 50%; background: #4a5170; }
        .conn-chip.on .dot { background: #35e08a; box-shadow: 0 0 6px #35e08a; }
        .conn-chip.off .dot { background: #e0435c; }
        .search-box { background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.1); border-radius: 999px; padding: 5px 12px; font: inherit; font-size: 11.5px; color: #e7eaf3; width: 140px; transition: width .2s ease, background .2s ease; }
        .search-box::placeholder { color: #6d7690; }
        .search-box:focus { outline: none; width: 180px; background: rgba(255,255,255,.08); border-color: rgba(140,160,255,.4); }
        .legend-bar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; justify-content: center; margin: 14px auto 0; width: fit-content; max-width: calc(100% - 32px); background: rgba(16,19,30,.85); border: 1px solid rgba(255,255,255,.08); border-radius: 999px; padding: 6px 14px; font-size: 10.5px; color: #9aa2ba; }
        .legend-bar .sep { color: #565e78; }
        .legend-key { display: inline-flex; align-items: center; gap: 5px; }
        .legend-key .pd { width: 7px; height: 7px; border-radius: 50%; background: #35e08a; box-shadow: 0 0 6px #35e08a; }
        .model-chip { display: inline-flex; align-items: center; gap: 4px; font-size: 10px; font-weight: 700; padding: 1px 6px 1px 4px; border-radius: 999px; }
        .model-chip .sw { width: 8px; height: 8px; border-radius: 3px; display: inline-block; }
        .pipeline-tag { display: inline-flex; align-items: center; gap: 3px; font-size: 9px; font-weight: 700; color: #ffdd7a; background: rgba(255,221,122,.12); border: 1px solid rgba(255,221,122,.25); border-radius: 999px; padding: 1px 7px; margin-top: 3px; width: fit-content; }

        /* ================= PAGE LAYOUT ================= */
        .office-body { display: grid; grid-template-columns: 260px minmax(0, 1fr); gap: 18px; padding: 16px 22px 90px; max-width: 1440px; margin: 0 auto; align-items: start; }
        @media (max-width: 1100px) { .office-body { grid-template-columns: minmax(0, 1fr); } .work-panel { order: 2; position: static !important; max-height: none !important; } }
        @media (max-width: 600px) { .office-body { padding: 12px 12px 90px; } header.office-header { padding: 12px 14px; } .swarm-count { display: block; margin: 4px 0 0; } }

        /* Who's working on what */
        .work-panel { position: sticky; top: 72px; max-height: calc(100vh - 96px); display: flex; flex-direction: column; background: rgba(11,13,20,.9); border: 1px solid rgba(255,255,255,.08); border-radius: 12px; box-shadow: 0 14px 30px -12px rgba(0,0,0,.6); }
        .work-panel-head { display: flex; align-items: center; justify-content: space-between; padding: 9px 12px; border-bottom: 1px solid rgba(255,255,255,.07); flex-shrink: 0; }
        .work-panel-head .t { font-size: 10px; font-weight: 800; letter-spacing: .08em; color: #9aa2ba; }
        .work-panel-head .n { font-size: 10px; font-weight: 800; color: #35e08a; background: rgba(53,224,138,.12); padding: 1px 7px; border-radius: 999px; }
        .work-panel-body { overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 6px; }
        .work-row { display: flex; flex-direction: column; gap: 2px; background: rgba(255,255,255,.035); border: 1px solid rgba(255,255,255,.06); border-left: 3px solid var(--accent, #7aa6ff); border-radius: 7px; padding: 6px 9px; cursor: pointer; transition: background .15s ease; text-align: left; color: inherit; font: inherit; width: 100%; }
        .work-row:hover { background: rgba(255,255,255,.07); }
        .work-row:focus-visible { outline: 2px solid rgba(140,160,255,.6); outline-offset: 1px; }
        .work-row .role { font-size: 9.5px; font-weight: 800; letter-spacing: .04em; text-transform: uppercase; color: var(--accent, #7aa6ff); }
        .work-row .desc { font-size: 11px; color: #cfd6ea; line-height: 1.3; margin-top: 1px; }
        .work-row .meta { font-size: 9.5px; color: #565e78; margin-top: 2px; }
        .work-empty { color: #565e78; font-size: 11px; text-align: center; padding: 14px 8px; }

        /* ================= FLOOR PLAN ================= */
        .floorplan { position: relative; display: grid; gap: 10px; padding: 12px; border-radius: 18px;
          grid-template-columns: minmax(0, 1fr) minmax(0, .9fr) minmax(0, 1.25fr);
          grid-template-rows: minmax(150px, auto) minmax(110px, auto) minmax(110px, auto) minmax(170px, auto);
          grid-template-areas:
            "exec_suite lobby ops_tech"
            "exec_suite lobby open_workspace"
            "breakroom  lobby open_workspace"
            "breakroom  lobby conference";
          background: #0b0e17; border: 2px solid rgba(157,178,255,.16);
          box-shadow: 0 30px 60px -30px rgba(0,0,0,.8), inset 0 0 0 1px rgba(0,0,0,.4);
          background-image: linear-gradient(rgba(255,255,255,.022) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.022) 1px, transparent 1px);
          background-size: 23px 23px;
        }
        @media (max-width: 900px) {
          .floorplan { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); grid-template-rows: none;
            grid-template-areas: "exec_suite ops_tech" "lobby lobby" "open_workspace open_workspace" "breakroom conference"; }
          .door { display: none; }
        }
        @media (max-width: 560px) {
          .floorplan { grid-template-columns: minmax(0, 1fr); padding: 8px; gap: 8px;
            grid-template-areas: "exec_suite" "ops_tech" "lobby" "open_workspace" "conference" "breakroom"; }
        }
        .room { position: relative; min-width: 0; display: flex; flex-direction: column; border-radius: 12px; padding: 10px 12px 12px;
          background: linear-gradient(180deg, rgba(255,255,255,.045), rgba(255,255,255,.012)), #12151f;
          border: 1px solid rgba(255,255,255,.09); box-shadow: 0 18px 34px -20px rgba(0,0,0,.7); }
        .room::before { content: ''; position: absolute; top: 0; left: 12px; right: 12px; height: 3px; background: var(--tint); border-radius: 0 0 3px 3px; opacity: .75; }
        .room.lobby { background: radial-gradient(ellipse 80% 60% at 50% 50%, rgba(120,150,255,.09), transparent 70%), rgba(18,21,31,.72); border-style: dashed; border-color: rgba(157,178,255,.2); }
        .room-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 8px; padding-top: 2px; }
        .room-name { font-size: 10px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; color: var(--tint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .room-sub { display: block; font-size: 9.5px; color: #565e78; font-weight: 600; letter-spacing: .01em; text-transform: none; margin-top: 1px; white-space: normal; }
        .room-count { font-size: 10.5px; font-weight: 700; color: #9aa2ba; flex-shrink: 0; }
        .room-count .w { color: #35e08a; }
        .room-empty { font-size: 10.5px; color: #3f465e; text-align: center; margin: auto 0; padding: 10px 0; font-style: italic; }
        .occupants { display: flex; flex-wrap: wrap; gap: 10px 6px; align-content: flex-start; justify-content: center; }
        .room.lobby .occupants { flex: 1; align-content: center; }
        .door { position: absolute; top: 50%; width: 5px; height: 38px; transform: translateY(-50%); background: #0b0e17; border-radius: 2px; }
        .door::after { content: ''; position: absolute; inset: 6px 1.5px; border-radius: 2px; background: var(--tint); opacity: .45; }
        .door.left { left: -3px; } .door.right { right: -3px; }
        .room-deco { position: absolute; right: 10px; bottom: 8px; opacity: .14; pointer-events: none; font-size: 26px; line-height: 1; filter: grayscale(.3); }

        /* ================= AGENTS ================= */
        .agent { position: relative; width: 64px; display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 4px 2px 3px; background: none; border: none; border-radius: 10px; color: inherit; font: inherit; cursor: pointer; transition: opacity .3s ease, background .15s ease; }
        .agent:hover { background: rgba(255,255,255,.05); }
        .agent:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
        .agent.moving { z-index: 15; }
        .agent.dimmed { opacity: .22; }
        .agent-av { position: relative; width: 34px; height: 34px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
          background: radial-gradient(circle at 35% 30%, color-mix(in srgb, var(--accent) 38%, #12151f), #151925 78%);
          border: 1.5px solid color-mix(in srgb, var(--accent) 55%, transparent);
          box-shadow: 0 6px 12px -6px rgba(0,0,0,.8); transition: transform .18s ease, border-color .2s ease, box-shadow .3s ease; }
        .agent:hover .agent-av { transform: translateY(-1px) scale(1.06); }
        .agent.working .agent-av { border-color: var(--accent); box-shadow: 0 0 14px -3px var(--accent), 0 6px 12px -6px rgba(0,0,0,.8); }
        .agent.selected .agent-av { box-shadow: 0 0 0 3px rgba(255,255,255,.14), 0 0 16px -2px var(--accent); }
        .agent-mono { font-size: 11px; font-weight: 800; letter-spacing: .02em; color: var(--accent); line-height: 1; }
        .agent-name { max-width: 62px; font-size: 9px; font-weight: 600; color: #9aa2ba; line-height: 1.15; text-align: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .agent.working .agent-name { color: #cfd6ea; }
        .agent-state.brk { font-size: 8.5px; font-weight: 700; color: #ffb583; background: rgba(255,181,131,.12); border: 1px solid rgba(255,181,131,.25); border-radius: 999px; padding: 0 5px; line-height: 13px; }
        .presence { position: absolute; right: -2px; bottom: -1px; width: 10px; height: 10px; border-radius: 50%; background: #35e08a; border: 2px solid #12151f; }
        .presence::after { content: ''; position: absolute; inset: -3px; border-radius: 50%; border: 1.5px solid #35e08a; animation: presence 1.8s ease-out infinite; }
        @keyframes presence { 0% { transform: scale(.6); opacity: .8; } 80%,100% { transform: scale(1.7); opacity: 0; } }
        .model-badge { position: absolute; top: -4px; left: -4px; width: 13px; height: 13px; border-radius: 4px; font-size: 8px; font-weight: 800; line-height: 11px; text-align: center; color: #0a0c14; border: 1px solid rgba(0,0,0,.35); box-shadow: 0 1px 3px rgba(0,0,0,.5); }
        .cup { position: absolute; top: -6px; right: -8px; width: 18px; height: 18px; border-radius: 50%; display: flex; align-items: center; justify-content: center; background: #1b1f2c; border: 1px solid rgba(255,181,131,.35); animation: sip 2.4s ease-in-out infinite; }
        @keyframes sip { 0%,100% { transform: rotate(0); } 50% { transform: rotate(-10deg) translateY(-1px); } }

        /* Conference meetings */
        .meeting { display: flex; flex-direction: column; align-items: center; margin: 0 auto 8px; }
        .meeting-label { font-size: 9.5px; font-weight: 700; color: #c1a3ff; letter-spacing: .03em; margin-bottom: 2px; display: flex; align-items: center; gap: 5px; text-align: center; }
        .meeting-dot { width: 6px; height: 6px; border-radius: 50%; background: #c1a3ff; animation: pulse 1.6s infinite; flex-shrink: 0; }
        .meeting-floor { position: relative; max-width: 100%; }
        .meeting-table { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); border-radius: 50%; background: radial-gradient(ellipse at 40% 35%, rgba(193,163,255,.2), rgba(193,163,255,.05) 70%); border: 1px solid rgba(193,163,255,.35); box-shadow: inset 0 0 18px rgba(0,0,0,.4); }

        /* ================= INSPECT POPOVER ================= */
        .agent-pop { position: fixed; z-index: 70; width: ${POP_W}px; background: rgba(13,15,22,.98); border: 1px solid rgba(255,255,255,.12); border-radius: 12px; box-shadow: 0 20px 44px -14px rgba(0,0,0,.8); padding: 12px 14px 12px; animation: popIn .16s ease; }
        @keyframes popIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
        @media (max-width: 560px) { .agent-pop { left: 12px !important; right: 12px; top: auto !important; bottom: 12px; width: auto; } }
        .pop-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
        .pop-title { font-weight: 800; font-size: 12.5px; letter-spacing: .05em; }
        .pop-sub { font-size: 10.5px; color: #6d7690; margin-top: 2px; display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
        .pop-state { width: 7px; height: 7px; border-radius: 50%; background: #4a5170; flex-shrink: 0; }
        .pop-state.on { background: #35e08a; box-shadow: 0 0 6px #35e08a; }
        .pop-close { background: rgba(255,255,255,.06); border: none; color: #9aa2ba; font-size: 16px; width: 26px; height: 26px; border-radius: 999px; cursor: pointer; flex-shrink: 0; line-height: 1; }
        .pop-close:hover { color: #e7eaf3; background: rgba(255,255,255,.1); }
        .pop-close:focus-visible { outline: 2px solid rgba(140,160,255,.6); }
        .pop-task { margin-top: 10px; font-size: 12px; color: #cfd6ea; line-height: 1.4; background: rgba(255,255,255,.035); border: 1px solid rgba(255,255,255,.07); border-radius: 8px; padding: 8px 10px; word-break: break-word; }
        .pop-grid { display: grid; grid-template-columns: auto 1fr; gap: 6px 10px; margin: 10px 0 0; font-size: 11px; align-items: center; }
        .pop-grid dt { color: #565e78; font-size: 9.5px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; }
        .pop-grid dd { margin: 0; color: #cfd6ea; min-width: 0; overflow-wrap: anywhere; }
        .muted { color: #6d7690; }
        .mono { font-family: ui-monospace, monospace; font-size: 10.5px; }

        .office-footer-note { text-align: center; font-size: 10.5px; color: #565e78; margin-top: 16px; line-height: 1.5; }
        .ticker { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%); display: flex; flex-direction: column-reverse; gap: 6px; z-index: 25; pointer-events: none; align-items: center; width: min(560px, 90vw); }
        .ticker-item { background: rgba(14,17,28,.92); border: 1px solid rgba(255,255,255,.1); border-radius: 999px; padding: 6px 14px; font-size: 11.5px; color: #cfd6ea; backdrop-filter: blur(8px); animation: tickerIn .35s ease; box-shadow: 0 8px 20px -8px rgba(0,0,0,.6); white-space: nowrap; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
        @keyframes tickerIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        @media (max-width: 700px) { .ticker { bottom: 12px; width: calc(100vw - 24px); } .ticker-item { white-space: normal; text-align: center; } }
        @media (prefers-reduced-motion: reduce) {
          .presence::after, .cup, .meeting-dot, .brand .live { animation: none; }
        }
      `}</style>

      <div className="office-root">
        <header className="office-header">
          <div>
            <span className="brand">
              <span className="live" />
              RUFLO <span>OFFICE</span>
            </span>
            <span className="swarm-count">
              SWARM · <b>{workingEntries.length}</b> working · {rows.length || ROLE_ORDER.length}{" "}
              agents
            </span>
          </div>
          <div className="conn-row">
            <span className={`conn-chip ${connected ? "on" : "off"}`}>
              <span className="dot" />
              supabase
            </span>
            <input
              className="search-box"
              placeholder="Filter role…"
              aria-label="Filter agents by role"
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
            />
          </div>
        </header>

        <div className="legend-bar">
          Model tier:
          {Object.entries(MODEL_META).map(([key, m]) => (
            <span
              key={key}
              className="model-chip"
              style={{ background: `${m.color}22`, color: m.color }}
            >
              <span className="sw" style={{ background: m.color }} />
              {m.badge}={m.label}
            </span>
          ))}
          <span className="sep">·</span>
          <span className="legend-key">
            <span className="pd" />
            working
          </span>
          <span className="legend-key">
            <CoffeeIcon />
            on break
          </span>
          <span className="sep">— click any agent to inspect</span>
        </div>

        <div className="office-body">
          <aside className="work-panel" aria-label="Who's working on what">
            <div className="work-panel-head">
              <span className="t">WHO'S WORKING ON WHAT</span>
              <span className="n">{workingEntries.length}</span>
            </div>
            <div className="work-panel-body">
              {workingEntries.length === 0 ? (
                <div className="work-empty">Nobody is working right now.</div>
              ) : (
                [...workingEntries]
                  .sort((a, b) =>
                    a.role === "boss"
                      ? -1
                      : b.role === "boss"
                        ? 1
                        : roleRank(a.role) - roleRank(b.role),
                  )
                  .map((r) => {
                    const roleLabel =
                      r.role === "boss" ? "👑 boss" : (ROLE_LABEL[r.role] ?? r.role);
                    const tag = pipelineTag(r);
                    const room = roomOf(r);
                    return (
                      <button
                        key={r.id}
                        type="button"
                        data-agent-trigger=""
                        className="work-row"
                        style={{ ["--accent" as string]: accentFor(r.role) }}
                        onClick={() => toggleSelect(r.id)}
                      >
                        <span className="role">{roleLabel}</span>
                        <span className="desc">{r.description ?? "(no description)"}</span>
                        {tag && <span className="pipeline-tag">{tag}</span>}
                        <span className="meta">
                          {timeAgo(r.started_at)} · {ROOM_LABEL[room]}
                        </span>
                      </button>
                    );
                  })
              )}
            </div>
          </aside>

          <main>
            <div className="floorplan" ref={floorRef} aria-label="Office floor plan">
              {ROOMS.map((room) => {
                const list = byRoom.get(room.key) ?? [];
                const w = list.filter(isWorking).length;
                return (
                  <section
                    key={room.key}
                    className={`room ${room.key === "lobby" ? "lobby" : ""}`}
                    style={{ gridArea: room.key, ["--tint" as string]: room.tint }}
                    aria-label={`${room.label}: ${list.length} ${list.length === 1 ? "agent" : "agents"}`}
                  >
                    {room.door && <span className={`door ${room.door}`} aria-hidden="true" />}
                    <div className="room-head">
                      <span className="room-name">
                        {room.label}
                        <span className="room-sub">{room.sub}</span>
                      </span>
                      <span className="room-count">
                        {list.length}
                        {w > 0 && <span className="w"> · {w} busy</span>}
                      </span>
                    </div>
                    {list.length === 0 ? (
                      <div className="room-empty">
                        {room.key === "conference"
                          ? "no meetings right now"
                          : room.key === "breakroom"
                            ? "nobody on break"
                            : "empty"}
                      </div>
                    ) : room.key === "conference" ? (
                      renderConference(list)
                    ) : (
                      <div className="occupants">{list.map((r) => renderAgent(r))}</div>
                    )}
                    <span className="room-deco" aria-hidden="true">
                      {room.key === "exec_suite"
                        ? "🗄️"
                        : room.key === "ops_tech"
                          ? "🖥️"
                          : room.key === "open_workspace"
                            ? "💻"
                            : room.key === "conference"
                              ? "📋"
                              : room.key === "breakroom"
                                ? "☕"
                                : "🪴"}
                    </span>
                  </section>
                );
              })}
            </div>
            <div className="office-footer-note">
              Monitoring only — nothing here can spawn or control an agent. State lives in Supabase,
              not on any one machine.
            </div>
          </main>
        </div>

        {selected && (
          <div
            ref={popRef}
            className="agent-pop"
            role="dialog"
            aria-labelledby="agent-pop-title"
            style={{ top: popPos?.top ?? -9999, left: popPos?.left ?? -9999 }}
          >
            {popBody}
          </div>
        )}

        <div className="ticker" aria-live="polite">
          {ticker.map((t) => (
            <div key={t.id} className="ticker-item">
              {t.text}
            </div>
          ))}
        </div>

        {error && (
          <div
            style={{
              position: "fixed",
              bottom: 16,
              right: 16,
              left: 16,
              maxWidth: 320,
              marginInline: "auto",
              background: "rgba(224,67,92,.15)",
              border: "1px solid rgba(224,67,92,.4)",
              color: "#ff9fae",
              padding: "8px 14px",
              borderRadius: 10,
              fontSize: 11.5,
              zIndex: 30,
            }}
          >
            {error}
          </div>
        )}
      </div>
    </>
  );
}
