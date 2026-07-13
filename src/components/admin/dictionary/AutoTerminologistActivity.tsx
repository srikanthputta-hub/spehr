import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Bot, RefreshCw, CheckCircle2, AlertTriangle, Pause, Clock, Inbox, Archive, Copy } from "lucide-react";
import { Trash2, Download } from "lucide-react";
import { InfoHint } from "@/components/ui/info-hint";
import { toast } from "sonner";

type LogRow = {
  id: string;
  run_at: string;
  message: string;
  value_set_id: string | null;
  confidence: number | null;
  action: string | null;
  theme: string | null;
  codes_count: number | null;
};

function actionTone(action: string | null) {
  switch (action) {
    case "drafted_for_review":
      return { Icon: CheckCircle2, cls: "text-emerald-700 bg-emerald-50 border-emerald-200" };
    case "drafted":
      return { Icon: CheckCircle2, cls: "text-sky-700 bg-sky-50 border-sky-200" };
    case "requested":
      return { Icon: Clock, cls: "text-amber-700 bg-amber-50 border-amber-200" };
    case "touched":
      return { Icon: RefreshCw, cls: "text-slate-600 bg-slate-50 border-slate-200" };
    case "skipped":
      return { Icon: Pause, cls: "text-amber-700 bg-amber-50 border-amber-200" };
    case "no_gaps":
      return { Icon: CheckCircle2, cls: "text-slate-600 bg-slate-50 border-slate-200" };
    case "heartbeat":
      return { Icon: RefreshCw, cls: "text-slate-500 bg-slate-50 border-slate-200" };
    default:
      return { Icon: AlertTriangle, cls: "text-slate-600 bg-slate-50 border-slate-200" };
  }
}

function formatAgo(ts: string | undefined): string {
  if (!ts) return "never";
  const diffMs = Date.now() - new Date(ts).getTime();
  const mins = Math.max(0, Math.floor(diffMs / 60_000));
  if (mins < 1) return "just now";
  if (mins === 1) return "1 minute ago";
  if (mins < 60) return `${mins} minutes ago`;
  const hrs = Math.floor(mins / 60);
  return hrs === 1 ? "1 hour ago" : `${hrs} hours ago`;
}

type RequestRow = {
  id: string;
  requesting_consumer: string;
  requested_name: string;
  justification: string | null;
  priority: string | null;
  status: string | null;
  quality_gate_notes: string | null;
  requested_at: string;
  resolved_at: string | null;
  seed_codes?: any[] | null;
  vocabulary?: string | null;
  clinical_application?: string | null;
  request_type?: string | null;
  target_value_set_id?: string | null;
};

type DeprecationRow = {
  id: string;
  name: string;
  oid: string | null;
  vocabulary: string | null;
  change_history: any[] | null;
  updated_at?: string | null;
};

function latestChange(history: any[] | null): string | null {
  if (!Array.isArray(history) || history.length === 0) return null;
  // Assume history is chronological; last entry is most recent.
  const last = history[history.length - 1];
  return typeof last?.change === "string" ? last.change : null;
}

function statusBadge(status: string | null): string {
  const s = String(status ?? "pending").toLowerCase();
  if (s === "drafted") return "text-sky-700 bg-sky-50 border-sky-200";
  if (s === "umls-suggested") return "text-indigo-700 bg-indigo-50 border-indigo-200";
  if (s === "published") return "text-emerald-700 bg-emerald-50 border-emerald-200";
  if (s === "rejected") return "text-red-700 bg-red-50 border-red-200";
  return "text-amber-700 bg-amber-50 border-amber-200"; // pending
}

export function AutoTerminologistActivity() {
  const [rows, setRows] = useState<LogRow[]>([]);
  const [latest, setLatest] = useState<LogRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [nowTick, setNowTick] = useState(0);
  const [requests, setRequests] = useState<RequestRow[]>([]);
  const [requestQuery, setRequestQuery] = useState("");
  const [consumerFilter, setConsumerFilter] = useState<string>("All");
  const [draftedQuery, setDraftedQuery] = useState("");
  const [importingId, setImportingId] = useState<string | null>(null);
  const [deprecations, setDeprecations] = useState<DeprecationRow[]>([]);
  const [targetNames, setTargetNames] = useState<Record<string, string>>({});

  const importFromUmls = async (r: RequestRow) => {
    const codes = Array.isArray(r.seed_codes) ? r.seed_codes : [];
    if (codes.length === 0) {
      toast.error("No UMLS codes staged on this request");
      return;
    }
    setImportingId(r.id);
    try {
      const now = new Date().toISOString();
      const name = r.requested_name;
      const vocab = r.vocabulary || (codes[0] as any)?.vocabulary || "SNOMED CT";
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const { data: inserted, error: insertErr } = await supabase
        .from("custom_value_sets")
        .insert({
          name,
          system: String(vocab).replace(" ", "-"),
          vocabulary: vocab,
          type: "extensional",
          codes,
          status: "draft",
          description: `Imported from UMLS in response to terminology request from ${r.requesting_consumer}: ${r.justification ?? ""}`.trim(),
          clinical_application: r.clinical_application ?? null,
          fhir_url: `http://spehr.live/fhir/ValueSet/${slug}`,
          oid: `2.16.840.1.113883.3.spehr.${Date.now()}`,
          change_history: [{ at: now, actor: "S.P.E.H.R. Terminology Services", change: `Imported from UMLS (${codes.length} concepts) — ${vocab}` }],
        } as any)
        .select("id")
        .single();
      if (insertErr) throw insertErr;
      const valueSetId = (inserted as any)?.id;
      await supabase
        .from("terminology_requests" as any)
        .update({ status: "drafted", value_set_id: valueSetId, resolved_at: now, updated_at: now, quality_gate_notes: `Imported from UMLS (${codes.length} concepts).` } as any)
        .eq("id", r.id);
      await supabase.from("auto_terminologist_log" as any).insert({
        action: "drafted",
        message: `Imported '${name}' from UMLS (${codes.length} ${vocab} concepts) — status: draft — awaiting human review.`,
        theme: name,
        codes_count: codes.length,
        value_set_id: valueSetId,
      } as any);
      setRequests((rs) => rs.map((x) => x.id === r.id ? { ...x, status: "drafted", resolved_at: now } : x));
      toast.success(`Imported "${name}" from UMLS as draft value set`);
    } catch (e: any) {
      console.warn("[auto-term] UMLS import failed", e);
      toast.error(`Import failed: ${e?.message ?? e}`);
    } finally {
      setImportingId(null);
    }
  };

  const lastRunAt = useMemo(() => latest?.run_at, [latest]);

  const filteredRequests = useMemo(() => {
    const q = requestQuery.trim().toLowerCase();
    return requests.filter((r) => {
      if (consumerFilter !== "All" && r.requesting_consumer !== consumerFilter) return false;
      if (!q) return true;
      return (
        (r.requesting_consumer ?? "").toLowerCase().includes(q) ||
        (r.requested_name ?? "").toLowerCase().includes(q) ||
        (r.justification ?? "").toLowerCase().includes(q) ||
        (r.status ?? "").toLowerCase().includes(q)
      );
    });
  }, [requests, requestQuery, consumerFilter]);

  const consumerOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of requests) if (r.requesting_consumer) set.add(r.requesting_consumer);
    return ["All", ...Array.from(set).sort()];
  }, [requests]);

  const filteredDrafted = useMemo(() => {
    const q = draftedQuery.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      (r.message ?? "").toLowerCase().includes(q) ||
      (r.theme ?? "").toLowerCase().includes(q) ||
      (r.action ?? "").toLowerCase().includes(q),
    );
  }, [rows, draftedQuery]);
  // Recompute "X minutes ago" every 30s
  useEffect(() => {
    const id = setInterval(() => setNowTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  void nowTick;

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const [latestRes, draftedRes] = await Promise.all([
        supabase
          .from("auto_terminologist_log" as any)
          .select("id, run_at, message, value_set_id, confidence, action, theme, codes_count")
          .order("run_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from("auto_terminologist_log" as any)
          .select("id, run_at, message, value_set_id, confidence, action, theme, codes_count")
          .eq("action", "drafted")
          .order("run_at", { ascending: false })
          .limit(50),
      ]);
      if (!cancelled) {
        setLatest(((latestRes as any).data as any) ?? null);
        setRows(((draftedRes as any).data as any) ?? []);
        setLoading(false);
      }
    };
    load();
    const loadRequests = async () => {
      const { data } = await supabase
        .from("terminology_requests" as any)
        .select(
          "id, requesting_consumer, requested_name, justification, priority, status, quality_gate_notes, requested_at, resolved_at, seed_codes, vocabulary, clinical_application, request_type, target_value_set_id",
        )
        .order("requested_at", { ascending: false })
        .limit(50);
      if (!cancelled) setRequests(((data as any) ?? []) as RequestRow[]);
    };
    loadRequests();
    const loadDeprecations = async () => {
      const { data } = await supabase
        .from("custom_value_sets")
        .select("id, name, oid, vocabulary, change_history, updated_at")
        .eq("status", "deprecation-suggested")
        .order("updated_at", { ascending: false })
        .limit(50);
      if (!cancelled) setDeprecations(((data as any) ?? []) as DeprecationRow[]);
    };
    loadDeprecations();
    const ch = supabase
      .channel("auto-term-activity")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "auto_terminologist_log" },
        (payload) => {
          const row = payload.new as any as LogRow;
          setLatest(row);
          if (row.action === "drafted") {
            setRows((r) => [row, ...r].slice(0, 50));
          }
        },
      )
      .subscribe();
    const reqCh = supabase
      .channel("auto-term-requests")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "terminology_requests" },
        (payload) => {
          const row = payload.new as any as RequestRow;
          setRequests((r) => [row, ...r.filter((x) => x.id !== row.id)].slice(0, 50));
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "terminology_requests" },
        (payload) => {
          const row = payload.new as any as RequestRow;
          setRequests((r) => r.map((x) => (x.id === row.id ? row : x)));
        },
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "terminology_requests" },
        (payload) => {
          const oldRow = payload.old as any as { id?: string };
          if (oldRow?.id) setRequests((r) => r.filter((x) => x.id !== oldRow.id));
        },
      )
      .subscribe();
    const depCh = supabase
      .channel("auto-term-deprecations")
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "custom_value_sets" },
        (payload) => {
          const row = payload.new as any as DeprecationRow & { status?: string };
          const oldRow = payload.old as any as { id?: string; status?: string };
          if (row?.status === "deprecation-suggested") {
            setDeprecations((r) => [row, ...r.filter((x) => x.id !== row.id)].slice(0, 50));
          } else if (oldRow?.id && oldRow?.status === "deprecation-suggested") {
            setDeprecations((r) => r.filter((x) => x.id !== oldRow.id));
          }
        },
      )
      .subscribe();
    const id = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      supabase.removeChannel(ch);
      supabase.removeChannel(reqCh);
      supabase.removeChannel(depCh);
      clearInterval(id);
    };
  }, []);

  // Resolve target_value_set_id -> name for any deprecation-request rows in view.
  useEffect(() => {
    const ids = Array.from(
      new Set(
        requests
          .filter((r) => r.request_type === "deprecate" && r.target_value_set_id)
          .map((r) => r.target_value_set_id!)
          .filter((id) => !(id in targetNames)),
      ),
    );
    if (ids.length === 0) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("custom_value_sets")
        .select("id, name")
        .in("id", ids);
      if (cancelled || !data) return;
      setTargetNames((prev) => {
        const next = { ...prev };
        for (const row of data as any[]) next[row.id] = row.name;
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [requests, targetNames]);

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-[#0c2340]">
            <Bot className="h-5 w-5" />
            <h3 className="text-lg font-semibold">Auto Terminologist · Activity</h3>
            <InfoHint
              className="ml-1.5"
              text="Purely demand-driven agent — it only acts on governed change requests filed in terminology_requests by other SPEHR consumers, never scans patient data opportunistically. Before drafting anything new it runs a quality gate and checks the existing Value Set Library for an exact or near-duplicate match (merging into the existing entry when appropriate). It can also action deprecation-suggestion requests, flagging an existing published value set for a steward to retire. It never submits for review or publishes on its own — promoting a draft or deprecating a value set always requires a human action in the Value Set Library. Current requesting consumers: Auto Doc (clinical/CDS coverage gaps found per admission), Auto Admin (billing + population-health coverage gaps), and Safety Alerts Engine (medication/allergy safety value sets — by far the highest-volume consumer today)."
            />
          </div>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          Loop active · 10 min cadence
        </span>
      </div>

      {latest && (
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
          <span className="font-semibold text-slate-800">Last cycle:</span>{" "}
          {new Date(latest.run_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          {" "}({formatAgo(lastRunAt)}) — {latest.message}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-600">
        <span className="font-semibold uppercase tracking-wider text-slate-500">Consumers:</span>
        <span className="inline-flex items-center rounded-md border border-slate-200 bg-white px-2 py-0.5">
          <span className="font-semibold text-slate-700">Auto Doc</span>
          <span className="ml-1 text-slate-500">→ clinical gaps</span>
        </span>
        <span className="inline-flex items-center rounded-md border border-slate-200 bg-white px-2 py-0.5">
          <span className="font-semibold text-slate-700">Auto Admin</span>
          <span className="ml-1 text-slate-500">→ billing / population health (+ IT hand-off on infra failure)</span>
        </span>
        <span className="inline-flex items-center rounded-md border border-slate-200 bg-white px-2 py-0.5">
          <span className="font-semibold text-slate-700">Safety Alerts Engine</span>
          <span className="ml-1 text-slate-500">→ medication/allergy safety</span>
        </span>
      </div>

      <div className="flex items-center justify-between gap-3 pt-1">
        <div className="text-xs font-semibold uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
          <Inbox className="h-3.5 w-3.5" />
          Terminology Requests
        </div>
        <input
          type="text"
          placeholder="Search requests…"
          value={requestQuery}
          onChange={(e) => setRequestQuery(e.target.value)}
          className="h-7 w-56 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 placeholder:text-slate-400 focus:outline-none focus:border-slate-400"
        />
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {consumerOptions.map((c) => {
          const active = consumerFilter === c;
          return (
            <button
              key={c}
              type="button"
              onClick={() => setConsumerFilter(c)}
              className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-semibold transition-colors ${
                active
                  ? "border-[#0c2340] bg-[#0c2340] text-white"
                  : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
              }`}
            >
              {c}
            </button>
          );
        })}
      </div>
      <div className="scroll-feed rounded-lg border border-slate-200 divide-y divide-slate-100 bg-slate-50/40">
        {filteredRequests.length === 0 ? (
          <div className="px-4 py-6 text-sm text-slate-500">
            {requests.length === 0 ? "No terminology requests submitted yet." : "No matches for your search."}
          </div>
        ) : (
          filteredRequests.map((r) => {
            const time = new Date(r.requested_at).toLocaleString([], {
              month: "short",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
            });
            const isDeprecate = r.request_type === "deprecate";
            const targetName =
              isDeprecate && r.target_value_set_id ? targetNames[r.target_value_set_id] : null;
            return (
              <div key={r.id} className="flex items-start gap-3 px-4 py-3">
                <span className="mt-0.5 inline-flex items-center rounded-md border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-semibold text-slate-700">
                  {r.requesting_consumer}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    {isDeprecate ? (
                      <>
                        <span className="inline-flex items-center rounded-md border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
                          Deprecation Request
                        </span>
                        <p className="text-sm font-medium text-slate-800 leading-snug">
                          {targetName ? `Target: ${targetName}` : `Deprecation target label: ${r.requested_name}`}
                        </p>
                      </>
                    ) : (
                      <p className="text-sm font-medium text-slate-800 leading-snug">{r.requested_name}</p>
                    )}
                    <span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-semibold ${statusBadge(r.status)}`}>
                      {(r.status ?? "pending")}
                    </span>
                    {r.priority && r.priority !== "normal" && (
                      <span className="inline-flex items-center rounded-md border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] font-semibold text-slate-600">
                        priority: {r.priority}
                      </span>
                    )}
                  </div>
                  {r.justification && (
                    <p className="mt-1 text-xs text-slate-600 leading-snug">{r.justification}</p>
                  )}
                  {r.quality_gate_notes && (
                    <p className="mt-1 text-[11px] text-amber-700 leading-snug">
                      Gate: {r.quality_gate_notes}
                    </p>
                  )}
                  <div className="mt-1 text-[11px] text-slate-500 flex flex-wrap items-center gap-x-3">
                    <span>{time}</span>
                    <span>({formatAgo(r.requested_at)})</span>
                  </div>
                </div>
                {r.status === "umls-suggested" && (
                  <button
                    type="button"
                    disabled={importingId === r.id}
                    onClick={() => void importFromUmls(r)}
                    className="ml-1 inline-flex h-7 items-center gap-1 rounded-md border border-indigo-200 bg-indigo-50 px-2 text-[11px] font-semibold text-indigo-700 hover:bg-indigo-100 disabled:opacity-60"
                    title="Create a draft value set from these UMLS concepts"
                  >
                    <Download className="h-3 w-3" />
                    {importingId === r.id ? "Importing…" : "Import from UMLS"}
                  </button>
                )}
                <button
                  type="button"
                  onClick={async () => {
                    if (!confirm(`Delete terminology request "${r.requested_name}"?`)) return;
                    const prev = requests;
                    setRequests((rs) => rs.filter((x) => x.id !== r.id));
                    const { error } = await supabase
                      .from("terminology_requests" as any)
                      .delete()
                      .eq("id", r.id);
                    if (error) {
                      console.warn("[terminology_requests] delete failed", error);
                      setRequests(prev);
                      alert(`Delete failed: ${error.message}`);
                    }
                  }}
                  className="ml-1 inline-flex h-7 w-7 flex-none items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 hover:text-red-600 hover:border-red-200 hover:bg-red-50 transition-colors"
                  aria-label="Delete request"
                  title="Delete request"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })
        )}
      </div>

      <div className="flex items-center justify-between gap-3 pt-1">
        <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">
          Value Sets Drafted
        </div>
        <input
          type="text"
          placeholder="Search drafts…"
          value={draftedQuery}
          onChange={(e) => setDraftedQuery(e.target.value)}
          className="h-7 w-56 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 placeholder:text-slate-400 focus:outline-none focus:border-slate-400"
        />
      </div>
      <div className="scroll-feed rounded-lg border border-slate-200 divide-y divide-slate-100 bg-slate-50/40">
        {loading ? (
          <div className="px-4 py-6 text-sm text-slate-500">Loading activity…</div>
        ) : filteredDrafted.length === 0 ? (
          <div className="px-4 py-6 text-sm text-slate-500">
            {rows.length === 0 ? "No value sets drafted yet." : "No matches for your search."}
          </div>
        ) : (
          filteredDrafted.map((r) => {
            const { Icon, cls } = actionTone(r.action);
            const time = new Date(r.run_at).toLocaleString([], {
              month: "short",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
            });
            return (
              <div key={r.id} className="flex items-start gap-3 px-4 py-3">
                <span className={`mt-0.5 inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-semibold ${cls}`}>
                  <Icon className="h-3 w-3" />
                  {(r.action ?? "log").replace(/_/g, " ")}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-slate-800 leading-snug">{r.message}</p>
                  <div className="mt-1 text-[11px] text-slate-500 flex flex-wrap items-center gap-x-3 gap-y-0.5">
                    <span>{time}</span>
                    {r.theme && <span>theme: <span className="font-medium text-slate-700">{r.theme}</span></span>}
                    {typeof r.confidence === "number" && (
                      <span>confidence: <span className="font-medium text-slate-700">{r.confidence.toFixed(2)}</span></span>
                    )}
                    {typeof r.codes_count === "number" && r.codes_count > 0 && (
                      <span>{r.codes_count} code{r.codes_count === 1 ? "" : "s"}</span>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}