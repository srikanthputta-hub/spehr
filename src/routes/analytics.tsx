import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { BoardHeader } from "@/components/BoardShell";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { Activity, Users, LogOut as LogOutIcon, Loader2, Search } from "lucide-react";
import { PopulationHealth } from "@/components/admin/PopulationHealth";
import { fetchWithTimeout } from "@/lib/async-timeout";
import CohortCountsStrip from "@/components/analytics/CohortCountsStrip";
import { InfoHint } from "@/components/ui/info-hint";

export const Route = createFileRoute("/analytics")({
  component: AnalyticsPage,
});

type Patient = {
  id: string;
  mrn: string | null;
  name: string | null;
  first_name: string | null;
  last_name: string | null;
  status: string | null;
  facility_name: string | null;
  chief_complaint: string | null;
  admission_time: string | null;
};

const FACILITIES = [
  "Memorial Hospital",
  "St. Jude Medical Center",
  "City General Infirmary",
  "County Health Pavilion",
  "Srik Health Clinic",
];

function fmtTs(ts: string | null) {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const yy = String(d.getFullYear()).slice(-2);
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}/${dd}/${yy} ${hh}:${mi}`;
}

function fullName(p: Patient) {
  return (
    p.name ||
    [p.first_name, p.last_name].filter(Boolean).join(" ") ||
    "Unknown"
  );
}

export function AnalyticsPage({ embedded = false }: { embedded?: boolean } = {}) {
  const [patients, setPatients] = useState<Patient[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");

  const load = async () => {
    const { data, error } = await fetchWithTimeout(
      () =>
        supabase
          .from("patients")
          .select(
            "id, mrn, name, first_name, last_name, status, facility_name, chief_complaint, admission_time",
          )
          .order("admission_time", { ascending: false }),
      { data: [], error: null } as any,
    );
    if (error) setError(error.message);
    else setPatients((data as Patient[]) ?? []);
    setLoading(false);
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, []);

  const totals = useMemo(() => {
    let admitted = 0;
    let discharged = 0;
    for (const p of patients) {
      if (p.status === "Admitted") admitted++;
      else if (p.status === "Discharged") discharged++;
    }
    return { total: patients.length, admitted, discharged };
  }, [patients]);

  const chartData = useMemo(() => {
    const map = new Map<string, number>();
    for (const f of FACILITIES) map.set(f, 0);
    for (const p of patients) {
      if (p.status !== "Admitted") continue;
      const f = p.facility_name ?? "Unknown";
      map.set(f, (map.get(f) ?? 0) + 1);
    }
    return Array.from(map.entries()).map(([facility, count]) => ({
      facility: facility.replace(" Hospital", " Hosp.").replace(" Medical Center", " Med."),
      full: facility,
      count,
    }));
  }, [patients]);

  const feed = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    let rows = patients.slice(0, 150);
    if (term) {
      rows = rows.filter((p) => {
        const name = fullName(p).toLowerCase();
        const mrn = (p.mrn ?? "").toLowerCase();
        const complaint = (p.chief_complaint ?? "").toLowerCase();
        const facility = (p.facility_name ?? "").toLowerCase();
        return (
          name.includes(term) ||
          mrn.includes(term) ||
          complaint.includes(term) ||
          facility.includes(term)
        );
      });
    }
    return rows;
  }, [patients, searchTerm]);

  const Wrapper: any = embedded ? "div" : "main";
  return (
    <Wrapper className={embedded ? "bg-slate-50" : "min-h-screen bg-slate-50"}>
      {!embedded && (
        <BoardHeader
          title="Global Network Analytics"
          subtitle="Real-time admission, census, and facility load telemetry"
          badge="Analytics"
        />
      )}

      <section className={`${embedded ? "w-full" : "max-w-7xl"} mx-auto px-6 py-6 space-y-6`}>
        <CohortCountsStrip />
        <div className="flex items-center justify-between">
          <h1 className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-500">
            📊 Network Operations Overview
          </h1>
          <Link to="/nursing-board" className="text-xs text-slate-500 hover:text-slate-900 underline-offset-2 hover:underline">
            ← Back to Floor Board
          </Link>
        </div>

        {/* KPI Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <KpiCard
            label="Total Network Admissions"
            sub="All time"
            value={totals.total}
            icon={<Users className="h-4 w-4" />}
            tone="navy"
            info="Cumulative count of every row in the patients table across all 5 facilities — INCLUDES already-discharged patients. This is not the current census. Rows are retained ~48h before TTL garbage collection removes them."
          />
          <KpiCard
            label="Currently Active Census"
            sub="Status = Admitted"
            value={totals.admitted}
            icon={<Activity className="h-4 w-4" />}
            tone="emerald"
            info={`Global network-wide count of patients where status = "Admitted" across all 5 facilities — unlike the nursing/admin boards, this is not scoped to any one facility.`}
          />
          <KpiCard
            label="Discharges · Last 48h"
            sub="Rolling window"
            value={totals.discharged}
            icon={<LogOutIcon className="h-4 w-4" />}
            tone="slate"
            info="Network-wide count of patients currently sitting in the patients table with status = Discharged. This is a ROLLING 48-HOUR WINDOW, not an all-time cumulative total — the TTL garbage-collection sweep deletes discharged rows once they age past ~48h, so the number decrements as older discharges are pruned."
          />
        </div>

        {/* Chart */}
        <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                Facility Load
              </div>
              <div className="text-sm font-semibold text-slate-900">
                Active Census by Facility
              </div>
            </div>
            <div className="text-[11px] text-slate-500 font-mono">
              {loading ? "loading…" : `${totals.admitted} active`}
            </div>
          </div>
          <div className="h-72 px-3 py-4">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 10, right: 20, left: 0, bottom: 10 }}>
                <CartesianGrid strokeDasharray="2 3" stroke="#e2e8f0" vertical={false} />
                <XAxis
                  dataKey="facility"
                  tick={{ fontSize: 11, fill: "#475569" }}
                  axisLine={{ stroke: "#cbd5e1" }}
                  tickLine={false}
                />
                <YAxis
                  allowDecimals={false}
                  tick={{ fontSize: 11, fill: "#475569" }}
                  axisLine={{ stroke: "#cbd5e1" }}
                  tickLine={false}
                />
                <Tooltip
                  cursor={{ fill: "rgba(13,148,136,0.06)" }}
                  contentStyle={{
                    fontSize: 12,
                    borderRadius: 6,
                    border: "1px solid #cbd5e1",
                    boxShadow: "0 4px 12px rgba(15,23,42,0.08)",
                  }}
                  labelFormatter={(_, payload) =>
                    payload && payload[0] ? (payload[0].payload as any).full : ""
                  }
                  formatter={(v: number) => [v, "Active"]}
                />
                <Bar dataKey="count" fill="#0d9488" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <PopulationHealth />

        {/* Live Feed */}
        <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                Live Feed
              </div>
              <div className="text-sm font-semibold text-slate-900">
                Global Real-Time Admissions
              </div>
            </div>
            <div className="flex items-center gap-2 text-[11px] text-slate-500">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
              </span>
              Updating every 10s
            </div>
          </div>
          <div className="px-5 py-3 border-b border-slate-100">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Search by patient, MRN, complaint, or facility…"
                className="w-full rounded-md border border-slate-300 bg-white pl-9 pr-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-slate-400"
              />
            </div>
          </div>
          <div className="max-h-[480px] overflow-auto">
            <table className="w-full text-[12px]">
              <thead className="bg-slate-50 text-[10px] uppercase tracking-[0.14em] text-slate-500 sticky top-0">
                <tr className="border-b border-slate-200">
                  <th className="text-left px-4 py-2 font-semibold">Timestamp</th>
                  <th className="text-left px-4 py-2 font-semibold">MRN</th>
                  <th className="text-left px-4 py-2 font-semibold">Patient</th>
                  <th className="text-left px-4 py-2 font-semibold">Chief Complaint</th>
                  <th className="text-left px-4 py-2 font-semibold">Facility</th>
                  <th className="text-left px-4 py-2 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {loading && feed.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-10 text-center text-slate-500">
                      <Loader2 className="inline h-4 w-4 animate-spin mr-2" />
                      Loading network feed…
                    </td>
                  </tr>
                )}
                {error && (
                  <tr>
                    <td colSpan={6} className="px-4 py-6 text-center text-rose-600">
                      {error}
                    </td>
                  </tr>
                )}
                {!loading && feed.length === 0 && !error && (
                  <tr>
                    <td colSpan={6} className="px-4 py-10 text-center text-slate-500">
                      No recent admissions.
                    </td>
                  </tr>
                )}
                {feed.map((p) => (
                  <tr key={p.id} className="hover:bg-slate-50">
                    <td className="px-4 py-2 font-mono text-slate-600 whitespace-nowrap">
                      {fmtTs(p.admission_time)}
                    </td>
                    <td className="px-4 py-2 font-mono text-slate-900">{p.mrn ?? "—"}</td>
                    <td className="px-4 py-2 text-slate-900">{fullName(p)}</td>
                    <td className="px-4 py-2 text-slate-700">{p.chief_complaint ?? "—"}</td>
                    <td className="px-4 py-2 text-slate-700">{p.facility_name ?? "—"}</td>
                    <td className="px-4 py-2">
                      <StatusPill status={p.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </Wrapper>
  );
}

function KpiCard({
  label,
  sub,
  value,
  icon,
  tone,
  info,
}: {
  label: string;
  sub: string;
  value: number;
  icon: React.ReactNode;
  tone: "navy" | "emerald" | "slate";
  info?: string;
}) {
  const tones: Record<string, string> = {
    navy: "bg-[#0c2340] text-white",
    emerald: "bg-emerald-500 text-white",
    slate: "bg-slate-200 text-slate-700",
  };
  return (
    <div className="rounded-lg border border-slate-200 bg-white shadow-sm px-5 py-4">
      <div className="flex items-start justify-between">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
            {label}
            {info && <InfoHint className="ml-1" text={info} />}
          </div>
          <div className="text-[10px] text-slate-400 mt-0.5">{sub}</div>
        </div>
        <div className={`grid place-items-center h-8 w-8 rounded-md ${tones[tone]}`}>
          {icon}
        </div>
      </div>
      <div className="mt-3 font-mono text-3xl font-semibold text-slate-900 tabular-nums">
        {value.toLocaleString()}
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: string | null }) {
  const s = status ?? "Unknown";
  const cls =
    s === "Admitted"
      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
      : s === "Discharged"
        ? "bg-slate-100 text-slate-600 border-slate-200"
        : "bg-amber-50 text-amber-700 border-amber-200";
  return (
    <span
      className={`inline-flex items-center rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${cls}`}
    >
      {s}
    </span>
  );
}
