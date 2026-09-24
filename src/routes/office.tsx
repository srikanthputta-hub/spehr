import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, useCallback } from "react";
import { createClient } from "@supabase/supabase-js";
import { Crown, Loader2 } from "lucide-react";

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

const ROLE_LABEL: Record<string, string> = {
  boss: "Boss",
  coder: "Software Engineer",
  reviewer: "Tech Lead / Reviewer",
  tester: "QA Engineer",
  architect: "Solutions Architect",
  devops: "DevOps / SRE",
  "data-engineer": "Data Engineer",
  "product-manager": "Product Manager",
  "ux-designer": "UX / UI Designer",
  "clinical-informaticist": "Clinical Informaticist",
  "security-auditor": "Security Auditor",
  analyst: "Business Analyst",
  researcher: "Researcher",
};

const MODEL_BADGE: Record<string, { label: string; className: string }> = {
  haiku: { label: "H", className: "bg-sky-500/20 text-sky-300 border-sky-500/40" },
  sonnet: { label: "S", className: "bg-teal-500/20 text-teal-300 border-teal-500/40" },
  opus: { label: "O", className: "bg-fuchsia-500/20 text-fuchsia-300 border-fuchsia-500/40" },
};

function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h`;
}

function OfficePage() {
  const [rows, setRows] = useState<BoardRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchBoard = useCallback(async () => {
    if (!officeClient) {
      setError("Supabase client not configured for this deploy.");
      setLoading(false);
      return;
    }
    const { data, error: err } = await officeClient
      .from("office_board")
      .select("*")
      .order("started_at", { ascending: true });
    if (err) {
      setError(err.message);
    } else {
      setError(null);
      setRows((data ?? []) as BoardRow[]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchBoard();
    const poll = setInterval(fetchBoard, 4000);
    return () => clearInterval(poll);
  }, [fetchBoard]);

  const roleOrder = [
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

  const byRole = new Map<string, BoardRow[]>();
  for (const row of rows) {
    const list = byRole.get(row.role) ?? [];
    list.push(row);
    byRole.set(row.role, list);
  }

  const activeCount = rows.filter((r) => !r.is_placeholder).length;

  return (
    <main className="min-h-screen bg-[#05080f] text-white">
      <header className="border-b border-white/10 px-6 py-5 flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.25em] text-teal-400/80">S.P.E.H.R. · RuFlo</div>
          <h1 className="text-xl font-semibold">Office</h1>
        </div>
        <div className="flex items-center gap-3 text-xs text-white/60">
          <span className="inline-flex items-center gap-1.5">
            <span className={`h-1.5 w-1.5 rounded-full ${activeCount > 0 ? "bg-emerald-400 animate-pulse" : "bg-white/30"}`} />
            {activeCount} active
          </span>
          <span>·</span>
          <span>live, shared across every session — PC or cloud</span>
          {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        </div>
      </header>

      {error && (
        <div className="mx-6 mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          {error}
        </div>
      )}

      <section className="p-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {roleOrder.map((role) => {
          const entries = byRole.get(role) ?? [];
          const active = entries.filter((e) => !e.is_placeholder);
          const placeholder = entries.find((e) => e.is_placeholder);
          const isBoss = role === "boss";

          if (active.length === 0) {
            return (
              <div
                key={role}
                className={`rounded-xl border px-4 py-4 ${
                  isBoss
                    ? "border-amber-400/30 bg-amber-400/[0.04]"
                    : "border-white/10 bg-white/[0.02]"
                }`}
              >
                <div className="flex items-center gap-2">
                  {isBoss && <Crown className="h-3.5 w-3.5 text-amber-400" />}
                  <span className="text-sm font-medium text-white/80">{ROLE_LABEL[role] ?? role}</span>
                </div>
                <div className="mt-2 text-xs text-white/35">
                  {placeholder ? "idle" : "—"}
                </div>
              </div>
            );
          }

          return (
            <div key={role} className="contents">
              {active.map((entry) => {
                const badge = entry.model ? MODEL_BADGE[entry.model] : undefined;
                return (
                  <div
                    key={entry.id}
                    className={`rounded-xl border px-4 py-4 ${
                      isBoss
                        ? "border-amber-400/50 bg-amber-400/[0.08]"
                        : "border-teal-400/40 bg-teal-400/[0.06]"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        {isBoss && <Crown className="h-3.5 w-3.5 text-amber-400 shrink-0" />}
                        <span className="text-sm font-medium truncate">{ROLE_LABEL[role] ?? role}</span>
                      </div>
                      {badge && (
                        <span className={`shrink-0 text-[10px] font-mono px-1.5 py-0.5 rounded border ${badge.className}`}>
                          {badge.label}
                        </span>
                      )}
                    </div>
                    <p className="mt-2 text-xs text-white/70 leading-snug line-clamp-3">
                      {entry.description}
                    </p>
                    <div className="mt-3 flex items-center justify-between text-[10px] text-white/40">
                      <span className="inline-flex items-center gap-1">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                        {timeAgo(entry.started_at)} ago
                      </span>
                      {entry.pipeline_name && (
                        <span className="font-mono">
                          🔗 {entry.pipeline_name} {entry.pipeline_stage}/{entry.pipeline_total}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </section>

      <footer className="px-6 pb-8 text-[11px] text-white/30">
        Monitoring only — nothing on this page can spawn or control an agent. State lives in Supabase, not on any one machine.
      </footer>
    </main>
  );
}
