import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@supabase/supabase-js";

export const Route = createFileRoute("/office")({
  component: OfficePage,
});

// office_board isn't in the generated Supabase types (added after the last
// type-gen pass) -- a standalone client keeps this page decoupled from that
// regeneration rather than casting the shared typed client to `any`.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;
const officeClient = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

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
  "#ff7a8f", "#3fe6c8", "#7aa6ff", "#ffdd7a", "#c1a3ff", "#7ad6f5",
  "#ffb583", "#9cf0b4", "#ff9ecf", "#8fd6ff", "#d9e26a", "#b98cff",
];
const BOSS_ACCENT = "#ffd700";

const MODEL_META: Record<string, { badge: string; color: string; label: string; tier: string }> = {
  haiku: { badge: "H", color: "#35e08a", label: "Haiku", tier: "Low complexity — simple/mechanical" },
  sonnet: { badge: "S", color: "#7aa6ff", label: "Sonnet", tier: "Medium complexity — default for typical work" },
  opus: { badge: "O", color: "#c1a3ff", label: "Opus", tier: "High complexity — architecture / high-stakes" },
};
const ROUTED_BY_LABEL: Record<string, string> = {
  "task-difficulty": "routed by task complexity",
  default: "standing roster (no task run yet)",
};

// Positions are computed dynamically so any number of role pods fits around
// the hub without overlapping -- no fixed slot count. Desktop only.
function posFor(i: number, total: number) {
  const angle = (2 * Math.PI * i) / total - Math.PI / 2;
  const rx = 38, ry = 33; // ellipse radii (%) — wider than tall to fit the viewport
  return { top: 50 + ry * Math.sin(angle), left: 50 + rx * Math.cos(angle) };
}

function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function svgLine(x1: number, y1: number, x2: number, y2: number) {
  const midX = (x1 + x2) / 2, midY = (y1 + y2) / 2 - 4;
  return `M ${x1} ${y1} Q ${midX} ${midY} ${x2} ${y2}`;
}

function pipelineTag(row: BoardRow | undefined | null) {
  if (!row || !row.pipeline_name) return null;
  const stageStr = row.pipeline_stage && row.pipeline_total ? ` ${row.pipeline_stage}/${row.pipeline_total}` : "";
  return `🔗 ${row.pipeline_name}${stageStr}`;
}

interface TickerItem { id: string; text: string; }
interface Tip { x: number; y: number; html: string; }
type Selection = { kind: "group"; type: string } | { kind: "hub" } | null;

function OfficePage() {
  const [rows, setRows] = useState<BoardRow[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filterText, setFilterText] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const [selected, setSelected] = useState<Selection>(null);
  const [ringPulse, setRingPulse] = useState(0);
  const [ticker, setTicker] = useState<TickerItem[]>([]);
  const [tip, setTip] = useState<Tip | null>(null);

  const prevActiveIds = useRef<Set<string> | null>(null);
  const tickIdRef = useRef(0);

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
      .select("*")
      .order("started_at", { ascending: true });
    if (err) {
      setConnected(false);
      setError(err.message);
      return;
    }
    setConnected(true);
    setError(null);
    const next = (data ?? []) as BoardRow[];

    const activeIds = new Set(next.filter((r) => !r.is_placeholder).map((r) => r.id));
    if (prevActiveIds.current) {
      for (const r of next) {
        if (!r.is_placeholder && !prevActiveIds.current.has(r.id)) {
          pushTick(`🟢 ${ROLE_LABEL[r.role] ?? r.role} started: ${r.description ?? "(no description)"}`);
        }
      }
      for (const id of prevActiveIds.current) {
        if (!activeIds.has(id)) pushTick(`✅ finished`);
      }
    }
    prevActiveIds.current = activeIds;
    setRows(next);
  }, [pushTick]);

  useEffect(() => {
    fetchBoard();
    const poll = setInterval(fetchBoard, 4000);
    return () => clearInterval(poll);
  }, [fetchBoard]);

  const byRole = useMemo(() => {
    const m = new Map<string, BoardRow[]>();
    for (const row of rows) {
      const list = m.get(row.role) ?? [];
      list.push(row);
      m.set(row.role, list);
    }
    return m;
  }, [rows]);

  const fullGroupList = useMemo(
    () => ROLE_ORDER.map((role) => [role, byRole.get(role) ?? []] as [string, BoardRow[]]),
    [byRole]
  );
  const groupList = filterText
    ? fullGroupList.filter(([role]) => (ROLE_LABEL[role] ?? role).toLowerCase().includes(filterText.toLowerCase()))
    : fullGroupList;

  const accentByType = useMemo(() => {
    const map = new Map<string, string>();
    fullGroupList.forEach(([role], i) => map.set(role, role === "boss" ? BOSS_ACCENT : PALETTE[i % PALETTE.length]));
    return map;
  }, [fullGroupList]);

  const activeEntries = rows.filter((r) => !r.is_placeholder);
  const anyActive = activeEntries.length > 0;

  const activePipelines = useMemo(() => {
    const p = new Map<string, { name: string; stage: number | null; total: number | null }>();
    for (const r of activeEntries) {
      if (r.pipeline_name) p.set(r.pipeline_name, { name: r.pipeline_name, stage: r.pipeline_stage, total: r.pipeline_total });
    }
    return [...p.values()];
  }, [activeEntries]);

  // Shared drawer/sheet content — same markup renders in the desktop
  // right-side drawer and the mobile bottom sheet so the two layouts never
  // drift out of sync.
  let selectedTitle: string | null = null;
  let selectedSub: string | null = null;
  let selectedBody: React.ReactNode = null;
  if (selected?.kind === "group") {
    selectedTitle = (ROLE_LABEL[selected.type] ?? selected.type).toUpperCase();
    const list = (byRole.get(selected.type) ?? []).filter((r) => !r.is_placeholder);
    selectedSub = `${list.length} active on this desk`;
    selectedBody = list.length === 0 ? (
      <div className="drawer-empty">Idle — no active work for this role.</div>
    ) : (
      list.map((r) => {
        const m = r.model ? MODEL_META[r.model] : undefined;
        const tag = pipelineTag(r);
        return (
          <div key={r.id} className="agent-row">
            <span className="status-dot" />
            <span className="info">
              <div className="id">{r.id}</div>
              <div className="stats">{timeAgo(r.started_at)}</div>
              {m && (
                <div className="stats" style={{ marginTop: 2 }}>
                  <span className="model-chip" style={{ background: `${m.color}22`, color: m.color }}>
                    <span className="sw" style={{ background: m.color }} />{m.label}
                  </span> · {ROUTED_BY_LABEL[r.model_routed_by ?? ""] ?? "routing unknown"}
                </div>
              )}
              <div className="stats task">{r.description ?? "(no description)"}</div>
              {tag && <span className="pipeline-tag">{tag}</span>}
            </span>
          </div>
        );
      })
    );
  } else if (selected?.kind === "hub") {
    selectedTitle = "SWARM CORE";
    selectedSub = "spehr.live · office_board";
    selectedBody = (
      <>
        <div className="drawer-stat-row">
          <div className="drawer-stat"><div className="n">{activeEntries.length}</div><div className="l">Active</div></div>
          <div className="drawer-stat"><div className="n">{ROLE_ORDER.length - new Set(activeEntries.map((r) => r.role)).size}</div><div className="l">Idle roles</div></div>
        </div>
        {activePipelines.length > 0 && (
          <div className="drawer-stat">
            <div className="l" style={{ marginBottom: 4 }}>Active pipelines</div>
            {activePipelines.map((p) => (
              <div key={p.name} style={{ fontSize: 11, color: "#cfd6ea" }}>🔗 {p.name} — stage {p.stage}/{p.total}</div>
            ))}
          </div>
        )}
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
        .mobile-view { display: none; }
        @media (max-width: 700px) {
          .desktop-view { display: none; }
          .mobile-view { display: block; }
        }

        /* ================= DESKTOP (hub-and-spoke) ================= */
        .office { position: relative; width: 100%; height: 100vh; overflow: hidden; }
        header.office-header { position: absolute; top: 0; left: 0; right: 0; z-index: 20; display: flex; align-items: center; justify-content: space-between; padding: 16px 22px; }
        .brand { font-weight: 800; letter-spacing: .12em; font-size: 13px; color: #cfd6ea; }
        .brand span { color: #6d7690; font-weight: 600; }
        .brand .live { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #35e08a; margin-right: 8px; box-shadow: 0 0 8px #35e08a; animation: pulse 1.6s infinite; vertical-align: 1px; }
        .conn-row { display: flex; gap: 6px; align-items: center; }
        .conn-chip { display: flex; align-items: center; gap: 6px; background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.08); padding: 5px 10px; border-radius: 999px; font-size: 11px; color: #9aa2ba; backdrop-filter: blur(6px); }
        .conn-chip .dot { width: 6px; height: 6px; border-radius: 50%; background: #4a5170; }
        .conn-chip.on .dot { background: #35e08a; box-shadow: 0 0 6px #35e08a; }
        .conn-chip.off .dot { background: #e0435c; }
        @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
        .stage { position: absolute; inset: 0; }
        .floor { position: absolute; inset: 0; background-image: linear-gradient(rgba(255,255,255,.025) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.025) 1px, transparent 1px); background-size: 46px 46px; mask-image: radial-gradient(ellipse 75% 65% at 50% 48%, black 40%, transparent 78%); }
        .wires { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
        .wires path.wire { fill: none; stroke: rgba(140,160,255,.28); stroke-width: .18; stroke-dasharray: .6 1.1; animation: flow 12s linear infinite; vector-effect: non-scaling-stroke; }
        .wires path.wire.hot { stroke: rgba(160,220,255,.55); }
        .wires circle.pulse { fill: #9db2ff; filter: drop-shadow(0 0 3px #9db2ff); }
        @keyframes flow { to { stroke-dashoffset: -60; } }
        .hub { position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%); width: 84px; height: 84px; z-index: 5; cursor: pointer; }
        .hub-ring { position: absolute; inset: -10px; border-radius: 50%; border: 1px solid rgba(140,160,255,.35); opacity: 0; }
        .hub-ring.pulsing { animation: ringpulse 1.1s ease-out; }
        @keyframes ringpulse { 0% { opacity: .9; transform: scale(.85); } 100% { opacity: 0; transform: scale(1.7); } }
        .hub-core { position: absolute; inset: 0; border-radius: 50%; background: radial-gradient(circle at 40% 35%, #9db2ff, #4b5bd6 55%, #222a5c 100%); box-shadow: 0 0 40px 6px rgba(90,110,255,.45), 0 0 0 1px rgba(255,255,255,.15) inset; animation: breathe 3.4s ease-in-out infinite; transition: box-shadow .3s ease; }
        .hub.active .hub-core { box-shadow: 0 0 54px 10px rgba(120,150,255,.65), 0 0 0 1px rgba(255,255,255,.2) inset; }
        @keyframes breathe { 0%,100% { transform: scale(1); } 50% { transform: scale(1.06); } }
        .hub-label { position: absolute; top: 100%; left: 50%; transform: translateX(-50%); margin-top: 8px; font-size: 10px; font-weight: 800; letter-spacing: .1em; color: #9aa2ba; white-space: nowrap; text-align: center; }
        .hub-sub { font-size: 9px; color: #565e78; font-weight: 600; display: block; margin-top: 1px; }
        .platform-wrap { position: absolute; z-index: 4; transform: translate(-50%,-50%); }
        .pod-bob { animation: bob 4.4s ease-in-out infinite; }
        @keyframes bob { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-3px); } }
        .pod { position: relative; cursor: pointer; background: linear-gradient(180deg, rgba(255,255,255,.05), rgba(255,255,255,.015)), #12151f; border: 1px solid var(--accent-dim, rgba(255,255,255,.12)); border-radius: 14px; padding: 10px 12px 9px; min-width: 100px; max-width: 210px; box-shadow: 0 18px 34px -16px rgba(0,0,0,.7), 0 0 0 1px rgba(0,0,0,.3) inset; transition: filter .2s ease, transform .2s ease, box-shadow .3s ease; }
        .pod::before { content: ''; position: absolute; top: 0; left: 12px; right: 12px; height: 3px; background: var(--accent, #7aa6ff); border-radius: 0 0 3px 3px; opacity: .9; }
        .pod::after { content: ''; position: absolute; inset: -5px; border-radius: 18px; border: 1.5px solid var(--accent, #7aa6ff); opacity: 0; pointer-events: none; }
        .platform-wrap.has-active .pod::after { opacity: .55; animation: activering 1.6s ease-in-out infinite; }
        @keyframes activering { 0%,100% { opacity: .25; } 50% { opacity: .85; } }
        .platform-wrap.selected .pod { filter: brightness(1.22); }
        .platform-wrap:hover .pod { filter: brightness(1.15); }
        .pod-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin-bottom: 9px; padding-top: 2px; }
        .pod-team { font-size: 10px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; color: var(--accent, #7aa6ff); white-space: nowrap; }
        .pod-count { font-size: 10.5px; font-weight: 700; color: #9aa2ba; }
        .desks { display: flex; flex-wrap: wrap; gap: 12px 10px; justify-content: center; max-width: 186px; }
        .desk { position: relative; width: 34px; display: flex; flex-direction: column; align-items: center; }
        .desk .worker { font-size: 21px; line-height: 1; filter: drop-shadow(0 2px 3px rgba(0,0,0,.55)); transition: transform .18s ease; }
        .desk:hover .worker { transform: scale(1.18) translateY(-1px); }
        .desk .mat { width: 28px; height: 5px; border-radius: 3px; margin-top: 3px; background: var(--accent, #7aa6ff); opacity: .8; box-shadow: 0 3px 6px -1px rgba(0,0,0,.5); }
        .desk .light { position: absolute; top: -3px; right: 1px; width: 7px; height: 7px; border-radius: 50%; border: 1px solid rgba(0,0,0,.4); }
        .desk .light.green { background: #35e08a; box-shadow: 0 0 7px 1px #35e08a; animation: lightpulse 1.5s ease-in-out infinite; }
        @keyframes lightpulse { 0%,100% { opacity: 1; } 50% { opacity: .5; } }
        .desk .model-badge { position: absolute; top: -3px; left: 1px; width: 12px; height: 12px; border-radius: 4px; font-size: 8px; font-weight: 800; line-height: 12px; text-align: center; color: #0a0c14; border: 1px solid rgba(0,0,0,.35); box-shadow: 0 1px 3px rgba(0,0,0,.5); }
        .pod-idle { font-size: 10.5px; color: #565e78; text-align: center; padding: 4px 0 2px; }
        .pod-model-legend { font-size: 8.5px; color: #6d7690; margin-top: 6px; text-align: center; letter-spacing: .01em; }
        .model-chip { display: inline-flex; align-items: center; gap: 4px; font-size: 10px; font-weight: 700; padding: 1px 6px 1px 4px; border-radius: 999px; }
        .model-chip .sw { width: 8px; height: 8px; border-radius: 3px; display: inline-block; }
        .legend-bar { position: fixed; top: 16px; left: 50%; transform: translateX(-50%); z-index: 20; display: flex; gap: 10px; align-items: center; background: rgba(16,19,30,.85); border: 1px solid rgba(255,255,255,.08); border-radius: 999px; padding: 6px 14px; font-size: 10.5px; color: #9aa2ba; backdrop-filter: blur(8px); pointer-events: none; white-space: nowrap; }
        .desk-tip { position: fixed; z-index: 60; max-width: 230px; pointer-events: none; background: #f4f6fb; color: #191b22; font-size: 11.5px; line-height: 1.35; padding: 8px 11px; border-radius: 12px; border-bottom-left-radius: 3px; box-shadow: 0 12px 28px -10px rgba(0,0,0,.6); }
        .desk-tip b { display: block; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: #6b7080; margin-bottom: 3px; font-weight: 800; }
        .search-box { pointer-events: auto; background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.1); border-radius: 999px; padding: 5px 12px; font: inherit; font-size: 11.5px; color: #e7eaf3; width: 140px; transition: width .2s ease, background .2s ease; }
        .search-box::placeholder { color: #6d7690; }
        .search-box:focus { outline: none; width: 190px; background: rgba(255,255,255,.08); border-color: rgba(140,160,255,.4); }
        .work-panel { position: fixed; left: 16px; top: 64px; z-index: 22; width: 250px; max-height: calc(100vh - 100px); display: flex; flex-direction: column; background: rgba(11,13,20,.9); border: 1px solid rgba(255,255,255,.08); border-radius: 12px; backdrop-filter: blur(10px); box-shadow: 0 14px 30px -12px rgba(0,0,0,.6); transition: transform .22s ease; }
        .work-panel.collapsed { transform: translateX(calc(-100% + 34px)); }
        .work-panel-head { display: flex; align-items: center; justify-content: space-between; padding: 9px 12px; border-bottom: 1px solid rgba(255,255,255,.07); cursor: pointer; flex-shrink: 0; }
        .work-panel-head .t { font-size: 10px; font-weight: 800; letter-spacing: .08em; color: #9aa2ba; }
        .work-panel-head .n { font-size: 10px; font-weight: 800; color: #35e08a; background: rgba(53,224,138,.12); padding: 1px 7px; border-radius: 999px; }
        .work-panel-body { overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 6px; }
        .work-row { display: flex; flex-direction: column; gap: 2px; background: rgba(255,255,255,.035); border: 1px solid rgba(255,255,255,.06); border-left: 3px solid var(--accent, #7aa6ff); border-radius: 7px; padding: 6px 9px; cursor: pointer; transition: background .15s ease; }
        .work-row:hover { background: rgba(255,255,255,.07); }
        .work-row .role { font-size: 9.5px; font-weight: 800; letter-spacing: .04em; text-transform: uppercase; color: var(--accent, #7aa6ff); }
        .work-row .desc { font-size: 11px; color: #cfd6ea; line-height: 1.3; margin-top: 1px; }
        .work-row .meta { font-size: 9.5px; color: #565e78; margin-top: 2px; }
        .work-empty { color: #565e78; font-size: 11px; text-align: center; padding: 14px 8px; }
        .pipeline-tag { display: inline-flex; align-items: center; gap: 3px; font-size: 9px; font-weight: 700; color: #ffdd7a; background: rgba(255,221,122,.12); border: 1px solid rgba(255,221,122,.25); border-radius: 999px; padding: 1px 7px; margin-top: 3px; width: fit-content; }
        .drawer { position: fixed; top: 0; right: 0; bottom: 0; width: 340px; max-width: 90vw; z-index: 50; background: rgba(11,13,20,.97); border-left: 1px solid rgba(255,255,255,.08); backdrop-filter: blur(14px); display: flex; flex-direction: column; transform: translateX(100%); transition: transform .28s ease; }
        .drawer.open { transform: translateX(0); }
        .drawer-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; border-bottom: 1px solid rgba(255,255,255,.08); }
        .drawer-head .title { font-weight: 800; font-size: 13px; letter-spacing: .05em; }
        .drawer-head .sub { font-size: 10.5px; color: #6d7690; margin-top: 2px; }
        .drawer-close { background: none; border: none; color: #6d7690; font-size: 18px; cursor: pointer; padding: 2px 6px; }
        .drawer-body { flex: 1; overflow-y: auto; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }

        /* ================= SHARED (both layouts) ================= */
        .drawer-empty { color: #565e78; font-size: 12px; text-align: center; margin-top: 30px; }
        .drawer-stat-row { display: flex; gap: 8px; }
        .drawer-stat { flex: 1; background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.08); border-radius: 9px; padding: 8px 10px; }
        .drawer-stat .n { font-size: 17px; font-weight: 800; }
        .drawer-stat .l { font-size: 9.5px; color: #6d7690; text-transform: uppercase; letter-spacing: .05em; margin-top: 2px; }
        .agent-row { display: flex; align-items: center; gap: 9px; background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.08); border-radius: 9px; padding: 8px 10px; }
        .agent-row .status-dot { width: 7px; height: 7px; border-radius: 50%; background: #35e08a; box-shadow: 0 0 6px #35e08a; flex-shrink: 0; }
        .agent-row .info { flex: 1; min-width: 0; }
        .agent-row .id { font-size: 10.5px; font-family: ui-monospace, monospace; color: #9aa2ba; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .agent-row .stats { font-size: 10px; color: #565e78; margin-top: 1px; }
        .agent-row .stats.task { color: #9db2ff; margin-top: 2px; }
        .ticker { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%); display: flex; flex-direction: column-reverse; gap: 6px; z-index: 25; pointer-events: none; align-items: center; width: min(560px, 90vw); }
        .ticker-item { background: rgba(14,17,28,.92); border: 1px solid rgba(255,255,255,.1); border-radius: 999px; padding: 6px 14px; font-size: 11.5px; color: #cfd6ea; backdrop-filter: blur(8px); animation: tickerIn .35s ease; box-shadow: 0 8px 20px -8px rgba(0,0,0,.6); white-space: nowrap; }
        @keyframes tickerIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        @media (max-width: 700px) { .ticker { bottom: 12px; width: calc(100vw - 24px); } .ticker-item { white-space: normal; text-align: center; } }

        /* ================= MOBILE (vertical list) ================= */
        .m-wrap { min-height: 100vh; padding: 0 14px calc(90px + env(safe-area-inset-bottom,0px)); max-width: 560px; margin: 0 auto; }
        .m-header { position: sticky; top: 0; z-index: 20; background: rgba(6,7,10,.92); backdrop-filter: blur(10px); margin: 0 -14px; padding: calc(14px + env(safe-area-inset-top,0px)) 14px 12px; border-bottom: 1px solid rgba(255,255,255,.08); }
        .m-title-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
        .m-title { font-weight: 800; letter-spacing: .08em; font-size: 14px; display: flex; align-items: center; gap: 4px; white-space: nowrap; }
        .m-title span { color: #6d7690; font-weight: 600; }
        .m-status-row { display: flex; align-items: center; gap: 8px; margin-top: 10px; font-size: 11px; color: #9aa2ba; flex-wrap: wrap; }
        .m-search { margin-top: 10px; width: 100%; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.1); border-radius: 10px; padding: 10px 12px; font: inherit; font-size: 14px; color: #e7eaf3; }
        .m-search::placeholder { color: #6d7690; }
        .m-body { padding-top: 14px; }
        .m-hub-card { width: 100%; display: flex; align-items: center; gap: 12px; background: linear-gradient(135deg, rgba(120,150,255,.16), rgba(80,60,180,.08)); border: 1px solid rgba(140,160,255,.32); border-radius: 14px; padding: 14px 16px; margin-bottom: 16px; text-align: left; color: inherit; font: inherit; }
        .m-hub-orb { width: 40px; height: 40px; border-radius: 50%; flex-shrink: 0; background: radial-gradient(circle at 35% 30%, #9db2ff, #4b5bd6 55%, #222a5c 100%); box-shadow: 0 0 22px 4px rgba(90,110,255,.5); animation: breathe 3.4s ease-in-out infinite; }
        .m-hub-text { min-width: 0; }
        .m-hub-text b { display: block; font-size: 13.5px; letter-spacing: .06em; }
        .m-hub-text span { font-size: 11.5px; color: #9aa2ba; }
        .m-section-title { font-size: 10px; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; color: #6d7690; margin: 2px 2px 8px; }
        .m-work-row { background: rgba(255,255,255,.045); border: 1px solid rgba(255,255,255,.08); border-left: 3px solid var(--accent,#7aa6ff); border-radius: 10px; padding: 11px 13px; margin-bottom: 8px; width: 100%; text-align: left; color: inherit; font: inherit; }
        .m-work-row .role { font-size: 10px; font-weight: 800; letter-spacing: .05em; text-transform: uppercase; color: var(--accent,#7aa6ff); }
        .m-work-row .desc { font-size: 13px; color: #cfd6ea; margin-top: 3px; line-height: 1.35; }
        .m-work-row .meta { font-size: 10.5px; color: #565e78; margin-top: 6px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
        .m-role-list { display: flex; flex-direction: column; gap: 8px; margin-bottom: 8px; }
        .m-role-row { display: flex; align-items: center; gap: 12px; width: 100%; text-align: left; background: rgba(255,255,255,.035); border: 1px solid rgba(255,255,255,.08); border-radius: 12px; padding: 13px 14px; color: inherit; font: inherit; }
        .m-role-row.has-active { border-color: var(--accent); background: rgba(255,255,255,.065); }
        .m-role-row.is-boss { border-color: rgba(255,215,0,.4); }
        .m-desk { position: relative; width: 36px; height: 36px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; background: rgba(255,255,255,.04); border-radius: 10px; }
        .m-desk .worker { font-size: 20px; line-height: 1; filter: drop-shadow(0 1px 2px rgba(0,0,0,.5)); }
        .m-desk .light { position: absolute; top: -2px; right: -2px; width: 10px; height: 10px; border-radius: 50%; border: 2px solid #0d0f16; }
        .m-desk .light.green { background: #35e08a; box-shadow: 0 0 7px 1px #35e08a; animation: lightpulse 1.5s ease-in-out infinite; }
        .m-desk .light.red { background: #6b2f38; }
        .m-role-main { flex: 1; min-width: 0; }
        .m-role-name { font-size: 14px; font-weight: 700; display: flex; align-items: center; gap: 6px; }
        .m-role-sub { font-size: 11.5px; color: #6d7690; margin-top: 2px; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .m-role-badges { display: flex; gap: 4px; flex-shrink: 0; }
        .m-chev { color: #565e78; font-size: 20px; flex-shrink: 0; line-height: 1; }
        .m-legend { display: flex; gap: 8px; overflow-x: auto; margin: 14px 0 16px; padding-bottom: 2px; -webkit-overflow-scrolling: touch; }
        .m-legend::-webkit-scrollbar { display: none; }
        .m-footer-note { text-align: center; font-size: 10.5px; color: #565e78; margin-top: 18px; line-height: 1.5; }

        .m-sheet-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.55); z-index: 60; opacity: 0; pointer-events: none; transition: opacity .2s ease; }
        .m-sheet-backdrop.open { opacity: 1; pointer-events: auto; }
        .m-sheet { position: fixed; left: 0; right: 0; bottom: 0; z-index: 61; max-height: 80vh; background: #0d0f16; border-top-left-radius: 18px; border-top-right-radius: 18px; border: 1px solid rgba(255,255,255,.1); border-bottom: none; transform: translateY(100%); transition: transform .28s ease; display: flex; flex-direction: column; box-shadow: 0 -20px 50px -20px rgba(0,0,0,.7); }
        .m-sheet.open { transform: translateY(0); }
        .m-sheet-handle { width: 36px; height: 4px; border-radius: 2px; background: rgba(255,255,255,.22); margin: 10px auto 2px; flex-shrink: 0; }
        .m-sheet-head { display: flex; align-items: center; justify-content: space-between; padding: 10px 18px 12px; border-bottom: 1px solid rgba(255,255,255,.08); flex-shrink: 0; }
        .m-sheet-head .title { font-weight: 800; font-size: 14px; letter-spacing: .04em; }
        .m-sheet-head .sub { font-size: 11px; color: #6d7690; margin-top: 2px; }
        .m-sheet-close { background: rgba(255,255,255,.06); border: none; color: #9aa2ba; font-size: 18px; width: 30px; height: 30px; border-radius: 999px; cursor: pointer; flex-shrink: 0; }
        .m-sheet-body { flex: 1; overflow-y: auto; padding: 14px 18px calc(20px + env(safe-area-inset-bottom,0px)); display: flex; flex-direction: column; gap: 10px; -webkit-overflow-scrolling: touch; }
      `}</style>

      <div className="office-root">
        {/* ================= DESKTOP VIEW ================= */}
        <div className="desktop-view">
          <div className="office">
            <header className="office-header">
              <div className="brand"><span className="live" />RUFLO <span>OFFICE</span></div>
              <div className="conn-row">
                <span className={`conn-chip ${connected ? "on" : "off"}`}><span className="dot" />supabase</span>
                <input
                  className="search-box"
                  placeholder="Filter role…"
                  value={filterText}
                  onChange={(e) => setFilterText(e.target.value)}
                />
              </div>
            </header>

            <div className="legend-bar">
              Model tier:
              {Object.entries(MODEL_META).map(([key, m]) => (
                <span key={key} className="model-chip" style={{ background: `${m.color}22`, color: m.color }}>
                  <span className="sw" style={{ background: m.color }} />{m.badge}={m.label}
                </span>
              ))}
              <span style={{ color: "#565e78" }}>— switches automatically by task complexity</span>
            </div>

            <div className={`work-panel ${collapsed ? "collapsed" : ""}`}>
              <div className="work-panel-head" onClick={() => setCollapsed((c) => !c)}>
                <span className="t">WHO'S WORKING ON WHAT</span>
                <span className="n">{activeEntries.length}</span>
              </div>
              <div className="work-panel-body">
                {activeEntries.length === 0 ? (
                  <div className="work-empty">Nobody is working right now.</div>
                ) : (
                  [...activeEntries]
                    .sort((a, b) => (a.role === "boss" ? -1 : b.role === "boss" ? 1 : 0))
                    .map((r) => {
                      const accent = accentByType.get(r.role) ?? "#7aa6ff";
                      const roleLabel = r.role === "boss" ? "👑 boss" : (ROLE_LABEL[r.role] ?? r.role);
                      const tag = pipelineTag(r);
                      return (
                        <div
                          key={r.id}
                          className="work-row"
                          style={{ ["--accent" as string]: accent }}
                          onClick={() => setSelected({ kind: "group", type: r.role })}
                        >
                          <span className="role">{roleLabel}</span>
                          <span className="desc">{r.description ?? "(no description)"}</span>
                          {tag && <span className="pipeline-tag">{tag}</span>}
                          <span className="meta">{timeAgo(r.started_at)}</span>
                        </div>
                      );
                    })
                )}
              </div>
            </div>

            <div className="stage">
              <div className="floor" />
              <svg className="wires" viewBox="0 0 100 100" preserveAspectRatio="none">
                {groupList.map(([role, list], i) => {
                  const pos = posFor(i, groupList.length);
                  const hasActive = list.some((r) => !r.is_placeholder);
                  const wireId = `wire-${role}`;
                  return (
                    <g key={role}>
                      <path id={wireId} className={`wire ${hasActive ? "hot" : ""}`} d={svgLine(pos.left, pos.top, 50, 50)} />
                      {hasActive && (
                        <circle r=".7" className="pulse">
                          <animateMotion dur={`${2.2 + (i % 3) * 0.4}s`} repeatCount="indefinite">
                            <mpath xlinkHref={`#${wireId}`} />
                          </animateMotion>
                        </circle>
                      )}
                    </g>
                  );
                })}
              </svg>

              <div className={`hub ${anyActive ? "active" : ""}`} onClick={() => { setSelected({ kind: "hub" }); setRingPulse((p) => p + 1); }}>
                <div key={ringPulse} className={ringPulse ? "hub-ring pulsing" : "hub-ring"} />
                <div className="hub-core" />
                <div className="hub-label">SWARM<span className="hub-sub">{activeEntries.length} active · {ROLE_ORDER.length} roles</span></div>
              </div>

              {groupList.map(([role, list], i) => {
                const pos = posFor(i, groupList.length);
                const accent = accentByType.get(role) ?? PALETTE[i % PALETTE.length];
                const active = list.filter((r) => !r.is_placeholder);
                const hasActive = active.length > 0;
                const isSelected = selected?.kind === "group" && selected.type === role;
                const modelCounts = new Map<string, number>();
                for (const r of active) {
                  const m = r.model ? MODEL_META[r.model] : undefined;
                  if (m) modelCounts.set(m.label, (modelCounts.get(m.label) ?? 0) + 1);
                }
                const modelSummary = [...modelCounts.entries()].map(([label, n]) => `${n} ${label}`).join(" · ");

                return (
                  <div
                    key={role}
                    className={`platform-wrap ${hasActive ? "has-active" : ""} ${isSelected ? "selected" : ""}`}
                    style={{ top: `${pos.top}%`, left: `${pos.left}%` }}
                    onClick={() => setSelected({ kind: "group", type: role })}
                  >
                    <div className="pod-bob">
                      <div className="pod" style={{ ["--accent" as string]: accent, ["--accent-dim" as string]: `${accent}33` }}>
                        <div className="pod-head">
                          <span className="pod-team">{ROLE_LABEL[role] ?? role}</span>
                          <span className="pod-count">{active.length}</span>
                        </div>
                        {active.length === 0 ? (
                          <div className="pod-idle">idle</div>
                        ) : (
                          <div className="desks">
                            {active.map((r) => {
                              const m = r.model ? MODEL_META[r.model] : undefined;
                              const workerIcon = role === "boss" ? "👑" : "🧑‍💻";
                              return (
                                <div
                                  key={r.id}
                                  className="desk"
                                  onMouseEnter={(e) => {
                                    const modelLine = m
                                      ? `<div style="margin-top:4px;color:#565e78">${m.label} (${m.tier}) — ${ROUTED_BY_LABEL[r.model_routed_by ?? ""] ?? "routing unknown"}</div>`
                                      : "";
                                    const tag = pipelineTag(r);
                                    setTip({
                                      x: e.clientX + 14,
                                      y: e.clientY + 14,
                                      html: `<b>${ROLE_LABEL[role] ?? role} · ${r.id.slice(0, 18)}</b>${r.description ?? "(no description)"}${modelLine}${tag ? `<div style="margin-top:4px">${tag}</div>` : ""}`,
                                    });
                                  }}
                                  onMouseMove={(e) => setTip((t) => (t ? { ...t, x: e.clientX + 14, y: e.clientY + 14 } : t))}
                                  onMouseLeave={() => setTip(null)}
                                >
                                  <span className="light green" />
                                  {m && (
                                    <span className="model-badge" style={{ background: m.color }} title={`${m.label} · ${m.tier}`}>
                                      {m.badge}
                                    </span>
                                  )}
                                  <span className="worker">{workerIcon}</span>
                                  <div className="mat" />
                                </div>
                              );
                            })}
                          </div>
                        )}
                        {role === "boss" && <div className="pod-model-legend" style={{ color: "#ffd700cc" }}>the primary session, not a dispatched role</div>}
                        {modelSummary && <div className="pod-model-legend">{modelSummary}</div>}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className={`drawer ${selected ? "open" : ""}`}>
              <div className="drawer-head">
                <div>
                  {selectedTitle && <div className="title">{selectedTitle}</div>}
                  {selectedSub && <div className="sub">{selectedSub}</div>}
                </div>
                <button className="drawer-close" onClick={() => setSelected(null)}>&times;</button>
              </div>
              <div className="drawer-body">{selectedBody}</div>
            </div>
          </div>
        </div>

        {/* ================= MOBILE VIEW ================= */}
        <div className="mobile-view">
          <div className="m-wrap">
            <div className="m-header">
              <div className="m-title-row">
                <div className="m-title">RUFLO <span>OFFICE</span></div>
                <span className={`conn-chip ${connected ? "on" : "off"}`}><span className="dot" />supabase</span>
              </div>
              <div className="m-status-row">
                <span className={`m-role-dot ${anyActive ? "" : ""}`} style={{ background: anyActive ? "#35e08a" : "#4a5170", width: 6, height: 6 }} />
                {activeEntries.length} active · {ROLE_ORDER.length} roles
              </div>
              <input
                className="m-search"
                placeholder="Filter role…"
                value={filterText}
                onChange={(e) => setFilterText(e.target.value)}
              />
            </div>

            <div className="m-body">
              <button className="m-hub-card" onClick={() => setSelected({ kind: "hub" })}>
                <div className="m-hub-orb" />
                <div className="m-hub-text">
                  <b>SWARM CORE</b>
                  <span>{activeEntries.length} active · {activePipelines.length} pipeline{activePipelines.length === 1 ? "" : "s"} running</span>
                </div>
              </button>

              {activeEntries.length > 0 && (
                <>
                  <div className="m-section-title">Working now</div>
                  {[...activeEntries]
                    .sort((a, b) => (a.role === "boss" ? -1 : b.role === "boss" ? 1 : 0))
                    .map((r) => {
                      const accent = accentByType.get(r.role) ?? "#7aa6ff";
                      const roleLabel = r.role === "boss" ? "👑 boss" : (ROLE_LABEL[r.role] ?? r.role);
                      const m = r.model ? MODEL_META[r.model] : undefined;
                      const tag = pipelineTag(r);
                      return (
                        <button
                          key={r.id}
                          className="m-work-row"
                          style={{ ["--accent" as string]: accent }}
                          onClick={() => setSelected({ kind: "group", type: r.role })}
                        >
                          <span className="role">{roleLabel}</span>
                          <div className="desc">{r.description ?? "(no description)"}</div>
                          <div className="meta">
                            <span>{timeAgo(r.started_at)}</span>
                            {m && (
                              <span className="model-chip" style={{ background: `${m.color}22`, color: m.color }}>
                                <span className="sw" style={{ background: m.color }} />{m.label}
                              </span>
                            )}
                            {tag && <span className="pipeline-tag" style={{ marginTop: 0 }}>{tag}</span>}
                          </div>
                        </button>
                      );
                    })}
                </>
              )}

              <div className="m-section-title">All roles</div>
              <div className="m-role-list">
                {groupList.map(([role, list]) => {
                  const accent = accentByType.get(role) ?? "#7aa6ff";
                  const active = list.filter((r) => !r.is_placeholder);
                  const hasActive = active.length > 0;
                  const primary = active[0];
                  const sub = hasActive
                    ? (primary?.description ?? "working")
                    : "idle";
                  return (
                    <button
                      key={role}
                      className={`m-role-row ${hasActive ? "has-active" : ""} ${role === "boss" ? "is-boss" : ""}`}
                      style={{ ["--accent" as string]: accent }}
                      onClick={() => setSelected({ kind: "group", type: role })}
                    >
                      <span className="m-desk">
                        <span className="worker">{role === "boss" ? "👑" : "🧑‍💻"}</span>
                        <span className={`light ${hasActive ? "green" : "red"}`} />
                      </span>
                      <div className="m-role-main">
                        <span className="m-role-name">{ROLE_LABEL[role] ?? role}</span>
                        <span className="m-role-sub">{sub}</span>
                      </div>
                      {hasActive && (
                        <div className="m-role-badges">
                          {active.slice(0, 3).map((r) => {
                            const m = r.model ? MODEL_META[r.model] : undefined;
                            if (!m) return null;
                            return (
                              <span key={r.id} className="model-chip" style={{ background: `${m.color}22`, color: m.color, padding: "1px 5px" }}>
                                {m.badge}
                              </span>
                            );
                          })}
                        </div>
                      )}
                      <span className="m-chev">›</span>
                    </button>
                  );
                })}
              </div>

              <div className="m-legend">
                {Object.entries(MODEL_META).map(([key, m]) => (
                  <span key={key} className="model-chip" style={{ background: `${m.color}22`, color: m.color, flexShrink: 0 }}>
                    <span className="sw" style={{ background: m.color }} />{m.badge}={m.label}
                  </span>
                ))}
              </div>

              <div className="m-footer-note">Monitoring only — nothing here can spawn or control an agent.<br />State lives in Supabase, not on any one machine.</div>
            </div>
          </div>

          <div className={`m-sheet-backdrop ${selected ? "open" : ""}`} onClick={() => setSelected(null)} />
          <div className={`m-sheet ${selected ? "open" : ""}`}>
            <div className="m-sheet-handle" />
            <div className="m-sheet-head">
              <div>
                {selectedTitle && <div className="title">{selectedTitle}</div>}
                {selectedSub && <div className="sub">{selectedSub}</div>}
              </div>
              <button className="m-sheet-close" onClick={() => setSelected(null)}>&times;</button>
            </div>
            <div className="m-sheet-body">{selectedBody}</div>
          </div>
        </div>

        <div className="ticker">
          {ticker.map((t) => <div key={t.id} className="ticker-item">{t.text}</div>)}
        </div>

        {tip && (
          <div className="desk-tip" style={{ left: tip.x, top: tip.y }} dangerouslySetInnerHTML={{ __html: tip.html }} />
        )}

        {error && (
          <div style={{ position: "fixed", bottom: 16, right: 16, left: 16, maxWidth: 320, marginInline: "auto", background: "rgba(224,67,92,.15)", border: "1px solid rgba(224,67,92,.4)", color: "#ff9fae", padding: "8px 14px", borderRadius: 10, fontSize: 11.5, zIndex: 30 }}>
            {error}
          </div>
        )}
      </div>
    </>
  );
}
