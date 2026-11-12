import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  Bot,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  Pause,
  Clock,
  Inbox,
  Archive,
  Copy,
  FileText,
  ChevronDown,
  ChevronUp,
  Send,
  CheckCheck,
  Link2,
  Loader2,
} from "lucide-react";
import { Trash2 } from "lucide-react";
import { InfoHint } from "@/components/ui/info-hint";
import { toast } from "sonner";
import { useRolePermissions, DISABLED_MESSAGE } from "@/hooks/useRolePermissions";
import { buildVsacImportInsert, type VsacExpansionResult } from "@/lib/value-set-registry";

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

type PossibleExistingMatch = {
  value_set_id: string;
  name: string;
  oid: string | null;
  match_reason: string;
} | null;

type ComponentValueSetRef = { value_set_id: string; name: string; oid: string | null };

// Mirrors KnownVsacCandidate in src/lib/value-set-registry.ts — an
// actively-published VSAC ValueSet from a recognized steward that
// findKnownVsacCandidates() (Gap 1) found in VSAC's own catalog.
type KnownVsacCandidate = {
  oid: string;
  name: string;
  title: string | null;
  publisher: string;
};

// `suggested_root_concept` always carries {code, display} (or is null)
// except for a "grouping" recommendation, where it also carries
// `componentValueSets` — the published value sets to compose — a
// documented reuse of this column's jsonb shape (see
// suggestedRootConceptForStorage() in src/lib/value-set-registry.ts).
type SuggestedRootConcept = {
  code?: string;
  display?: string;
  componentValueSets?: ComponentValueSetRef[];
} | null;

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
  recommended_type?: "intensional" | "extensional" | "grouping" | null;
  reasoning?: string | null;
  suggested_root_concept?: SuggestedRootConcept;
  recommended_binding_strength?: "required" | "extensible" | "preferred" | "example" | null;
  possible_existing_match?: PossibleExistingMatch;
  clinical_focus?: string | null;
  data_element_scope?: string | null;
  inclusion_criteria?: string | null;
  exclusion_criteria?: string | null;
  // Gap 1: VSAC-catalog candidates found for this request (external
  // steward-governed value sets — distinct from possible_existing_match,
  // which is about spehr's own locally-published value sets).
  known_vsac_candidates?: KnownVsacCandidate[] | null;
  // Gap 2: the real VSAC OID a human steward has linked once they started
  // authoring the recommended value set in real VSAC, plus when the
  // background cycle last polled it and (once published) a preview of
  // what vsacExpand returned.
  linked_vsac_oid?: string | null;
  last_vsac_check_at?: string | null;
  vsac_expansion_preview?: VsacExpansionResult | null;
};

// Statuses a suggestion brief can still be actioned from — anything the
// human steward hasn't yet sent to VSAC or resolved. "umls-suggested" means
// the background cycle found candidate UMLS concepts worth bringing to a
// steward's attention; it is staged, not imported.
const ACTIONABLE_STATUSES = new Set(["pending", "umls-suggested"]);

// FHIR ValueSet binding-strength badge colors, roughly by how strict the
// recommendation is: required (strictest) through example (illustrative
// only) — matches the severity-style badge language already used
// elsewhere in this panel (statusBadge, actionTone above).
function bindingStrengthBadgeClass(strength: string): string {
  switch (strength) {
    case "required":
      return "border-red-200 bg-red-50 text-red-800";
    case "extensible":
      return "border-amber-200 bg-amber-50 text-amber-800";
    case "preferred":
      return "border-sky-200 bg-sky-50 text-sky-800";
    default:
      return "border-slate-200 bg-slate-50 text-slate-600"; // example
  }
}

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
  if (s === "drafted" || s === "extended") return "text-sky-700 bg-sky-50 border-sky-200";
  if (s === "umls-suggested") return "text-indigo-700 bg-indigo-50 border-indigo-200";
  if (s === "sent_to_vsac") return "text-violet-700 bg-violet-50 border-violet-200";
  if (s === "ready_to_import") return "text-teal-700 bg-teal-50 border-teal-200";
  if (s === "published" || s === "resolved")
    return "text-emerald-700 bg-emerald-50 border-emerald-200";
  if (s === "rejected") return "text-red-700 bg-red-50 border-red-200";
  return "text-amber-700 bg-amber-50 border-amber-200"; // pending
}

// Statuses a human can still paste a VSAC OID into via "Link VSAC OID" —
// once a request is sent to VSAC for authoring but hasn't yet had its OID
// linked for the background publication-detection pass (Gap 2).
const LINKABLE_STATUSES = new Set(["pending", "sent_to_vsac"]);

export function AutoTerminologistActivity() {
  const { gate: stewardGate, can: stewardCan } = useRolePermissions();
  const stewardAllowed = stewardCan("dictionary.steward_approve");
  const [rows, setRows] = useState<LogRow[]>([]);
  const [latest, setLatest] = useState<LogRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [nowTick, setNowTick] = useState(0);
  const [requests, setRequests] = useState<RequestRow[]>([]);
  const [requestQuery, setRequestQuery] = useState("");
  const [consumerFilter, setConsumerFilter] = useState<string>("All");
  const [draftedQuery, setDraftedQuery] = useState("");
  const [deprecations, setDeprecations] = useState<DeprecationRow[]>([]);
  const [targetNames, setTargetNames] = useState<Record<string, string>>({});
  const [expandedBriefId, setExpandedBriefId] = useState<string | null>(null);
  const [actioningId, setActioningId] = useState<string | null>(null);
  // Draft OID text per request row for the "Link VSAC OID" inline form.
  const [linkOidDraft, setLinkOidDraft] = useState<Record<string, string>>({});
  const [importingId, setImportingId] = useState<string | null>(null);

  /**
   * Terminology requests never auto-create a `custom_value_sets` row with a
   * fabricated OID anymore — that was exactly the "spehr invents its own
   * value sets" pattern this view used to encourage via "Import from UMLS".
   * The only actions left here are read-only (view the suggestion brief) or
   * a plain status update: "Mark as Sent to VSAC" records that the human
   * steward has taken the brief's recommendation to NLM VSAC and authored
   * the real value set there. The loop closes in the Value Set Library's
   * existing "Import from VSAC" dialog (paste the real OID VSAC assigned),
   * or by manually marking the request Resolved once that import lands.
   */
  const markSentToVsac = async (r: RequestRow) => {
    setActioningId(r.id);
    try {
      const now = new Date().toISOString();
      const { error } = await supabase
        .from("terminology_requests")
        .update({
          status: "sent_to_vsac",
          updated_at: now,
          quality_gate_notes: `Suggestion brief sent to VSAC for authoring by a human steward.`,
        })
        .eq("id", r.id);
      if (error) throw error;
      setRequests((rs) => rs.map((x) => (x.id === r.id ? { ...x, status: "sent_to_vsac" } : x)));
      toast.success(`Marked "${r.requested_name}" as sent to VSAC`);
    } catch (e) {
      toast.error(`Failed to update request: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setActioningId(null);
    }
  };

  const markResolved = async (r: RequestRow) => {
    if (
      !confirm(
        `Mark "${r.requested_name}" resolved? Only do this once the matching value set has been imported from VSAC into the Value Set Library.`,
      )
    )
      return;
    setActioningId(r.id);
    try {
      const now = new Date().toISOString();
      const { error } = await supabase
        .from("terminology_requests")
        .update({ status: "resolved", resolved_at: now, updated_at: now })
        .eq("id", r.id);
      if (error) throw error;
      setRequests((rs) =>
        rs.map((x) => (x.id === r.id ? { ...x, status: "resolved", resolved_at: now } : x)),
      );
      toast.success(`Marked "${r.requested_name}" resolved`);
    } catch (e) {
      toast.error(`Failed to update request: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setActioningId(null);
    }
  };

  /**
   * Gap 2: records the real VSAC OID a human steward has started authoring
   * this request's recommended value set under. Clears last_vsac_check_at
   * so the background cycle (useAutoTerminologist.ts) checks it on its
   * very next pass instead of waiting out the ~daily cadence.
   */
  const linkVsacOid = async (r: RequestRow, oidRaw: string) => {
    const oid = oidRaw.trim();
    if (!oid) return;
    setActioningId(r.id);
    try {
      const now = new Date().toISOString();
      const { error } = await supabase
        .from("terminology_requests")
        .update({ linked_vsac_oid: oid, last_vsac_check_at: null, updated_at: now })
        .eq("id", r.id);
      if (error) throw error;
      setRequests((rs) =>
        rs.map((x) =>
          x.id === r.id ? { ...x, linked_vsac_oid: oid, last_vsac_check_at: null } : x,
        ),
      );
      setLinkOidDraft((d) => {
        const next = { ...d };
        delete next[r.id];
        return next;
      });
      toast.success(
        `Linked VSAC OID for "${r.requested_name}" — will be checked on the next cycle`,
      );
    } catch (e) {
      toast.error(`Failed to link OID: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setActioningId(null);
    }
  };

  /**
   * Shared tail of both "Import Now" flows below: inserts a
   * custom_value_sets draft from a VSAC expansion (via the shared
   * buildVsacImportInsert() helper — same shape ValueSetLibrary.tsx's
   * "Import from VSAC" dialog uses) and resolves the terminology_requests
   * row that triggered it. Always an explicit human click — see
   * architecture invariant F: nothing in the background cycle ever calls
   * this on its own.
   */
  const importExpansionAndResolve = async (
    r: RequestRow,
    expansion: VsacExpansionResult,
    nameHint: string,
  ) => {
    const insert = buildVsacImportInsert(expansion, nameHint);
    const insertQuery = supabase.from("custom_value_sets");
    const { data, error: insErr } = await insertQuery
      // `system` can legitimately be null (no codes yet) even though the
      // generated Insert type marks it required — same cast
      // ValueSetLibrary.tsx's "Import from VSAC" dialog needs for this.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .insert(insert as any)
      .select("id")
      .single();
    if (insErr) throw insErr;
    const valueSetId = String(data?.id ?? "") || null;
    const now = new Date().toISOString();
    const { error: updErr } = await supabase
      .from("terminology_requests")
      .update({
        status: "resolved",
        value_set_id: valueSetId,
        resolved_at: now,
        updated_at: now,
      })
      .eq("id", r.id);
    if (updErr) throw updErr;
    setRequests((rs) =>
      rs.map((x) => (x.id === r.id ? { ...x, status: "resolved", resolved_at: now } : x)),
    );
    toast.success(
      `Imported "${insert.name}" (${insert.codes.length} codes) from VSAC as draft — request resolved`,
    );
  };

  /** Capability E: one-click import for a `ready_to_import` row's
   * background-detected VSAC expansion preview. */
  const importReadyToImport = async (r: RequestRow) => {
    const preview = r.vsac_expansion_preview;
    if (!preview) return;
    setImportingId(r.id);
    try {
      await importExpansionAndResolve(
        r,
        preview,
        preview.title || preview.name || r.requested_name,
      );
    } catch (e) {
      toast.error(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setImportingId(null);
    }
  };

  /**
   * Capability B/C: one-click import straight from a Gap-1
   * knownVsacCandidates hit — an already-published, steward-governed value
   * set doesn't need the "wait for a human to author it" step, so this
   * fetches the real expansion by OID and imports it immediately rather
   * than requiring "Link VSAC OID" first.
   */
  const importKnownVsacCandidate = async (r: RequestRow, c: KnownVsacCandidate) => {
    setImportingId(r.id);
    try {
      // `data` comes back implicitly typed `any` from functions.invoke, same
      // as ValueSetLibrary.tsx's handleVsacFetch — no extra cast needed.
      const { data, error } = await supabase.functions.invoke("umls-proxy", {
        body: { action: "vsacExpand", params: { oid: c.oid } },
      });
      if (error) throw new Error(error.message ?? "Failed to reach VSAC");
      if (data?.error) throw new Error(String(data.error));
      const expansion: VsacExpansionResult = {
        oid: data.oid,
        name: data.name ?? null,
        title: data.title ?? null,
        total: Number(data.total ?? 0),
        type: (data.type === "grouping" || data.type === "intensional"
          ? data.type
          : "extensional") as "grouping" | "intensional" | "extensional",
        codes: Array.isArray(data.codes) ? data.codes : [],
      };
      await importExpansionAndResolve(r, expansion, c.title || c.name);
    } catch (e) {
      toast.error(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
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
    return rows.filter(
      (r) =>
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
          "id, requesting_consumer, requested_name, justification, priority, status, quality_gate_notes, requested_at, resolved_at, seed_codes, vocabulary, clinical_application, request_type, target_value_set_id, recommended_type, reasoning, suggested_root_concept, recommended_binding_strength, possible_existing_match, clinical_focus, data_element_scope, inclusion_criteria, exclusion_criteria, known_vsac_candidates, linked_vsac_oid, last_vsac_check_at, vsac_expansion_preview",
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
      const { data } = await supabase.from("custom_value_sets").select("id, name").in("id", ids);
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
          {new Date(latest.run_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} (
          {formatAgo(lastRunAt)}) — {latest.message}
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
          <span className="ml-1 text-slate-500">
            → billing / population health (+ IT hand-off on infra failure)
          </span>
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
            {requests.length === 0
              ? "No terminology requests submitted yet."
              : "No matches for your search."}
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
            const isExpanded = expandedBriefId === r.id;
            const actionable =
              !isDeprecate && ACTIONABLE_STATUSES.has(String(r.status ?? "pending"));
            const seedCodes: Array<{ code?: string; display?: string; vocabulary?: string }> =
              Array.isArray(r.seed_codes) ? r.seed_codes : [];
            return (
              <div key={r.id} className="flex flex-col gap-2 px-4 py-3">
                <div className="flex items-start gap-3">
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
                            {targetName
                              ? `Target: ${targetName}`
                              : `Deprecation target label: ${r.requested_name}`}
                          </p>
                        </>
                      ) : (
                        <p className="text-sm font-medium text-slate-800 leading-snug">
                          {r.requested_name}
                        </p>
                      )}
                      <span
                        className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-semibold ${statusBadge(r.status)}`}
                      >
                        {r.status ?? "pending"}
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
                  {!isDeprecate && (
                    <button
                      type="button"
                      onClick={() => setExpandedBriefId(isExpanded ? null : r.id)}
                      className="ml-1 inline-flex h-7 items-center gap-1 rounded-md border border-slate-200 bg-white px-2 text-[11px] font-semibold text-slate-600 hover:bg-slate-50"
                      title="View suggestion brief"
                    >
                      <FileText className="h-3 w-3" />
                      Brief
                      {isExpanded ? (
                        <ChevronUp className="h-3 w-3" />
                      ) : (
                        <ChevronDown className="h-3 w-3" />
                      )}
                    </button>
                  )}
                  {actionable && r.status !== "sent_to_vsac" && (
                    <button
                      type="button"
                      disabled={actioningId === r.id}
                      onClick={() => void markSentToVsac(r)}
                      className="ml-1 inline-flex h-7 items-center gap-1 rounded-md border border-violet-200 bg-violet-50 px-2 text-[11px] font-semibold text-violet-700 hover:bg-violet-100 disabled:opacity-60"
                      title="Record that this brief's recommendation has been taken to NLM VSAC for authoring"
                    >
                      <Send className="h-3 w-3" />
                      Mark as Sent to VSAC
                    </button>
                  )}
                  {r.status === "sent_to_vsac" && (
                    <button
                      type="button"
                      disabled={actioningId === r.id}
                      onClick={() => void markResolved(r)}
                      className="ml-1 inline-flex h-7 items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-2 text-[11px] font-semibold text-emerald-700 hover:bg-emerald-100 disabled:opacity-60"
                      title="Mark resolved once the matching value set has been imported from VSAC"
                    >
                      <CheckCheck className="h-3 w-3" />
                      Mark Resolved
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={async () => {
                      if (!confirm(`Delete terminology request "${r.requested_name}"?`)) return;
                      const prev = requests;
                      setRequests((rs) => rs.filter((x) => x.id !== r.id));
                      const { error } = await supabase
                        .from("terminology_requests")
                        .delete()
                        .eq("id", r.id);
                      if (error) {
                        console.warn("[terminology_requests] delete failed", error);
                        setRequests(prev);
                        toast.error("Delete failed", { description: error.message });
                      }
                    }}
                    className="ml-1 inline-flex h-7 w-7 flex-none items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 hover:text-red-600 hover:border-red-200 hover:bg-red-50 transition-colors"
                    aria-label="Delete request"
                    title="Delete request"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>

                {/* Gap 1: VSAC-catalog candidates found for this request — an
                    already-published, steward-governed value set doesn't
                    need the "wait for authoring" step, so route straight to
                    one-click import. */}
                {!isDeprecate &&
                  Array.isArray(r.known_vsac_candidates) &&
                  r.known_vsac_candidates.length > 0 && (
                    <div className="ml-1 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-[11px] text-emerald-900 space-y-1.5">
                      <div className="flex items-center gap-1.5 font-semibold">
                        <CheckCircle2 className="h-3 w-3" />
                        Found in VSAC — Consider Importing
                      </div>
                      {r.known_vsac_candidates.map((c) => (
                        <div
                          key={c.oid}
                          className="flex flex-wrap items-center justify-between gap-2 rounded border border-emerald-200 bg-white px-2 py-1"
                        >
                          <div className="min-w-0 text-emerald-900">
                            <span className="font-semibold">{c.name}</span>{" "}
                            <span className="text-emerald-700">· {c.publisher}</span>{" "}
                            <span className="font-mono text-[10px] text-emerald-700">
                              OID {c.oid}
                            </span>
                          </div>
                          <button
                            type="button"
                            {...stewardGate(
                              "dictionary.steward_approve",
                              () => void importKnownVsacCandidate(r, c),
                            )}
                            disabled={!stewardAllowed || importingId === r.id}
                            className="shrink-0 inline-flex h-6 items-center gap-1 rounded-md border border-emerald-300 bg-emerald-600 px-2 text-[10px] font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
                            title={
                              stewardAllowed ? "Import this VSAC value set now" : DISABLED_MESSAGE
                            }
                          >
                            {importingId === r.id ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              "Import Now"
                            )}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                {/* Gap 2: the background cycle detected the linked OID is now
                    published in VSAC — one-click import of the preview it
                    staged. Never auto-imported — always this explicit click. */}
                {!isDeprecate && r.status === "ready_to_import" && r.vsac_expansion_preview && (
                  <div className="ml-1 rounded-md border border-teal-300 bg-teal-50 px-3 py-2 text-[11px] text-teal-900">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 font-semibold">
                          <CheckCheck className="h-3 w-3" />
                          Published in VSAC — Import Now
                        </div>
                        <div className="mt-0.5 text-teal-800">
                          {r.vsac_expansion_preview.title ||
                            r.vsac_expansion_preview.name ||
                            "Untitled"}
                          {" · "}
                          {r.vsac_expansion_preview.total ??
                            r.vsac_expansion_preview.codes.length}{" "}
                          codes
                          {" · "}
                          <span className="capitalize">{r.vsac_expansion_preview.type}</span>
                          {" · OID "}
                          <span className="font-mono">{r.vsac_expansion_preview.oid}</span>
                        </div>
                      </div>
                      <button
                        type="button"
                        {...stewardGate(
                          "dictionary.steward_approve",
                          () => void importReadyToImport(r),
                        )}
                        disabled={!stewardAllowed || importingId === r.id}
                        className="shrink-0 inline-flex h-7 items-center gap-1 rounded-md border border-teal-400 bg-teal-600 px-2.5 text-[11px] font-semibold text-white hover:bg-teal-700 disabled:opacity-60"
                        title={stewardAllowed ? "Import this value set now" : DISABLED_MESSAGE}
                      >
                        {importingId === r.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          "Import Now"
                        )}
                      </button>
                    </div>
                    {!stewardAllowed && (
                      <div className="mt-1 text-[10px] text-amber-700">{DISABLED_MESSAGE}</div>
                    )}
                  </div>
                )}

                {/* Gap 2: "Link VSAC OID" — record the real OID once a human
                    steward has started authoring this request's recommended
                    value set in real VSAC, so the background cycle can poll
                    it for publication. */}
                {!isDeprecate &&
                  !r.linked_vsac_oid &&
                  LINKABLE_STATUSES.has(String(r.status ?? "pending")) && (
                    <div className="ml-1 flex flex-wrap items-center gap-1.5">
                      <Link2 className="h-3 w-3 text-slate-400" />
                      <input
                        type="text"
                        placeholder="Paste real VSAC OID once authoring has started…"
                        value={linkOidDraft[r.id] ?? ""}
                        onChange={(e) => setLinkOidDraft((d) => ({ ...d, [r.id]: e.target.value }))}
                        className="h-7 w-72 rounded-md border border-slate-200 bg-white px-2 font-mono text-[11px] text-slate-700 placeholder:text-slate-400 focus:outline-none focus:border-slate-400"
                      />
                      <button
                        type="button"
                        disabled={!linkOidDraft[r.id]?.trim() || actioningId === r.id}
                        onClick={() => void linkVsacOid(r, linkOidDraft[r.id] ?? "")}
                        className="inline-flex h-7 items-center gap-1 rounded-md border border-slate-300 bg-white px-2 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
                        title="Link this OID so the background cycle checks it for publication"
                      >
                        Link VSAC OID
                      </button>
                    </div>
                  )}
                {!isDeprecate &&
                  r.linked_vsac_oid &&
                  r.status !== "ready_to_import" &&
                  r.status !== "resolved" && (
                    <div className="ml-1 text-[11px] text-slate-500">
                      Linked VSAC OID{" "}
                      <span className="font-mono text-slate-700">{r.linked_vsac_oid}</span> ·
                      awaiting publication (checked{" "}
                      {r.last_vsac_check_at ? formatAgo(r.last_vsac_check_at) : "not yet"})
                    </div>
                  )}

                {!isDeprecate && isExpanded && (
                  <div className="ml-1 rounded-md border border-slate-200 bg-white px-3 py-2.5 text-[11px] text-slate-700 space-y-2">
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                      Suggestion Brief · for a human to review and author in VSAC
                    </div>
                    <div className="grid gap-1.5 sm:grid-cols-2">
                      <div>
                        <span className="font-semibold text-slate-500">Suggested Name</span>
                        <div className="text-slate-800">{r.requested_name}</div>
                      </div>
                      <div>
                        <span className="font-semibold text-slate-500">Source Vocabulary</span>
                        <div className="text-slate-800">{r.vocabulary ?? "—"}</div>
                      </div>
                      <div className="sm:col-span-2">
                        <span className="font-semibold text-slate-500">Clinical Purpose</span>
                        <div className="text-slate-800">
                          Filed by <span className="font-medium">{r.requesting_consumer}</span>
                          {r.justification ? `: ${r.justification}` : " — no justification given."}
                        </div>
                      </div>
                      <div className="sm:col-span-2">
                        <span className="font-semibold text-slate-500">
                          Recommended Definition Type
                        </span>
                        <div className="mt-0.5 flex flex-wrap items-center gap-2">
                          {r.recommended_type ? (
                            <span
                              className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-semibold capitalize ${
                                r.recommended_type === "intensional"
                                  ? "border-violet-200 bg-violet-50 text-violet-800"
                                  : r.recommended_type === "grouping"
                                    ? "border-amber-200 bg-amber-50 text-amber-800"
                                    : "border-sky-200 bg-sky-50 text-sky-800"
                              }`}
                            >
                              {r.recommended_type}
                            </span>
                          ) : (
                            <span className="text-slate-400">Not yet determined</span>
                          )}
                          {r.recommended_binding_strength && (
                            <span
                              className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-semibold capitalize ${bindingStrengthBadgeClass(r.recommended_binding_strength)}`}
                              title="FHIR ValueSet binding strength — advisory, a human steward decides the real value in VSAC"
                            >
                              binding: {r.recommended_binding_strength}
                            </span>
                          )}
                        </div>
                        {r.reasoning && (
                          <div className="mt-1 text-slate-600 leading-snug">{r.reasoning}</div>
                        )}
                      </div>

                      {r.possible_existing_match && (
                        <div className="sm:col-span-2 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5">
                          <div className="flex items-center gap-1.5 font-semibold text-amber-800">
                            <AlertTriangle className="h-3 w-3" />
                            Possible existing coverage
                          </div>
                          <div className="mt-0.5 text-amber-700 leading-snug">
                            {r.possible_existing_match.match_reason}
                            {r.possible_existing_match.oid && (
                              <span className="font-mono">
                                {" "}
                                (OID {r.possible_existing_match.oid})
                              </span>
                            )}
                          </div>
                        </div>
                      )}

                      <div className="sm:col-span-2">
                        <span className="font-semibold text-slate-500">
                          {r.recommended_type === "intensional" || r.recommended_type === "grouping"
                            ? "Suggested Root Concept"
                            : "Candidate Codes"}
                        </span>
                        {(r.recommended_type === "intensional" ||
                          r.recommended_type === "grouping") &&
                        r.suggested_root_concept?.code ? (
                          <div className="mt-0.5 font-mono text-[10px] text-slate-700">
                            {r.suggested_root_concept.code} —{" "}
                            <span className="font-sans">{r.suggested_root_concept.display}</span>
                          </div>
                        ) : seedCodes.length > 0 ? (
                          <ul className="mt-0.5 space-y-0.5">
                            {seedCodes.slice(0, 10).map((c, i) => (
                              <li key={i} className="font-mono text-[10px] text-slate-700">
                                {c.code ?? "—"}{" "}
                                <span className="font-sans text-slate-600">{c.display ?? ""}</span>
                              </li>
                            ))}
                            {seedCodes.length > 10 && (
                              <li className="text-slate-400">+ {seedCodes.length - 10} more</li>
                            )}
                          </ul>
                        ) : (
                          <div className="mt-0.5 text-slate-400">No candidate codes staged yet</div>
                        )}
                      </div>

                      {r.recommended_type === "grouping" &&
                        Array.isArray(r.suggested_root_concept?.componentValueSets) &&
                        r.suggested_root_concept!.componentValueSets!.length > 0 && (
                          <div className="sm:col-span-2">
                            <span className="font-semibold text-slate-500">
                              Compose From Published Value Sets
                            </span>
                            <ul className="mt-0.5 space-y-0.5">
                              {r.suggested_root_concept!.componentValueSets!.map((cvs) => (
                                <li key={cvs.value_set_id} className="text-slate-700">
                                  {cvs.name}
                                  {cvs.oid && (
                                    <span className="ml-1 font-mono text-[10px] text-slate-500">
                                      OID {cvs.oid}
                                    </span>
                                  )}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}

                      <div className="sm:col-span-2">
                        <span className="font-semibold text-slate-500">Intended Consumer</span>
                        <div className="text-slate-800">
                          {r.requesting_consumer}
                          {r.clinical_application ? ` · ${r.clinical_application}` : ""}
                        </div>
                      </div>

                      <div className="sm:col-span-2 border-t border-slate-100 pt-2 mt-1">
                        <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                          VSAC Purpose (draft — paste into VSAC's Metadata tab)
                        </div>
                      </div>
                      <div className="sm:col-span-2">
                        <span className="font-semibold text-slate-500">Clinical Focus</span>
                        <div className="text-slate-800 leading-snug">{r.clinical_focus || "—"}</div>
                      </div>
                      <div className="sm:col-span-2">
                        <span className="font-semibold text-slate-500">Data Element Scope</span>
                        <div className="text-slate-800">{r.data_element_scope || "—"}</div>
                      </div>
                      <div className="sm:col-span-2">
                        <span className="font-semibold text-slate-500">Inclusion Criteria</span>
                        <div className="text-slate-800 leading-snug">
                          {r.inclusion_criteria ||
                            (r.recommended_type === "grouping"
                              ? "(blank — inherited from component value sets)"
                              : "—")}
                        </div>
                      </div>
                      <div className="sm:col-span-2">
                        <span className="font-semibold text-slate-500">Exclusion Criteria</span>
                        <div className="text-slate-800 leading-snug">
                          {r.exclusion_criteria ||
                            (r.recommended_type === "grouping"
                              ? "(blank — inherited from component value sets)"
                              : "—")}
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <div className="flex items-center justify-between gap-3 pt-1">
        <div className="text-xs font-semibold uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
          <Archive className="h-3.5 w-3.5" />
          Deprecation Suggestions
        </div>
        <span className="text-[11px] text-slate-500">{deprecations.length} pending</span>
      </div>
      <div className="scroll-feed rounded-lg border border-slate-200 divide-y divide-slate-100 bg-slate-50/40">
        {deprecations.length === 0 ? (
          <div className="px-4 py-6 text-sm text-slate-500">
            No value sets currently flagged for deprecation.
          </div>
        ) : (
          deprecations.map((d) => {
            const change = latestChange(d.change_history);
            return (
              <div key={d.id} className="flex items-start gap-3 px-4 py-3">
                <span className="mt-0.5 inline-flex items-center gap-1 rounded-md border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-800">
                  <Archive className="h-3 w-3" />
                  deprecation-suggested
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-slate-800 leading-snug">{d.name}</p>
                  <div className="mt-1 text-[11px] text-slate-500 flex flex-wrap items-center gap-x-3">
                    {d.vocabulary && <span>{d.vocabulary}</span>}
                    {d.oid && <span className="font-mono text-slate-600">OID {d.oid}</span>}
                  </div>
                  {change && <p className="mt-1 text-xs text-slate-600 leading-snug">{change}</p>}
                </div>
                {d.oid && (
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(d.oid!);
                        toast.success("OID copied — paste into the Value Set Library to open");
                      } catch {
                        toast.error("Copy failed");
                      }
                    }}
                    className="ml-1 inline-flex h-7 items-center gap-1 rounded-md border border-slate-200 bg-white px-2 text-[11px] font-semibold text-slate-600 hover:bg-slate-50"
                    title="Copy OID to jump to this value set in the Library"
                  >
                    <Copy className="h-3 w-3" />
                    Copy OID
                  </button>
                )}
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
                <span
                  className={`mt-0.5 inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-semibold ${cls}`}
                >
                  <Icon className="h-3 w-3" />
                  {(r.action ?? "log").replace(/_/g, " ")}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-slate-800 leading-snug">{r.message}</p>
                  <div className="mt-1 text-[11px] text-slate-500 flex flex-wrap items-center gap-x-3 gap-y-0.5">
                    <span>{time}</span>
                    {r.theme && (
                      <span>
                        theme: <span className="font-medium text-slate-700">{r.theme}</span>
                      </span>
                    )}
                    {typeof r.confidence === "number" && (
                      <span>
                        confidence:{" "}
                        <span className="font-medium text-slate-700">
                          {r.confidence.toFixed(2)}
                        </span>
                      </span>
                    )}
                    {typeof r.codes_count === "number" && r.codes_count > 0 && (
                      <span>
                        {r.codes_count} code{r.codes_count === 1 ? "" : "s"}
                      </span>
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
