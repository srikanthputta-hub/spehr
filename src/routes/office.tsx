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

// `office_board.model` holds a full model id (e.g. "claude-sonnet-5",
// "claude-opus-5-5", "claude-haiku-4-5-20251001") -- not the short tier key
// MODEL_META is keyed by, so that lookup misses for real rows and the H/S/O
// badge above never lights up in practice. This just trims the id down to
// something that fits on a desk: drop the "claude-" prefix and any trailing
// date-stamp suffix.
function shortModelLabel(model: string): string {
  return model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

// Split a shortModelLabel() result (e.g. "opus-5-5", "sonnet-5") into a tier
// letter and a version string for the on-desk neon readout below.
function modelTierLetter(short: string): string | null {
  const m = short.match(/^(haiku|sonnet|opus)/i);
  return m ? m[1][0].toUpperCase() : null;
}
function modelVersion(short: string): string {
  const m = short.match(/^(?:haiku|sonnet|opus)-(.+)$/i);
  return m ? m[1].replace(/-/g, ".") : "";
}
// office_board has no reasoning-effort column (nothing in this repo's Office
// tooling -- the bridge script, migrations, or CLAUDE.md -- tracks it), so
// this is a proxy DERIVED FROM MODEL TIER, not real per-task effort data.
// It disappears the moment a genuine effort column/value exists to replace it.
function modelEffortProxy(short: string): string | null {
  if (/^haiku/i.test(short)) return "LOW";
  if (/^sonnet/i.test(short)) return "STD";
  if (/^opus/i.test(short)) return "HIGH";
  return null;
}

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
const ROOM_KEYS = new Set<string>([
  "exec_suite",
  "ops_tech",
  "open_workspace",
  "conference",
  "breakroom",
  "lobby",
]);

// The single command-center room has no visual "rooms" any more; `room` is
// only read for its two transient values: "breakroom" (5s stepped-away
// state after a task finishes) and "conference" (2+ working agents sharing
// a pipeline -> their desks get linked).

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

type DeskMode = "working" | "idle" | "break";
function modeOf(r: BoardRow | undefined): DeskMode {
  if (!r) return "idle";
  if (roomOf(r) === "breakroom") return "break";
  return isWorking(r) ? "working" : "idle";
}

function useReducedMotion() {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!mq) return;
    const update = () => setReduce(mq.matches);
    update();
    mq.addEventListener?.("change", update);
    return () => mq.removeEventListener?.("change", update);
  }, []);
  return reduce;
}

// ---------------------------------------------------------------------------
// Scene geometry. Everything on the stage (desktop AND mobile -- both render
// the same scene via renderStage() below) lives in one 1000x710 coordinate
// space: the stage has a fixed aspect ratio, so the SVG layers
// (viewBox 0 0 1000 710) and the absolutely-positioned desks (percentages)
// line up exactly at any width. 1 scene unit == 0.1cqw of the stage.
//
// VIEW_H has ~70 units of headroom below the lowest desk row (the floor,
// hub and cable math all key off CY/RY/HUB, not VIEW_H, so they're
// unaffected) purely so each desk's name tag -- which sits *below* the
// desk's own box via `top: 100%` -- has room to breathe before the stage's
// `overflow: hidden` clips it. At the previous VIEW_H (640) the frontmost
// row of desks (the ones nearest the console, where computeSlots() gives
// them scale ~1) left only ~15% of the stage's height below them, while the
// desk box + name tag need ~16-17%, and hover/selection glow (a drop-shadow
// filter, which paints outside the box) eats into that margin further --
// clipping the bottom edge of those labels in a real browser even though
// the raw slot math looked fine on paper.
// ---------------------------------------------------------------------------
const VIEW_W = 1000;
const VIEW_H = 710;
const CX = 500; // ring centre
const CY = 350;
const RX = 420; // ring radii
const RY = 210;
const HUB = { x: 500, y: 355, rx: 150, ry: 40 }; // console platform rim
const BACK_ANGLE = 235; // how far round the horseshoe climbs (deg); top-centre stays clear for the console screen

interface Slot {
  x: number;
  y: number;
  angle: number; // degrees, screen coords (90 = straight toward viewer)
  scale: number; // fake depth: back desks smaller
  end: { x: number; y: number }; // where this desk's cable meets the console platform
}

function computeSlots(roles: string[]): Map<string, Slot> {
  const out = new Map<string, Slot>();
  const others = roles.filter((r) => r !== "boss");
  const leftN = Math.ceil(others.length / 2);
  const rightN = Math.floor(others.length / 2);
  const sweep = BACK_ANGLE - 90;
  const place = (role: string, angle: number, f: number) => {
    const a = (angle * Math.PI) / 180;
    const x = CX + RX * f * Math.cos(a);
    const y = CY + RY * f * Math.sin(a);
    const yTop = CY + RY * Math.sin((BACK_ANGLE * Math.PI) / 180);
    const yBot = CY + RY * Math.sin(((90 - sweep / Math.max(1, rightN)) * Math.PI) / 180);
    const t = Math.max(0, Math.min(1, (y - yTop) / Math.max(1, yBot - yTop)));
    out.set(role, {
      x,
      y,
      angle,
      scale: 0.7 + 0.3 * t,
      end: { x: HUB.x + (HUB.rx - 10) * Math.cos(a), y: HUB.y + (HUB.ry - 4) * Math.sin(a) },
    });
  };
  // Boss sits front-and-centre, pulled in closest to the console.
  place("boss", 90, 0.78);
  // Everyone else alternates left/right up the horseshoe in ROLE_ORDER, so
  // each role's desk is fixed forever.
  let l = 0,
    r = 0;
  others.forEach((role, i) => {
    if (i % 2 === 0 && l < leftN) {
      l++;
      place(role, 90 + (sweep * l) / leftN, 1);
    } else {
      r++;
      place(role, 90 - (sweep * r) / Math.max(1, rightN), 1);
    }
  });
  return out;
}

function cablePath(from: { x: number; y: number }, to: { x: number; y: number }) {
  const c1 = { x: from.x, y: from.y + (to.y - from.y) * 0.6 };
  const c2 = { x: from.x + (to.x - from.x) * 0.5, y: to.y };
  return {
    d: `M${from.x.toFixed(1)},${from.y.toFixed(1)} C${c1.x.toFixed(1)},${c1.y.toFixed(1)} ${c2.x.toFixed(1)},${c2.y.toFixed(1)} ${to.x.toFixed(1)},${to.y.toFixed(1)}`,
    // Midpoint of the cubic (t = .5) for the static reduced-motion doc icon.
    mid: {
      x: 0.125 * from.x + 0.375 * c1.x + 0.375 * c2.x + 0.125 * to.x,
      y: 0.125 * from.y + 0.375 * c1.y + 0.375 * c2.y + 0.125 * to.y,
    },
  };
}

// Deterministic skyline so SSR and client render the same silhouette.
const SKYLINE = (() => {
  let seed = 7;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  const back: { x: number; w: number; h: number }[] = [];
  const front: { x: number; w: number; h: number; lit: { x: number; y: number }[] }[] = [];
  for (let x = -10; x < VIEW_W;) {
    const w = 24 + rnd() * 40;
    back.push({ x, w, h: 60 + rnd() * 110 });
    x += w + 2;
  }
  for (let x = -20; x < VIEW_W;) {
    const w = 30 + rnd() * 50;
    const h = 50 + rnd() * (Math.abs(x - VIEW_W / 2) < 180 ? 170 : 110);
    const lit: { x: number; y: number }[] = [];
    for (let wy = 8; wy < h - 6; wy += 9)
      for (let wx = 5; wx < w - 5; wx += 8) if (rnd() < 0.22) lit.push({ x: wx, y: wy });
    front.push({ x, w, h, lit });
    x += w + 4 + rnd() * 10;
  }
  return { back, front };
})();
const HORIZON = 250;

// ---------------------------------------------------------------------------
// Small drawing components
// ---------------------------------------------------------------------------
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

// Robot seated at a desk with a monitor. viewBox 0 0 100 90; the desk's
// front-centre (100% bottom) is the anchor point on the stage.
function RobotDesk({
  accent,
  mode,
  boss,
  model,
}: {
  accent: string;
  mode: DeskMode;
  boss: boolean;
  model?: string;
}) {
  const onBreak = mode === "break";
  const working = mode === "working";
  const trim = boss ? BOSS_ACCENT : "#3a4a5e";
  return (
    <svg className="robot-desk" viewBox="0 0 100 90" aria-hidden="true" focusable="false">
      {/* chair back */}
      <rect x="36" y="34" width="28" height="26" rx="6" fill="#1a2433" />
      {/* robot (turns away from the desk while on break) */}
      <g className="robot">
        <line x1="50" y1="13" x2="50" y2="8" stroke="#8fa3b8" strokeWidth="1.4" />
        <circle cx="50" cy="7" r="1.8" fill={working ? "#35e08a" : "#56667a"} />
        <rect x="39" y="13" width="22" height="19" rx="7" fill="#c9d4df" />
        <rect
          x="42"
          y="19"
          width="16"
          height="6"
          rx="3"
          fill={onBreak ? "#3b4656" : accent}
          opacity={working ? 1 : 0.55}
        />
        <rect x="35" y="33" width="30" height="24" rx="8" fill="#b4c1ce" />
        <rect x="45" y="38" width="10" height="4" rx="2" fill={accent} opacity=".7" />
        {boss && (
          <path
            d="M41 13 L41 5 L45.5 9 L50 3 L54.5 9 L59 5 L59 13 Z"
            fill={BOSS_ACCENT}
            stroke="#8a6d00"
            strokeWidth=".6"
          />
        )}
      </g>
      {/* monitor */}
      <rect
        x="62"
        y="32"
        width="30"
        height="21"
        rx="2.5"
        fill="#0d1624"
        stroke="#3a4a5e"
        strokeWidth="1"
      />
      <rect
        x="64.5"
        y="34.5"
        width="25"
        height="16"
        rx="1.2"
        className={`screen ${working ? "on" : ""}`}
      />
      {working && (
        <g stroke="#35e08a" strokeWidth="1" opacity=".85">
          <line x1="67" y1="38" x2="82" y2="38" />
          <line x1="67" y1="41.5" x2="86" y2="41.5" />
          <line x1="67" y1="45" x2="78" y2="45" />
        </g>
      )}
      <rect x="75" y="53" width="4" height="6" fill="#2a3646" />
      {/* desk */}
      <path d="M4 60 H96 L100 68 H0 Z" fill="#dfe6ee" />
      <path d="M4 60 H96" stroke={trim} strokeWidth="1.6" />
      <rect x="4" y="68" width="92" height="18" rx="2" fill="#aebbc9" />
      <rect x="4" y="84" width="92" height="3" rx="1.5" fill={trim} opacity={boss ? 0.9 : 0.5} />
      {/* keyboard */}
      <rect x="30" y="61.5" width="26" height="3.5" rx="1" fill="#6a7a8c" />
      {/* Neon model readout, printed on the desk surface in front of the robot
          while working: tier letter / version / tier-derived effort proxy,
          each in its own glow color (see .desk-tag* rules). Replaces the
          earlier plain monospace label, which was hard to read against the
          light desk surface. */}
      {working && model && (
        <>
          {modelTierLetter(model) && (
            <text x="14" y="81" textAnchor="middle" className="desk-tag desk-tag-tier">
              {modelTierLetter(model)}
            </text>
          )}
          {modelVersion(model) && (
            <text x="38" y="80" textAnchor="middle" className="desk-tag desk-tag-ver">
              {modelVersion(model)}
            </text>
          )}
          {modelEffortProxy(model) && (
            <text x="63" y="79.5" textAnchor="middle" className="desk-tag desk-tag-effort">
              {modelEffortProxy(model)}
            </text>
          )}
        </>
      )}
      {/* tower */}
      <rect x="80" y="70" width="10" height="14" rx="1.5" fill="#8797a8" />
      <circle cx="85" cy="74" r="1.2" fill={working ? "#35e08a" : "#56667a"} />
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
  const reduceMotion = useReducedMotion();

  const prevState = useRef<Map<string, { working: boolean; room: RoomKey }> | null>(null);
  const tickIdRef = useRef(0);
  const popRef = useRef<HTMLDivElement>(null);
  // The desktop stage and the mobile stage both render the same desk
  // buttons (renderStage() is called once per variant; CSS picks which one
  // is visible), so keep separate element maps and anchor the popover to
  // whichever instance is actually on screen.
  const deskEls = useRef(new Map<string, HTMLButtonElement>());
  const mobileDeskEls = useRef(new Map<string, HTMLButtonElement>());

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

  // ---------- Desk assignment ----------
  // Every ROLE_ORDER role always owns one desk. Unknown roles (if the bridge
  // ever writes one) get appended desks so nothing is silently hidden.
  const deskRoles = useMemo(() => {
    const extra = [...new Set(rows.map((r) => r.role))]
      .filter((r) => !ROLE_ORDER.includes(r))
      .sort();
    return [...ROLE_ORDER, ...extra];
  }, [rows]);
  const slots = useMemo(() => computeSlots(deskRoles), [deskRoles]);

  // If a role ever has more than one row, the desk shows the most relevant
  // one (working first, then most recently updated); the mobile list shows all.
  const rowsByRole = useMemo(() => {
    const m = new Map<string, BoardRow[]>();
    for (const r of rows) {
      const list = m.get(r.role) ?? [];
      list.push(r);
      m.set(r.role, list);
    }
    for (const list of m.values())
      list.sort(
        (a, b) =>
          Number(isWorking(b)) - Number(isWorking(a)) ||
          new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
      );
    return m;
  }, [rows]);
  const primaryByRole = (role: string) => rowsByRole.get(role)?.[0];

  // Meetings: working agents the backend has moved to "conference", grouped
  // by the pipeline they share.
  const meetings = useMemo(() => {
    const groups = new Map<string, BoardRow[]>();
    for (const r of rows) {
      if (roomOf(r) !== "conference" || !isWorking(r) || !r.pipeline_name) continue;
      const g = groups.get(r.pipeline_name) ?? [];
      g.push(r);
      groups.set(r.pipeline_name, g);
    }
    return [...groups.entries()]
      .filter(([, g]) => g.length >= 2)
      .map(([name, g]) => ({
        name,
        members: g.sort((a, b) => roleRank(a.role) - roleRank(b.role)),
      }));
  }, [rows]);
  const meetingOf = (r: BoardRow) =>
    meetings.find((m) => m.members.some((x) => x.id === r.id)) ?? null;

  const workingEntries = rows.filter(isWorking);
  const activePipelines = new Set(workingEntries.map((r) => r.pipeline_name).filter(Boolean));
  const selected = selectedId ? (rows.find((r) => r.id === selectedId) ?? null) : null;

  // ---------- Inspect popover ----------
  const triggerFor = useCallback((id: string) => {
    const desk = deskEls.current.get(id);
    if (desk && desk.getClientRects().length > 0) return desk;
    const item = mobileDeskEls.current.get(id);
    if (item && item.getClientRects().length > 0) return item;
    return desk ?? item ?? null;
  }, []);

  const placePopover = useCallback(() => {
    if (!selectedId) return;
    const el = triggerFor(selectedId);
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
  }, [selectedId, triggerFor]);

  useLayoutEffect(() => {
    if (!selectedId) {
      setPopPos(null);
      return;
    }
    placePopover();
  }, [selectedId, rows, placePopover]);

  useEffect(() => {
    if (!selectedId) return;
    const closeAndRefocus = () => {
      const trigger = triggerFor(selectedId);
      setSelectedId(null);
      trigger?.focus();
    };
    const onDown = (e: MouseEvent | TouchEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t)) return;
      if ((t as Element).closest?.("[data-agent-trigger]")) return; // a desk/row: its own onClick toggles/switches selection
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
  }, [selectedId, placePopover, triggerFor]);

  // If the selected agent vanishes from the board (bridge row deleted), close.
  useEffect(() => {
    if (selectedId && !rows.some((r) => r.id === selectedId)) setSelectedId(null);
  }, [rows, selectedId]);

  const toggleSelect = (id: string) => setSelectedId((cur) => (cur === id ? null : id));

  const filterLc = filterText.trim().toLowerCase();
  const matchesFilter = (role: string) =>
    !filterLc || (ROLE_LABEL[role] ?? role).toLowerCase().includes(filterLc);

  const stateText = (r: BoardRow) => {
    const mode = modeOf(r);
    if (mode === "break") return "stepped away · coffee break";
    if (mode === "working") return meetingOf(r) ? "working · in a meeting" : "working";
    return "idle";
  };

  // ---------- Central console screen (shared by desktop + mobile stages) ----------
  const renderConsole = () => {
    const shown = [...workingEntries].sort((a, b) => roleRank(a.role) - roleRank(b.role)).slice(0, 3);
    const more = workingEntries.length - shown.length;
    const latest = ticker[ticker.length - 1];
    return (
      <div className="console-screen">
        <div className="cs-top" aria-hidden="true">
          <span className={`cs-live ${connected ? "on" : "off"}`} />
          <span className="cs-bars" />
        </div>
        <div className="cs-brand" role="heading" aria-level={2}>
          SPEHR
        </div>
        <div className="cs-stats">
          <span className="cs-stat">
            <b>{workingEntries.length}</b>/{rows.length || ROLE_ORDER.length} working
          </span>
          <span className="cs-stat">
            {meetings.length > 0 ? (
              <>
                <b className="mtg">{meetings.length}</b> meeting{meetings.length === 1 ? "" : "s"}
              </>
            ) : (
              "no meetings"
            )}
          </span>
          <span className="cs-stat">
            <b>{activePipelines.size}</b> pipeline{activePipelines.size === 1 ? "" : "s"}
          </span>
        </div>
        <div className="cs-feed">
          {shown.length === 0 ? (
            <div className="cs-line muted">— all desks idle —</div>
          ) : (
            shown.map((r) => (
              <div key={r.id} className="cs-line">
                <span className="cs-role" style={{ color: accentFor(r.role) }}>
                  {r.role === "boss" ? "👑 " : ""}
                  {ROLE_LABEL[r.role] ?? r.role}
                </span>{" "}
                {r.description ?? "(no description)"}
              </div>
            ))
          )}
          {more > 0 && <div className="cs-line muted">+{more} more working</div>}
          {latest && (
            <div key={latest.id} className="cs-line cs-tick">
              ▸ {latest.text}
            </div>
          )}
        </div>
      </div>
    );
  };

  // ---------- Desks (rendered once per stage variant -- see renderStage) ----------
  const renderDesk = (role: string, variant: "desktop" | "mobile") => {
    const slot = slots.get(role);
    if (!slot) return null;
    const r = primaryByRole(role);
    const accent = accentFor(role);
    const isBoss = role === "boss";
    const label = ROLE_LABEL[role] ?? role;
    const style = {
      left: `${(slot.x / VIEW_W) * 100}%`,
      top: `${(slot.y / VIEW_H) * 100}%`,
      zIndex: Math.round(slot.y),
      ["--s" as string]: slot.scale * (isBoss ? 1.12 : 1),
      ["--accent" as string]: accent,
    } as CSSProperties;
    if (!r) {
      return (
        <div
          key={`${variant}-${role}`}
          className="desk vacant"
          style={style}
          title={`${label} · no data yet`}
        >
          <span className="orb" aria-hidden="true" />
          <RobotDesk accent={accent} mode="idle" boss={isBoss} />
          <span className="desk-name">{label}</span>
        </div>
      );
    }
    const mode = modeOf(r);
    const working = mode === "working";
    const m = working && r.model ? MODEL_META[r.model] : undefined;
    const isSel = selectedId === r.id;
    const extraRows = (rowsByRole.get(role)?.length ?? 1) - 1;
    const refMap = variant === "desktop" ? deskEls : mobileDeskEls;
    return (
      <button
        key={`${variant}-${role}`}
        type="button"
        data-agent-trigger=""
        ref={(el) => {
          if (el) refMap.current.set(r.id, el);
          else refMap.current.delete(r.id);
        }}
        className={`desk ${mode} ${isBoss ? "boss" : ""} ${meetingOf(r) ? "in-meeting" : ""} ${isSel ? "selected" : ""} ${matchesFilter(role) ? "" : "dimmed"}`}
        style={style}
        onClick={() => toggleSelect(r.id)}
        aria-haspopup="dialog"
        aria-expanded={isSel}
        aria-label={`${label}, ${stateText(r)}${working && r.description ? `: ${r.description}` : ""}. Show details`}
        title={`${label} · ${stateText(r)}`}
      >
        <span className="orb" aria-hidden="true" />
        <RobotDesk
          accent={accent}
          mode={mode}
          boss={isBoss}
          model={working && r.model ? shortModelLabel(r.model) : undefined}
        />
        {m && (
          <span className="model-badge" style={{ background: m.color }} aria-hidden="true">
            {m.badge}
          </span>
        )}
        {mode === "break" && (
          <span className="cup" aria-hidden="true">
            <CoffeeIcon size={11} />
          </span>
        )}
        <span className="desk-name">
          {isBoss ? "👑 " : ""}
          {label}
          {extraRows > 0 ? ` +${extraRows}` : ""}
        </span>
      </button>
    );
  };

  // ---------- Cables + meeting links (SVG under the desks) ----------
  // Built per stage variant because each variant needs its own SVG element
  // ids (gradients, the doc-icon symbol, per-cable path ids for <mpath>) --
  // the desktop and mobile stages both sit in the DOM at once (CSS just
  // hides one of them), so sharing ids between them would make `url(#...)`
  // and `<mpath href>` references ambiguous.
  const buildStageGraphics = (idp: string) => {
    const cables: ReactNode[] = [];
    deskRoles.forEach((role, i) => {
      const slot = slots.get(role);
      const r = primaryByRole(role);
      if (!slot || !r || modeOf(r) !== "working") return;
      const { d, mid } = cablePath({ x: slot.x, y: slot.y - 4 }, slot.end);
      const id = `${idp}cable-${role}`;
      const dimmed = !matchesFilter(role);
      cables.push(
        <g key={id} className={`cable ${dimmed ? "dimmed" : ""}`}>
          <path id={id} d={d} className="cable-glow" />
          <path d={d} className="cable-core" />
          {reduceMotion ? (
            <use href={`#${idp}doc-icon`} x={mid.x} y={mid.y} />
          ) : (
            [0, 1].map((k) => (
              <use key={k} href={`#${idp}doc-icon`} x={0} y={0}>
                <animateMotion
                  dur="3.2s"
                  repeatCount="indefinite"
                  begin={`${-((i * 0.37 + k * 1.6) % 3.2).toFixed(2)}s`}
                >
                  <mpath href={`#${id}`} />
                </animateMotion>
              </use>
            ))
          )}
        </g>,
      );
    });

    const links: ReactNode[] = [];
    for (const mtg of meetings) {
      const pts = mtg.members
        .filter((r) => primaryByRole(r.role)?.id === r.id)
        .map((r) => ({ r, s: slots.get(r.role) }))
        .filter((p): p is { r: BoardRow; s: Slot } => !!p.s)
        .sort((a, b) => a.s.angle - b.s.angle);
      for (let k = 0; k < pts.length - 1; k++) {
        const A = { x: pts[k].s.x, y: pts[k].s.y - 4 };
        const B = { x: pts[k + 1].s.x, y: pts[k + 1].s.y - 4 };
        const midAB = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
        const C = { x: midAB.x + (HUB.x - midAB.x) * 0.45, y: midAB.y + (HUB.y - midAB.y) * 0.45 };
        const d = `M${A.x.toFixed(1)},${A.y.toFixed(1)} Q${C.x.toFixed(1)},${C.y.toFixed(1)} ${B.x.toFixed(1)},${B.y.toFixed(1)}`;
        const lx = 0.25 * A.x + 0.5 * C.x + 0.25 * B.x;
        const ly = 0.25 * A.y + 0.5 * C.y + 0.25 * B.y;
        links.push(
          <g key={`${idp}${mtg.name}-${k}`} className="meet-link">
            <path d={d} className="meet-glow" />
            <path d={d} className="meet-core" />
            {k === 0 && (
              <text x={lx} y={ly - 6} className="meet-label" textAnchor="middle">
                🤝 {mtg.name}
              </text>
            )}
          </g>,
        );
      }
    }
    return { cables, links };
  };

  // ---------- Popover ----------
  let popBody: ReactNode = null;
  if (selected) {
    const working = isWorking(selected);
    const mode = modeOf(selected);
    const m = selected.model ? MODEL_META[selected.model] : undefined;
    const accent = accentFor(selected.role);
    const mtg = meetingOf(selected);
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
              {mode === "break" ? "stepped away for a coffee" : working ? "working" : "idle"}
              {mtg &&
                ` · meeting with ${mtg.members
                  .filter((x) => x.id !== selected.id)
                  .map((x) => ROLE_LABEL[x.role] ?? x.role)
                  .join(", ")}`}
            </div>
          </div>
          <button
            type="button"
            className="pop-close"
            onClick={() => {
              const t = triggerFor(selected.id);
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
          {mode === "break" && selected.on_break_until && (
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

  // ---------- Full stage (background scene + cables + console + desks) ----------
  // Called once for the desktop stage and once for the mobile stage: both
  // render the exact same scene (same SVG background, same desks with the
  // same neon tier/version/effort readout, same room/breakroom/conference
  // states), so mobile "looks the same as desktop" rather than falling back
  // to a simplified list. Only the CSS around the two call sites differs --
  // the mobile one sits in a horizontally-scrollable frame at a fixed pixel
  // width (see `.stage-scroll` / `.mobile-view .stage`) so its cqw-based
  // desk/text sizing stays legible instead of being crushed to phone width.
  const renderStage = (variant: "desktop" | "mobile") => {
    const idp = variant === "desktop" ? "d-" : "m-";
    const { cables, links } = buildStageGraphics(idp);
    return (
      <div className="stage" aria-label="Agent command center">
        {/* Night skyline + glass window wall + floor */}
        <svg
          className="layer"
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          preserveAspectRatio="xMidYMid slice"
          aria-hidden="true"
          focusable="false"
        >
          <defs>
            <linearGradient id={`${idp}sky`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#0b1a2c" />
              <stop offset=".55" stopColor="#123049" />
              <stop offset="1" stopColor="#1b4460" />
            </linearGradient>
            <radialGradient id={`${idp}floor`} cx=".5" cy=".42" r=".62">
              <stop offset="0" stopColor="#12323c" />
              <stop offset=".6" stopColor="#0a1c24" />
              <stop offset="1" stopColor="#050c11" />
            </radialGradient>
            <radialGradient id={`${idp}hubGlow`} cx=".5" cy=".5" r=".5">
              <stop offset="0" stopColor="#35e08a" stopOpacity=".22" />
              <stop offset="1" stopColor="#35e08a" stopOpacity="0" />
            </radialGradient>
            <linearGradient id={`${idp}glass`} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#bfe6ff" stopOpacity=".06" />
              <stop offset=".5" stopColor="#bfe6ff" stopOpacity="0" />
              <stop offset="1" stopColor="#bfe6ff" stopOpacity=".04" />
            </linearGradient>
          </defs>
          <rect width={VIEW_W} height={HORIZON + 40} fill={`url(#${idp}sky)`} />
          <ellipse cx="500" cy={HORIZON - 30} rx="520" ry="40" fill="#2a5b78" opacity=".25" />
          <g fill="#0f2233">
            {SKYLINE.back.map((b, i) => (
              <rect key={i} x={b.x} y={HORIZON - b.h} width={b.w} height={b.h + 40} />
            ))}
          </g>
          <g>
            {SKYLINE.front.map((b, i) => (
              <g key={i} transform={`translate(${b.x} ${HORIZON - b.h})`}>
                <rect width={b.w} height={b.h + 40} fill="#0a1824" />
                {b.lit.map((w, j) => (
                  <rect
                    key={j}
                    x={w.x}
                    y={w.y}
                    width="3"
                    height="4"
                    fill={j % 5 === 0 ? "#7fd0ff" : "#ffe7a8"}
                    opacity=".55"
                  />
                ))}
              </g>
            ))}
          </g>
          {/* window wall: mullions + reflections */}
          <rect width={VIEW_W} height={HORIZON + 40} fill={`url(#${idp}glass)`} />
          <g stroke="#1d3a50" strokeWidth="6">
            {Array.from({ length: 13 }, (_, i) => {
              const x = (i * VIEW_W) / 12;
              const lean = (x - VIEW_W / 2) * 0.08;
              return <line key={i} x1={x - lean} y1="0" x2={x} y2={HORIZON + 40} />;
            })}
          </g>
          <g stroke="#bfe6ff" strokeWidth="18" opacity=".035">
            {[120, 330, 610, 820].map((x) => (
              <line key={x} x1={x} y1="0" x2={x + 90} y2={HORIZON + 40} />
            ))}
          </g>
          {/* ceiling rim */}
          <path
            d={`M0,0 H${VIEW_W} V26 Q${VIEW_W / 2},64 0,26 Z`}
            fill="#07111b"
            stroke="#6fd2ff"
            strokeOpacity=".35"
            strokeWidth="1.5"
          />
          {/* floor */}
          <path
            d={`M0,${HORIZON + 20} Q${VIEW_W / 2},${HORIZON - 30} ${VIEW_W},${HORIZON + 20} V${VIEW_H} H0 Z`}
            fill={`url(#${idp}floor)`}
          />
          <path
            d={`M0,${HORIZON + 20} Q${VIEW_W / 2},${HORIZON - 30} ${VIEW_W},${HORIZON + 20}`}
            fill="none"
            stroke="#6fd2ff"
            strokeOpacity=".22"
            strokeWidth="2"
          />
          <ellipse
            cx={CX}
            cy={CY + 10}
            rx={RX + 40}
            ry={RY + 30}
            fill="none"
            stroke="#1f4a5a"
            strokeOpacity=".5"
            strokeWidth="1.5"
          />
          <ellipse
            cx={CX}
            cy={CY + 10}
            rx={RX - 70}
            ry={RY - 50}
            fill="none"
            stroke="#1f4a5a"
            strokeOpacity=".35"
            strokeWidth="1"
          />
          {/* raised console platform */}
          <ellipse cx={HUB.x} cy={HUB.y} rx={HUB.rx + 70} ry={HUB.ry + 30} fill={`url(#${idp}hubGlow)`} />
          <ellipse
            cx={HUB.x}
            cy={HUB.y + 10}
            rx={HUB.rx + 16}
            ry={HUB.ry + 8}
            fill="#0b1c26"
            stroke="#6fd2ff"
            strokeOpacity=".45"
            strokeWidth="2"
          />
          <ellipse
            cx={HUB.x}
            cy={HUB.y}
            rx={HUB.rx}
            ry={HUB.ry}
            fill="#10262f"
            stroke="#9fe8ff"
            strokeOpacity=".7"
            strokeWidth="2"
          />
          {/* console body under the screen */}
          <path d="M425,272 H575 L588,352 H412 Z" fill="#1a2c38" stroke="#3d6377" strokeWidth="1.5" />
          <rect x="432" y="300" width="136" height="10" rx="3" fill="#0d1a22" />
          <g fill="#35e08a" opacity=".7">
            <rect x="442" y="318" width="10" height="4" rx="1" />
            <rect x="458" y="318" width="22" height="4" rx="1" opacity=".5" />
            <rect x="530" y="318" width="16" height="4" rx="1" opacity=".6" />
          </g>
        </svg>

        {/* Task-feed cables + meeting links */}
        <svg
          className="layer cables"
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          preserveAspectRatio="xMidYMid slice"
          aria-hidden="true"
          focusable="false"
        >
          <defs>
            <g id={`${idp}doc-icon`}>
              <g transform="translate(-5 -6)">
                <path d="M0 0 H7 L10 3 V12 H0 Z" fill="#0d3a26" stroke="#7dffb8" strokeWidth="1" />
                <path d="M2 4.5 H7 M2 7 H8 M2 9.5 H6" stroke="#7dffb8" strokeWidth=".8" />
              </g>
            </g>
          </defs>
          {links}
          {cables}
        </svg>

        <div className="console-wrap">{renderConsole()}</div>

        {deskRoles.map((role) => renderDesk(role, variant))}
      </div>
    );
  };

  return (
    <>
      <style>{`
        .office-root { color-scheme: dark; }
        .office-root * { box-sizing: border-box; }
        .office-root {
          --green: #35e08a; --green-soft: rgba(53,224,138,.35); --meet: #5ff5e0;
          --ink: #e7eaf3; --ink-2: #cfd6ea; --ink-3: #9aa2ba; --ink-4: #6d7690; --ink-5: #565e78;
          --glass: rgba(10,18,30,.72); --line: rgba(140,200,255,.12);
          margin: 0; min-height: 100vh; position: relative; overflow-x: hidden;
          background: radial-gradient(ellipse 110% 80% at 50% 30%, #0f2233 0%, #071019 55%, #04070b 100%);
          color: var(--ink); font: 13px/1.4 -apple-system, "Segoe UI", Roboto, sans-serif;
        }
        @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }

        /* ================= MASTHEAD ================= */
        header.office-header { position: sticky; top: 0; z-index: 60; display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 12px 22px; background: rgba(4,9,15,.78); backdrop-filter: blur(10px); border-bottom: 1px solid var(--line); }
        .brand { font-weight: 800; letter-spacing: .12em; font-size: 13px; color: var(--ink-2); white-space: nowrap; }
        .brand span { color: var(--ink-4); font-weight: 600; }
        .brand .live { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--green); margin-right: 8px; box-shadow: 0 0 8px var(--green); animation: pulse 1.6s infinite; vertical-align: 1px; }
        .swarm-count { font-size: 11px; color: var(--ink-3); margin-left: 12px; letter-spacing: .02em; font-weight: 600; }
        .swarm-count b { color: var(--green); }
        .conn-row { display: flex; gap: 6px; align-items: center; }
        .conn-chip { display: flex; align-items: center; gap: 6px; background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.08); padding: 5px 10px; border-radius: 999px; font-size: 11px; color: var(--ink-3); }
        .conn-chip .dot { width: 6px; height: 6px; border-radius: 50%; background: #4a5170; }
        .conn-chip.on .dot { background: var(--green); box-shadow: 0 0 6px var(--green); }
        .conn-chip.off .dot { background: #e0435c; }
        .search-box { background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.1); border-radius: 999px; padding: 5px 12px; font: inherit; font-size: 11.5px; color: var(--ink); width: 140px; transition: width .2s ease, background .2s ease; }
        .search-box::placeholder { color: var(--ink-4); }
        .search-box:focus { outline: none; width: 180px; background: rgba(255,255,255,.08); border-color: rgba(53,224,138,.4); }
        .legend-bar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; justify-content: center; margin: 12px auto 0; width: fit-content; max-width: calc(100% - 32px); background: var(--glass); backdrop-filter: blur(6px); border: 1px solid var(--line); border-radius: 999px; padding: 6px 14px; font-size: 10.5px; color: var(--ink-3); }
        .legend-bar .sep { color: var(--ink-5); }
        .legend-key { display: inline-flex; align-items: center; gap: 5px; }
        .legend-key .pd { width: 8px; height: 8px; border-radius: 50%; background: var(--green); box-shadow: 0 0 6px var(--green); }
        .legend-key .ln { width: 16px; height: 2px; border-radius: 2px; background: var(--green); box-shadow: 0 0 5px var(--green); }
        .legend-key .ln.meet { background: var(--meet); box-shadow: 0 0 5px var(--meet); }
        .model-chip { display: inline-flex; align-items: center; gap: 4px; font-size: 10px; font-weight: 700; padding: 1px 6px 1px 4px; border-radius: 999px; }
        .model-chip .sw { width: 8px; height: 8px; border-radius: 3px; display: inline-block; }
        .pipeline-tag { display: inline-flex; align-items: center; gap: 3px; font-size: 9px; font-weight: 700; color: #ffdd7a; background: rgba(255,221,122,.12); border: 1px solid rgba(255,221,122,.25); border-radius: 999px; padding: 1px 7px; margin-top: 3px; width: fit-content; }

        /* ================= LAYOUT SWITCH ================= */
        /* A fluid cap (instead of a flat 1280px) lets the stage grow on
           larger desktop monitors -- 1280px left a growing, unbalanced band
           of empty side margin past ~1400px viewport width, while the scene
           itself (an SVG) scales cleanly with no loss of fidelity. */
        .office-main { padding: 14px 22px 96px; max-width: min(1600px, 94vw); margin: 0 auto; }
        .mobile-view { display: none; }
        @media (max-width: 700px) {
          .desktop-view { display: none; }
          .mobile-view { display: block; }
          .office-main { padding: 12px 16px 96px; max-width: 100%; }
          header.office-header { padding: 12px 16px; }
          .swarm-count { display: block; margin: 4px 0 0; }
        }

        /* ================= DESKTOP STAGE ================= */
        .stage { position: relative; width: 100%; aspect-ratio: ${VIEW_W} / ${VIEW_H}; container-type: inline-size; border-radius: 22px; overflow: hidden;
          border: 1px solid rgba(120,190,255,.14); box-shadow: 0 40px 80px -40px rgba(0,0,0,.9), inset 0 0 80px rgba(0,0,0,.5); background: #050b12; }
        .stage > svg.layer { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
        .layer.cables { z-index: 2; pointer-events: none; }
        .cable-glow { fill: none; stroke: var(--green); stroke-width: 7; opacity: .16; stroke-linecap: round; }
        .cable-core { fill: none; stroke: #7dffb8; stroke-width: 1.8; stroke-linecap: round; stroke-dasharray: 10 7; filter: drop-shadow(0 0 3px var(--green)); animation: flow 1.1s linear infinite; }
        .cable { animation: fadeIn .5s ease; }
        .cable.dimmed { opacity: .2; }
        @keyframes flow { to { stroke-dashoffset: -17; } }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        .meet-glow { fill: none; stroke: var(--meet); stroke-width: 9; opacity: .18; stroke-linecap: round; animation: meetPulse 1.6s ease-in-out infinite; }
        .meet-core { fill: none; stroke: var(--meet); stroke-width: 2.4; stroke-linecap: round; filter: drop-shadow(0 0 4px var(--meet)); }
        .meet-label { fill: var(--meet); font-size: 12px; font-weight: 700; letter-spacing: .03em; paint-order: stroke; stroke: #04121a; stroke-width: 3px; }
        @keyframes meetPulse { 0%,100% { opacity: .1; } 50% { opacity: .38; } }

        /* Console */
        .console-wrap { position: absolute; left: 50%; top: 7.5cqw; transform: translateX(-50%); width: 33cqw; z-index: 3; }
        .console-screen { position: relative; border-radius: 1.2cqw; padding: 1.1cqw 1.6cqw 1.2cqw;
          background: linear-gradient(180deg, rgba(8,30,44,.94), rgba(4,16,26,.96));
          border: 2px solid rgba(110,210,255,.55);
          box-shadow: 0 0 0 1px rgba(0,0,0,.6), 0 0 2.4cqw rgba(80,190,255,.35), inset 0 0 2cqw rgba(60,170,255,.18); }
        .console-screen::after { content: ''; position: absolute; inset: 0; border-radius: inherit; pointer-events: none;
          background: repeating-linear-gradient(180deg, rgba(255,255,255,.025) 0 1px, transparent 1px 3px); }
        .cs-top { display: flex; align-items: center; gap: 8px; margin-bottom: .3cqw; }
        .cs-live { width: 7px; height: 7px; border-radius: 50%; background: #e0435c; flex-shrink: 0; }
        .cs-live.on { background: var(--green); box-shadow: 0 0 6px var(--green); animation: pulse 1.6s infinite; }
        .cs-bars { flex: 1; height: 3px; border-radius: 3px; background: linear-gradient(90deg, rgba(110,210,255,.55), rgba(110,210,255,.08) 60%, transparent); }
        .cs-brand { text-align: center; font-weight: 800; letter-spacing: .14em; line-height: 1; color: #e9fbff; font-size: 5cqw; margin: .2cqw 0 .5cqw;
          text-shadow: 0 0 .4cqw #9fe8ff, 0 0 1.2cqw #3fb8ff, 0 0 2.6cqw rgba(63,184,255,.7); font-family: "Eurostile", "Orbitron", "Segoe UI", system-ui, sans-serif; }
        .cs-stats { display: flex; justify-content: center; gap: .6cqw 1.4cqw; flex-wrap: wrap; font-size: clamp(9px, 1.05cqw, 13px); color: var(--ink-3); border-top: 1px solid rgba(110,210,255,.18); border-bottom: 1px solid rgba(110,210,255,.18); padding: .35cqw 0; }
        .cs-stat b { color: var(--green); font-weight: 800; }
        .cs-stat b.mtg { color: var(--meet); }
        .cs-feed { margin-top: .45cqw; display: flex; flex-direction: column; gap: .15cqw; font-family: ui-monospace, monospace; font-size: clamp(8.5px, .95cqw, 12px); color: #a8e8c6; min-height: 3.2cqw; }
        .cs-line { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .cs-role { font-weight: 800; }
        .cs-tick { color: #7fd0ff; animation: fadeIn .4s ease; }

        /* Desks */
        .desk { position: absolute; width: calc(9.4cqw * var(--s)); transform: translate(-50%, -100%); display: flex; flex-direction: column; align-items: center;
          padding: 0; background: none; border: none; color: inherit; font: inherit; cursor: pointer; transition: opacity .3s ease, filter .3s ease; }
        .desk.vacant { cursor: default; opacity: .35; }
        .desk.dimmed { opacity: .22; }
        .robot-desk { width: 100%; height: auto; display: block; overflow: visible; filter: drop-shadow(0 .6cqw .5cqw rgba(0,0,0,.55)); }
        .robot-desk .robot { transition: transform .6s cubic-bezier(.22,.8,.24,1), opacity .4s ease; transform-origin: 50px 45px; transform-box: view-box; }
        .robot-desk .screen { fill: #102033; transition: fill .4s ease; }
        .robot-desk .screen.on { fill: #0b2c24; }
        /* Neon on-desk model readout: three distinct glow colors so tier,
           version and (tier-derived) effort proxy stay visually separate at
           a glance, none clashing with the green "working" accent, gold boss
           accent or teal meeting color used elsewhere on the stage. */
        .desk-tag { font-family: ui-monospace, monospace; font-weight: 800; paint-order: stroke; }
        .desk-tag-tier { font-size: 11px; fill: #0a0a0a;
          filter: drop-shadow(0 0 .6px #00f0ff) drop-shadow(0 0 2px #00f0ff) drop-shadow(0 0 4.5px rgba(0,240,255,.95)); }
        .desk-tag-ver { font-size: 7px; fill: #ff36e0;
          filter: drop-shadow(0 0 .5px #ff36e0) drop-shadow(0 0 1.4px #ff36e0) drop-shadow(0 0 3px rgba(255,54,224,.85)); }
        .desk-tag-effort { font-size: 5.4px; letter-spacing: .03em; fill: #aef22c;
          filter: drop-shadow(0 0 .5px #aef22c) drop-shadow(0 0 1.4px #aef22c) drop-shadow(0 0 3px rgba(174,242,44,.85)); }
        .desk.break .robot { transform: translateX(-20px) scaleX(-1) rotate(-4deg); opacity: .6; }
        .desk.break .robot-desk { filter: drop-shadow(0 .6cqw .5cqw rgba(0,0,0,.55)) saturate(.55) brightness(.8); }
        .desk.idle .robot-desk { filter: drop-shadow(0 .6cqw .5cqw rgba(0,0,0,.55)) brightness(.82); }
        .desk:hover .robot-desk { filter: drop-shadow(0 0 .8cqw rgba(120,220,255,.35)); }
        .desk:focus-visible { outline: 2px solid var(--green); outline-offset: 3px; border-radius: 8px; }
        .desk.selected .robot-desk { filter: drop-shadow(0 0 .9cqw var(--accent)); }
        .desk.boss .desk-name { color: ${BOSS_ACCENT}; }

        .orb { width: 26%; aspect-ratio: 1; border-radius: 50%; margin-bottom: 3%; flex-shrink: 0;
          background: radial-gradient(circle at 38% 34%, #6b7788, #2a3340 70%); opacity: .45; box-shadow: none; transition: background .4s ease, box-shadow .4s ease, opacity .4s ease; }
        .desk.working .orb {
          opacity: 1; background: radial-gradient(circle at 38% 34%, #eafff2 0%, #7dffb8 30%, #35e08a 62%, #148a4e 100%);
          box-shadow: 0 0 .8cqw .2cqw rgba(53,224,138,.7), 0 0 2.2cqw .6cqw rgba(53,224,138,.35); animation: orbPulse 2.2s ease-in-out infinite; }
        .desk.boss.working .orb { box-shadow: 0 0 .8cqw .2cqw rgba(53,224,138,.7), 0 0 2.2cqw .6cqw rgba(53,224,138,.35), 0 0 0 2px rgba(255,215,0,.55); }
        .desk.break .orb { opacity: .2; }
        @keyframes orbPulse { 0%,100% { transform: translateY(0) scale(1); filter: brightness(1); } 50% { transform: translateY(-6%) scale(1.08); filter: brightness(1.2); } }

        .desk-name { position: absolute; top: 100%; left: 50%; transform: translateX(-50%); margin-top: .35cqw; white-space: nowrap; font-size: clamp(8.5px, calc(1.05cqw * var(--s)), 12px); font-weight: 700; letter-spacing: .02em;
          color: var(--ink-3); background: rgba(4,12,20,.72); border: 1px solid var(--line); border-radius: 999px; padding: 0 .6cqw; line-height: 1.6; }
        .desk.working .desk-name { color: var(--ink); border-color: rgba(53,224,138,.35); }
        .desk.in-meeting .desk-name { border-color: rgba(95,245,224,.6); box-shadow: 0 0 .6cqw rgba(95,245,224,.35); }
        .desk.break .desk-name { color: #ffb583; border-color: rgba(255,181,131,.35); }
        .desk .model-badge { position: absolute; top: 30%; left: 4%; width: clamp(12px, 1.4cqw, 16px); height: clamp(12px, 1.4cqw, 16px); border-radius: 4px; font-size: clamp(8px, .9cqw, 10px); font-weight: 800; line-height: 1; display: flex; align-items: center; justify-content: center; color: #0a0c14; border: 1px solid rgba(0,0,0,.35); box-shadow: 0 1px 3px rgba(0,0,0,.5); }
        .desk .cup { position: absolute; top: 2%; right: 8%; width: clamp(16px, 1.8cqw, 22px); height: clamp(16px, 1.8cqw, 22px); border-radius: 50%; display: flex; align-items: center; justify-content: center; background: #1b1f2c; border: 1px solid rgba(255,181,131,.45); animation: sip 2.4s ease-in-out infinite; }
        @keyframes sip { 0%,100% { transform: rotate(0); } 50% { transform: rotate(-10deg) translateY(-1px); } }

        /* ================= MOBILE STAGE (same scene, panned) =================
           Mobile renders the identical .stage markup as desktop (see
           renderStage() -- same rooms/desks/console/neon readout), just
           inside a horizontally-scrollable frame at a fixed pixel width so
           the cqw-based sizing inside .stage stays legible instead of
           shrinking to illegible sizes at true phone width. */
        .stage-hint { text-align: center; font-size: 10.5px; color: var(--ink-4); margin: 0 0 8px; letter-spacing: .02em; }
        .stage-scroll { overflow-x: auto; overflow-y: hidden; border-radius: 22px; -webkit-overflow-scrolling: touch; scrollbar-width: thin; scroll-snap-type: x proximity; }
        .stage-scroll .stage { width: 860px; max-width: none; scroll-snap-align: center; }
        .stage-scroll::-webkit-scrollbar { height: 6px; }
        .stage-scroll::-webkit-scrollbar-thumb { background: rgba(120,190,255,.25); border-radius: 999px; }

        /* ================= INSPECT POPOVER ================= */
        .agent-pop { position: fixed; z-index: 70; width: ${POP_W}px; background: rgba(6,16,26,.94); backdrop-filter: blur(12px); border: 1px solid rgba(110,210,255,.28); border-radius: 12px; box-shadow: 0 0 24px -8px rgba(63,184,255,.45), 0 20px 44px -14px rgba(0,0,0,.85); padding: 12px 14px 12px; animation: popIn .16s ease; }
        @keyframes popIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
        @media (max-width: 560px) { .agent-pop { left: 12px !important; right: 12px; top: auto !important; bottom: 12px; width: auto; } }
        .pop-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
        .pop-title { font-weight: 800; font-size: 12.5px; letter-spacing: .05em; }
        .pop-sub { font-size: 10.5px; color: var(--ink-4); margin-top: 2px; display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
        .pop-state { width: 7px; height: 7px; border-radius: 50%; background: #4a5170; flex-shrink: 0; }
        .pop-state.on { background: var(--green); box-shadow: 0 0 6px var(--green); }
        .pop-close { background: rgba(255,255,255,.06); border: none; color: var(--ink-3); font-size: 16px; width: 26px; height: 26px; border-radius: 999px; cursor: pointer; flex-shrink: 0; line-height: 1; }
        .pop-close:hover { color: var(--ink); background: rgba(255,255,255,.1); }
        .pop-close:focus-visible { outline: 2px solid var(--green); }
        .pop-task { margin-top: 10px; font-size: 12px; color: var(--ink-2); line-height: 1.4; background: rgba(53,224,138,.04); border: 1px solid rgba(110,210,255,.14); border-radius: 8px; padding: 8px 10px; word-break: break-word; }
        .pop-grid { display: grid; grid-template-columns: auto 1fr; gap: 6px 10px; margin: 10px 0 0; font-size: 11px; align-items: center; }
        .pop-grid dt { color: var(--ink-5); font-size: 9.5px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; }
        .pop-grid dd { margin: 0; color: var(--ink-2); min-width: 0; overflow-wrap: anywhere; }
        .muted { color: var(--ink-4); }
        .mono { font-family: ui-monospace, monospace; font-size: 10.5px; }

        .office-footer-note { text-align: center; font-size: 10.5px; color: var(--ink-5); margin-top: 16px; line-height: 1.5; }
        .ticker { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%); display: flex; flex-direction: column-reverse; gap: 6px; z-index: 55; pointer-events: none; align-items: center; width: min(560px, 90vw); }
        .ticker-item { background: rgba(6,16,26,.92); border: 1px solid rgba(53,224,138,.22); border-radius: 999px; padding: 6px 14px; font-size: 11.5px; color: var(--ink-2); backdrop-filter: blur(8px); animation: tickerIn .35s ease; box-shadow: 0 8px 20px -8px rgba(0,0,0,.6); white-space: nowrap; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
        @keyframes tickerIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        @media (max-width: 700px) { .ticker { bottom: 12px; width: calc(100vw - 24px); } .ticker-item { white-space: normal; text-align: center; } }

        @media (prefers-reduced-motion: reduce) {
          .brand .live, .cs-live.on, .cable, .cable-core, .meet-glow, .desk .cup,
          .desk.working .orb, .cs-tick, .ticker-item, .agent-pop { animation: none; }
          .robot-desk .robot, .robot-desk .screen, .desk, .orb { transition: none; }
          .meet-glow { opacity: .28; }
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
            <span className="ln" />
            task feed
          </span>
          <span className="legend-key">
            <span className="ln meet" />
            meeting
          </span>
          <span className="legend-key">
            <CoffeeIcon />
            stepped away
          </span>
          <span className="sep">— click any desk to inspect</span>
        </div>

        <main className="office-main">
          {/* ================= DESKTOP: command-center ring ================= */}
          <div className="desktop-view">{renderStage("desktop")}</div>

          {/* ================= MOBILE: same scene, panned instead of shrunk =================
              Mobile reuses the exact same stage (renderStage) as desktop -- same
              rooms/desks/neon readout/breakroom/conference visuals -- rather than a
              simplified list. At phone width the full 1000-unit-wide scene can't be
              legibly squeezed to ~360px, so it's rendered at a fixed, readable pixel
              width inside a horizontally-scrollable frame (.stage-scroll) instead:
              same design, panned rather than shrunk illegible. */}
          <div className="mobile-view">
            <p className="stage-hint" aria-hidden="true">
              ↔ scroll to see the whole room
            </p>
            <div className="stage-scroll">{renderStage("mobile")}</div>
          </div>

          <div className="office-footer-note">
            Monitoring only — nothing here can spawn or control an agent. State lives in Supabase,
            not on any one machine.
          </div>
        </main>

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
