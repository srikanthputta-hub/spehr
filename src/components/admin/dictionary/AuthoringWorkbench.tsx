import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search, Save, Send, Loader2, X, Plus, Check, ShieldCheck, AlertTriangle, CheckCircle2, XCircle, Target, Layers, Download, Boxes } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { LookupCard } from "@/components/admin/dictionary/FhirOpCards";
import { InfoHint } from "@/components/ui/info-hint";
import { useFacility } from "@/lib/facility-context";
import { useRolePermissions } from "@/hooks/useRolePermissions";

type Hit = { ui: string; name: string; rootSource?: string };
type Picked = { code: string; display: string; vocabulary: string; excluded?: boolean };
type ValidationStatus = "pending" | "valid" | "inactive" | "unknown" | "error";
type ValidationRow = { code: string; display: string; vocabulary: string; status: ValidationStatus; message: string };
type ValueSetStatus = "draft" | "review" | "approved" | "rejected" | "published";
const BINDING_STRENGTHS = ["Required", "Extensible", "Preferred", "Example"] as const;
type BindingStrength = (typeof BINDING_STRENGTHS)[number];

const HIERARCHY_OPERATORS = [
  { value: "equal", label: "equal — just this concept" },
  { value: "in", label: "in — just this concept (as set member)" },
  { value: "descendantOf", label: "descendantOf — all descendants (excludes anchor)" },
  { value: "descendantOrSelfOf", label: "descendantOrSelfOf — anchor + all descendants" },
  { value: "childOf", label: "childOf — direct children only" },
  { value: "ancestorOf", label: "ancestorOf — all ancestors (excludes anchor)" },
  { value: "ancestorOrSelfOf", label: "ancestorOrSelfOf — anchor + all ancestors" },
  { value: "parentOf", label: "parentOf — direct parents only" },
] as const;
type HierarchyOperator = (typeof HIERARCHY_OPERATORS)[number]["value"];

type IntensionalClause = {
  anchorCode: string;
  anchorDisplay: string;
  vocabulary: string;
  operator: HierarchyOperator;
  computedAt: string;
  count: number;
};

type GroupingCandidate = {
  id: string;
  name: string;
  oid: string | null;
  status: string | null;
  codesCount: number;
  codes: Picked[];
};

type GroupingMember = {
  id: string;
  name: string;
  oid: string | null;
  codes: Picked[];
};

const VOCABS = [
  { label: "SNOMED CT", value: "SNOMEDCT_US" },
  { label: "ICD-10-CM", value: "ICD10CM" },
  { label: "LOINC", value: "LNC" },
  { label: "RxNorm", value: "RXNORM" },
  { label: "MedDRA", value: "MDR" },
];

export function AuthoringWorkbench() {
  const { activeRole } = useFacility();
  const { gate, can } = useRolePermissions();
  const [vocab, setVocab] = useState(VOCABS[0]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Hit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [type, setType] = useState<"extensional" | "intensional" | "grouping">("extensional");
  const [picks, setPicks] = useState<Picked[]>([]);
  const [excluded, setExcluded] = useState<Picked[]>([]);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [author, setAuthor] = useState("");
  const [bindingStrength, setBindingStrength] = useState<BindingStrength>("Preferred");
  // Intensional (SNOMED-only) authoring state
  const [anchor, setAnchor] = useState<{ code: string; display: string } | null>(null);
  const [operator, setOperator] = useState<HierarchyOperator>("descendantOrSelfOf");
  const [expansion, setExpansion] = useState<Array<{ code: string; name: string }>>([]);
  const [expansionTruncated, setExpansionTruncated] = useState(false);
  const [expanding, setExpanding] = useState(false);
  const [intensionalClause, setIntensionalClause] = useState<IntensionalClause | null>(null);
  // Grouping (union-of-value-sets) authoring state
  const [groupingQuery, setGroupingQuery] = useState("");
  const [groupingResults, setGroupingResults] = useState<GroupingCandidate[]>([]);
  const [groupingSearching, setGroupingSearching] = useState(false);
  const [groupingMembers, setGroupingMembers] = useState<GroupingMember[]>([]);
  const [groupingUnion, setGroupingUnion] = useState<Picked[]>([]);
  const [validationRows, setValidationRows] = useState<ValidationRow[]>([]);
  const [validating, setValidating] = useState(false);
  const [lastValidatedAt, setLastValidatedAt] = useState<string | null>(null);
  const [log, setLog] = useState<Array<{ id: string; created_at: string; actor: string; message: string }>>([]);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [savedStatus, setSavedStatus] = useState<ValueSetStatus | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [governing, setGoverning] = useState(false);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const groupingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load + subscribe to unified authoring activity log
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const { data } = await supabase
        .from("terminology_activity_log" as any)
        .select("id, created_at, actor, message")
        .eq("feature", "authoring")
        .order("created_at", { ascending: false })
        .limit(50);
      if (!cancelled && data) setLog(data as any);
    };
    load();
    const ch = supabase
      .channel("terminology-activity-authoring")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "terminology_activity_log", filter: "feature=eq.authoring" },
        (payload) => setLog((l) => [payload.new as any, ...l].slice(0, 50)),
      )
      .subscribe();
    return () => { cancelled = true; supabase.removeChannel(ch); };
  }, []);

  const logActivity = (action: string, message: string, ref_id?: string | null) => {
    void supabase.from("terminology_activity_log" as any).insert({
      feature: "authoring",
      actor: "S.P.E.H.R. Terminology Services",
      action,
      message,
      ref_id: ref_id ?? null,
    });
  };

  const runSearch = useCallback(async (q: string, v = vocab) => {
    if (!q || q.length < 2) { setResults([]); return; }
    setSearching(true);
    setSearchErr(null);
    try {
      const { data, error } = await supabase.functions.invoke("umls-proxy", {
        body: {
          action: "search",
          params: {
            string: q,
            sabs: v.value,
            returnIdType: "code",
            pageSize: 15,
          },
        },
      });
      if (error) {
        setSearchErr(error.message ?? "Terminology server unavailable");
        setResults([]);
      } else {
        const hits = ((data as any)?.result?.results ?? []).filter(
          (r: any) => r?.ui && r.ui !== "NONE",
        );
        setResults(hits);
      }
    } finally { setSearching(false); }
  }, [vocab]);

  // Listen for cross-tab prefill events from Live Terminology Matrix pills
  useEffect(() => {
    const onPrefill = (e: Event) => {
      const d = (e as CustomEvent).detail ?? {};
      let nextVocab = vocab;
      if (d.vocabulary) {
        const match = VOCABS.find(v => v.label === d.vocabulary);
        if (match) { nextVocab = match; setVocab(match); }
      }
      const q = d.code ?? d.query;
      if (q != null) {
        const qStr = String(q);
        setQuery(qStr);
        // Programmatic prefill → fire search after a 100ms delay
        setTimeout(() => runSearch(qStr, nextVocab), 100);
      }
    };
    window.addEventListener("spehr:authoring-prefill", onPrefill as any);
    return () => window.removeEventListener("spehr:authoring-prefill", onPrefill as any);
  }, [runSearch, vocab]);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (!query || query.length < 2) { setResults([]); return; }
    timer.current = setTimeout(() => runSearch(query), 300);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [query, vocab, runSearch]);

  const addPick = (hit: Hit, exclude = false) => {
    const picked: Picked = { code: hit.ui, display: hit.name, vocabulary: vocab.label, excluded: exclude };
    if (exclude) setExcluded(p => p.find(x => x.code === picked.code) ? p : [...p, picked]);
    else setPicks(p => p.find(x => x.code === picked.code) ? p : [...p, picked]);
    logActivity(exclude ? "excluded_concept" : "added_concept", `${exclude ? "Excluded" : "Added"} ${hit.ui} · ${hit.name}`, hit.ui);
  };

  // Intensional-mode helpers (SNOMED CT only) ─────────────────────────────
  const isSnomed = vocab.value === "SNOMEDCT_US";
  const intensionalActive = type === "intensional" && isSnomed;

  const setAsAnchor = (hit: Hit) => {
    setAnchor({ code: hit.ui, display: hit.name });
    setExpansion([]);
    setExpansionTruncated(false);
    logActivity("anchor_set", `Set anchor ${hit.ui} · ${hit.name}`, hit.ui);
  };

  const previewExpansion = async () => {
    if (!anchor) { toast.error("Set an anchor concept first"); return; }
    setExpanding(true);
    try {
      const { data, error } = await supabase.functions.invoke("umls-proxy", {
        body: {
          action: "hierarchyExpand",
          params: { sab: "SNOMEDCT_US", code: anchor.code, operator },
        },
      });
      if (error) throw error;
      const codes = Array.isArray((data as any)?.codes) ? (data as any).codes : [];
      setExpansion(codes);
      setExpansionTruncated(Boolean((data as any)?.truncated));
      logActivity("previewed_expansion", `Previewed ${operator} of ${anchor.code} → ${codes.length} members${(data as any)?.truncated ? " (truncated)" : ""}`, anchor.code);
      if (codes.length === 0) toast.warning("Expansion returned no members");
      else toast.success(`Expansion: ${codes.length} member(s)`);
    } catch (e: any) {
      toast.error(e?.message ?? "Expansion failed");
    } finally { setExpanding(false); }
  };

  const applyExpansionToValueSet = () => {
    if (!anchor || expansion.length === 0) { toast.error("Preview an expansion first"); return; }
    const asPicks: Picked[] = expansion.map((c) => ({
      code: c.code, display: c.name || c.code, vocabulary: vocab.label,
    }));
    setPicks(asPicks);
    setExcluded([]);
    const clause: IntensionalClause = {
      anchorCode: anchor.code,
      anchorDisplay: anchor.display,
      vocabulary: vocab.label,
      operator,
      computedAt: new Date().toISOString(),
      count: asPicks.length,
    };
    setIntensionalClause(clause);
    logActivity("applied_expansion", `Applied ${operator} of ${anchor.code} — ${asPicks.length} concept(s) loaded`, anchor.code);
    toast.success(`Loaded ${asPicks.length} concept(s) into value set`);
  };

  // If user switches away from intensional/SNOMED, drop the clause so a
  // subsequent save doesn't persist a stale hierarchy rule.
  useEffect(() => {
    if (!intensionalActive && intensionalClause) setIntensionalClause(null);
  }, [intensionalActive, intensionalClause]);

  // If the user switches away from grouping, drop grouping state so a
  // subsequent save doesn't persist a stale grouping_members payload.
  useEffect(() => {
    if (type !== "grouping") {
      if (groupingMembers.length > 0) setGroupingMembers([]);
      if (groupingUnion.length > 0) setGroupingUnion([]);
      if (groupingResults.length > 0) setGroupingResults([]);
      if (groupingQuery) setGroupingQuery("");
    }
  }, [type, groupingMembers.length, groupingUnion.length, groupingResults.length, groupingQuery]);

  // Debounced search of existing value sets by name (grouping mode)
  const runGroupingSearch = useCallback(async (q: string) => {
    const term = q.trim();
    if (!term || term.length < 2) { setGroupingResults([]); return; }
    setGroupingSearching(true);
    try {
      const { data, error } = await supabase
        .from("custom_value_sets")
        .select("id, name, oid, status, codes")
        .ilike("name", `%${term}%`)
        .order("name", { ascending: true })
        .limit(20);
      if (error) throw error;
      const selfName = name.trim().toLowerCase();
      const rows: GroupingCandidate[] = (data ?? [])
        .filter((r: any) => !selfName || String(r.name ?? "").toLowerCase() !== selfName)
        .map((r: any) => ({
          id: r.id,
          name: r.name,
          oid: r.oid ?? null,
          status: r.status ?? null,
          codesCount: Array.isArray(r.codes) ? r.codes.length : 0,
          codes: Array.isArray(r.codes) ? (r.codes as Picked[]) : [],
        }));
      setGroupingResults(rows);
    } catch (e: any) {
      toast.error(e?.message ?? "Value set search failed");
      setGroupingResults([]);
    } finally { setGroupingSearching(false); }
  }, [name]);

  useEffect(() => {
    if (type !== "grouping") return;
    if (groupingTimer.current) clearTimeout(groupingTimer.current);
    if (!groupingQuery || groupingQuery.length < 2) { setGroupingResults([]); return; }
    groupingTimer.current = setTimeout(() => runGroupingSearch(groupingQuery), 300);
    return () => { if (groupingTimer.current) clearTimeout(groupingTimer.current); };
  }, [groupingQuery, type, runGroupingSearch]);

  const addGroupingMember = (c: GroupingCandidate) => {
    setGroupingMembers((prev) => prev.find((m) => m.id === c.id)
      ? prev
      : [...prev, { id: c.id, name: c.name, oid: c.oid, codes: c.codes }]);
    logActivity("grouping_added_member", `Added "${c.name}" to grouping (${c.codesCount} codes)`, c.id);
  };

  const removeGroupingMember = (id: string) => {
    setGroupingMembers((prev) => prev.filter((m) => m.id !== id));
  };

  const previewGroupingUnion = () => {
    if (groupingMembers.length === 0) { toast.error("Add at least one value set to the grouping"); return; }
    const seen = new Set<string>();
    const union: Picked[] = [];
    for (const m of groupingMembers) {
      for (const c of m.codes ?? []) {
        const key = `${c.vocabulary ?? ""}:${c.code}`;
        if (seen.has(key)) continue;
        seen.add(key);
        union.push({ code: c.code, display: c.display, vocabulary: c.vocabulary, excluded: false });
      }
    }
    setGroupingUnion(union);
    logActivity("grouping_previewed_union", `Previewed union of ${groupingMembers.length} value set(s) — ${union.length} unique member(s)`, null);
    if (union.length === 0) toast.warning("Union is empty — chosen value sets have no codes");
    else toast.success(`Union: ${union.length} unique member(s)`);
  };

  const applyGroupingUnion = () => {
    if (groupingUnion.length === 0) { toast.error("Preview the union first"); return; }
    setPicks(groupingUnion.map((c) => ({ ...c })));
    setExcluded([]);
    logActivity("grouping_applied_union", `Loaded ${groupingUnion.length} concept(s) from grouping union`, null);
    toast.success(`Loaded ${groupingUnion.length} concept(s) into value set`);
  };

  const removePick = (code: string, list: "in" | "out") => {
    if (list === "in") setPicks(p => p.filter(x => x.code !== code));
    else setExcluded(p => p.filter(x => x.code !== code));
    logActivity("removed_concept", `Removed ${code}`, code);
  };

  const save = async (status: "draft" | "review") => {
    if (!name.trim()) return toast.error("Value set name required");
    if (picks.length === 0) return toast.error("Add at least one concept");
    if (status === "review") {
      if (!author.trim()) {
        return toast.error("Author is required to submit for review");
      }
      if (lastValidatedAt === null) {
        return toast.error("Run validation before submitting for review");
      }
      const hasBlocking = validationRows.some((r) => r.status === "inactive" || r.status === "error");
      if (hasBlocking) {
        return toast.error("Resolve inactive/errored concepts before submitting");
      }
    }
    setSaving(true);
    try {
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      const { data, error } = await supabase.from("custom_value_sets").upsert({
        name,
        system: vocab.label.replace(" ", "-"),
        vocabulary: vocab.label,
        type,
        codes: picks,
        status,
        description: notes || null,
        author: author.trim() || null,
        binding_strength: bindingStrength,
        intensional_clause: type === "intensional" ? (intensionalClause as any) : null,
        grouping_members: type === "grouping"
          ? (groupingMembers.map((m) => ({ valueSetId: m.id, valueSetName: m.name, oid: m.oid })) as any)
          : null,
        fhir_url: `http://spehr.live/fhir/ValueSet/${slug}`,
        oid: `2.16.840.1.113883.3.spehr.${Date.now()}`,
        change_history: [{
          at: new Date().toISOString(),
          action: status === "review" ? "submitted" : "saved",
          codes: picks.length,
          author: author.trim() || null,
          binding_strength: bindingStrength,
          validated_at: lastValidatedAt,
        }],
      }, { onConflict: "name" }).select("id, status").maybeSingle();
      if (error) throw error;
      if (data?.id) setSavedId(data.id);
      setSavedStatus(status as ValueSetStatus);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2000);
      toast.success(status === "review" ? "Submitted for review" : "Draft saved");
      logActivity(status === "review" ? "submitted_review" : "saved_draft", `Saved "${name}" as ${status}`, data?.id ?? null);
      // IMPORTANT: do NOT reset name / picks / excluded / notes — keep workbench loaded
      // so the user can immediately click "Submit for Review" or keep editing.
    } catch (e: any) {
      toast.error(e.message);
    } finally { setSaving(false); }
  };

  // Steward governance: fetch current change_history, append entry, update status.
  const runStewardAction = async (decision: "approved" | "rejected", comment: string) => {
    if (!savedId) return;
    setGoverning(true);
    try {
      const { data: cur, error: readErr } = await supabase
        .from("custom_value_sets")
        .select("change_history")
        .eq("id", savedId)
        .maybeSingle();
      if (readErr) throw readErr;
      const history: any[] = Array.isArray((cur as any)?.change_history) ? (cur as any).change_history : [];
      const entry = {
        at: new Date().toISOString(),
        action: decision === "approved" ? "approved_and_published" : "rejected",
        actor_role: activeRole,
        comment: comment || null,
      };
      const nextStatus: ValueSetStatus = decision === "approved" ? "published" : "draft";
      const { error: upErr } = await supabase
        .from("custom_value_sets")
        .update({
          status: nextStatus,
          change_history: [...history, entry] as any,
          published_at: decision === "approved" ? new Date().toISOString() : null,
        })
        .eq("id", savedId);
      if (upErr) throw upErr;
      setSavedStatus(nextStatus);
      toast.success(decision === "approved" ? "Approved & published" : "Rejected — returned to draft");
      logActivity(
        decision === "approved" ? "steward_approved" : "steward_rejected",
        `Steward ${decision} "${name}"${comment ? ` — ${comment}` : ""}`,
        savedId,
      );
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setGoverning(false);
    }
  };

  // Steward controls surface whenever an item is awaiting review. Visibility
  // is NOT gated by the StaffRole string — the Authoring Workbench only
  // renders inside /system-admin, where activeRole is never "Admin", so the
  // old `activeRole === "Admin"` check made these buttons dead code.
  // Enable/disable + tooltip is driven by the role-permission
  // (dictionary.steward_approve) via gate(), consistent with the rest of app.
  const stewardAllowed = can("dictionary.steward_approve");
  const stewardVisible = savedStatus === "review";

  // Invalidate validation whenever the concept list changes.
  useEffect(() => {
    setValidationRows([]);
    setLastValidatedAt(null);
  }, [picks, excluded]);

  const runValidation = useCallback(async () => {
    if (picks.length === 0 && excluded.length === 0) {
      toast.error("Add concepts before validating");
      return;
    }
    setValidating(true);
    const all = [...picks, ...excluded];
    const initial: ValidationRow[] = all.map((p) => ({
      code: p.code, display: p.display, vocabulary: p.vocabulary,
      status: "pending", message: "Checking…",
    }));
    setValidationRows(initial);

    const VOCAB_TO_SAB: Record<string, string> = {
      "SNOMED CT": "SNOMEDCT_US",
      "ICD-10-CM": "ICD10CM",
      "LOINC": "LNC",
      "RxNorm": "RXNORM",
      "MedDRA": "MDR",
    };

    const validated = await Promise.all(all.map(async (p): Promise<ValidationRow> => {
      const sab = VOCAB_TO_SAB[p.vocabulary] ?? p.vocabulary;
      try {
        const { data, error } = await supabase.functions.invoke("umls-proxy", {
          body: {
            action: "search",
            params: { string: p.code, sabs: sab, inputType: "sourceUi", returnIdType: "sourceUi", pageSize: 1 },
          },
        });
        if (error) {
          return { code: p.code, display: p.display, vocabulary: p.vocabulary, status: "error", message: error.message ?? "Lookup failed" };
        }
        const results = ((data as any)?.result?.results ?? []).filter((r: any) => r?.ui && r.ui !== "NONE");
        if (results.length === 0) {
          return { code: p.code, display: p.display, vocabulary: p.vocabulary, status: "unknown", message: "Code not found in current UMLS release" };
        }
        const hit = results[0];
        const nameMatch = String(hit.name ?? "").toLowerCase();
        const wanted = p.display.toLowerCase();
        const mismatch = nameMatch && wanted && !nameMatch.includes(wanted.slice(0, 12)) && !wanted.includes(nameMatch.slice(0, 12));
        return {
          code: p.code, display: p.display, vocabulary: p.vocabulary,
          status: "valid",
          message: mismatch ? `Active — display differs (UMLS: "${hit.name}")` : `Active in ${p.vocabulary}`,
        };
      } catch (e: any) {
        return { code: p.code, display: p.display, vocabulary: p.vocabulary, status: "error", message: e?.message ?? "Network error" };
      }
    }));

    // Intensional check: re-resolve the anchor via hierarchyExpand and compare
    // the resulting count against the saved clause. Adds one synthetic row so
    // steward sees whether the rule still resolves.
    let finalRows = validated;
    if (type === "intensional" && intensionalClause) {
      try {
        const { data, error } = await supabase.functions.invoke("umls-proxy", {
          body: {
            action: "hierarchyExpand",
            params: {
              sab: "SNOMEDCT_US",
              code: intensionalClause.anchorCode,
              operator: intensionalClause.operator,
            },
          },
        });
        const nowCount = Array.isArray((data as any)?.codes) ? (data as any).codes.length : 0;
        const anchorLabel = `${intensionalClause.anchorCode} · ${intensionalClause.operator}`;
        let row: ValidationRow;
        if (error || nowCount === 0) {
          row = {
            code: intensionalClause.anchorCode,
            display: intensionalClause.anchorDisplay,
            vocabulary: intensionalClause.vocabulary,
            status: "unknown",
            message: `Anchor no longer resolves (${anchorLabel})`,
          };
        } else if (nowCount !== intensionalClause.count) {
          row = {
            code: intensionalClause.anchorCode,
            display: intensionalClause.anchorDisplay,
            vocabulary: intensionalClause.vocabulary,
            status: "unknown",
            message: `Expansion drifted — saved ${intensionalClause.count}, live ${nowCount} (${anchorLabel})`,
          };
        } else {
          row = {
            code: intensionalClause.anchorCode,
            display: intensionalClause.anchorDisplay,
            vocabulary: intensionalClause.vocabulary,
            status: "valid",
            message: `Expansion resolves — ${nowCount} members found (${anchorLabel})`,
          };
        }
        finalRows = [...validated, row];
      } catch (e: any) {
        finalRows = [...validated, {
          code: intensionalClause.anchorCode,
          display: intensionalClause.anchorDisplay,
          vocabulary: intensionalClause.vocabulary,
          status: "error",
          message: e?.message ?? "Anchor re-resolution failed",
        }];
      }
    }

    setValidationRows(finalRows);
    setLastValidatedAt(new Date().toISOString());
    setValidating(false);
    const bad = finalRows.filter((r) => r.status !== "valid").length;
    logActivity("validated", `Validated ${finalRows.length} concept(s) against UMLS — ${bad} issue(s)`, null);
    if (bad === 0) toast.success(`All ${finalRows.length} concept(s) valid`);
    else toast.warning(`${bad} of ${finalRows.length} concept(s) need attention`);
  }, [picks, excluded, type, intensionalClause]);

  const validationSummary = useMemo(() => {
    if (validationRows.length === 0) return null;
    const counts = { valid: 0, inactive: 0, unknown: 0, error: 0, pending: 0 };
    for (const r of validationRows) counts[r.status] += 1;
    return counts;
  }, [validationRows]);

  const canSubmitReview = useMemo(() => {
    if (!author.trim()) return false;
    if (lastValidatedAt === null) return false;
    if (validationRows.some((r) => r.status === "inactive" || r.status === "error")) return false;
    return true;
  }, [author, lastValidatedAt, validationRows]);

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-slate-200 bg-white p-5">
        <h3 className="text-lg font-semibold text-slate-900 flex items-center gap-1.5">
          🛠 Authoring Workbench
          <InfoHint
            className="ml-1.5"
            text="Search the UMLS Metathesaurus live, pick concepts by hierarchy, and assemble them into a new extensional or intensional value set. Nothing publishes automatically — Save Draft or Submit for Review when you're ready."
          />
        </h3>
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        {/* LEFT — Concept search */}
        <div className="rounded-md border border-slate-200 bg-white p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold">UMLS Concept Search</h4>
            <Select value={vocab.value} onValueChange={(v) => setVocab(VOCABS.find(x => x.value === v)!)}>
              <SelectTrigger className="h-8 w-40 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {VOCABS.map(v => <SelectItem key={v.value} value={v.value}>{v.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="relative">
            <Search className="absolute left-2 top-2.5 h-3.5 w-3.5 text-slate-400" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (timer.current) clearTimeout(timer.current);
                  runSearch(query);
                }
              }}
              placeholder="Search concepts..."
              className="pl-7 h-8 text-xs"
            />
            {searching && <Loader2 className="absolute right-2 top-2 h-4 w-4 animate-spin text-slate-400" />}
          </div>
          {searchErr && (
            <div className="text-[11px] text-rose-600">{searchErr}</div>
          )}

          <div className="border border-slate-200 rounded max-h-[28rem] overflow-y-auto divide-y divide-slate-100">
            {results.length === 0 && !searching && (
              <div className="px-3 py-4 text-xs text-slate-500 text-center">
                Search for clinical concepts (e.g. "myocardial infarction", "metformin", "troponin").
              </div>
            )}
            {results.map((hit, i) => (
              <div key={`${hit.ui}-${i}`} className="px-3 py-2 hover:bg-slate-50 group">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-[11px] font-semibold text-slate-900">{hit.ui}</div>
                    <div className="text-xs text-slate-700 truncate">{hit.name}</div>
                    <div className="text-[10px] text-slate-500">{vocab.label}</div>
                  </div>
                  <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition">
                    {intensionalActive ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 text-[10px] px-2"
                        onClick={() => setAsAnchor(hit)}
                      >
                        <Target className="h-3 w-3" /> Set as Anchor
                      </Button>
                    ) : (
                      <>
                        <Button size="sm" variant="outline" className="h-6 text-[10px] px-2" onClick={() => addPick(hit, false)}>
                          <Plus className="h-3 w-3" /> Include
                        </Button>
                        <Button size="sm" variant="outline" className="h-6 text-[10px] px-2" onClick={() => addPick(hit, true)}>
                          <X className="h-3 w-3" /> Exclude
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* RIGHT — Active value set editor */}
        <div className="rounded-md border border-slate-200 bg-white p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex-1 flex items-center gap-2">
              <Input
                value={name}
                onChange={(e) => { setName(e.target.value); setSavedStatus(null); setSavedId(null); }}
                placeholder="Active Value Set Name…"
                className="h-8 text-sm font-semibold"
              />
              {savedStatus && (
                <span className={`text-[10px] px-2 py-0.5 rounded border font-semibold whitespace-nowrap ${
                  savedStatus === "draft" ? "bg-slate-100 text-slate-700 border-slate-200"
                  : savedStatus === "review" ? "bg-amber-100 text-amber-800 border-amber-200"
                  : savedStatus === "rejected" ? "bg-rose-100 text-rose-800 border-rose-200"
                  : savedStatus === "approved" ? "bg-sky-100 text-sky-800 border-sky-200"
                  : "bg-emerald-100 text-emerald-800 border-emerald-200"
                }`}>
                  {savedStatus === "draft" ? "Saved as Draft"
                    : savedStatus === "review" ? "In Review"
                    : savedStatus === "rejected" ? "Rejected"
                    : savedStatus === "approved" ? "Approved"
                    : "Published"}
                </span>
              )}
            </div>
            <div className="flex gap-1.5">
              <Button size="sm" variant="outline" onClick={() => save("draft")} disabled={saving}>
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : savedFlash ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Save className="h-3.5 w-3.5" />}
                {savedFlash ? "Saved ✓" : "Save Draft"}
              </Button>
              <Button
                size="sm"
                className="bg-[#0c2340] hover:bg-[#0c2340]/90"
                onClick={() => save("review")}
                disabled={saving || !canSubmitReview || (savedStatus !== null && savedStatus !== "draft")}
                title={!canSubmitReview ? "Requires Author and a passing validation run" : undefined}>
                <Send className="h-3.5 w-3.5" /> Submit for Review
              </Button>
              {stewardVisible && (
                <>
                  <Button
                    size="sm"
                    className="bg-emerald-600 hover:bg-emerald-700 text-white"
                    {...gate("dictionary.steward_approve", () => {
                      if (governing) return;
                      void runStewardAction("approved", "");
                    })}
                  >
                    {governing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                    Approve & Publish
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-rose-200 text-rose-700 hover:bg-rose-50"
                    {...gate("dictionary.steward_approve", () => {
                      if (governing) return;
                      const comment = window.prompt("Reason for rejection (required):", "")?.trim() ?? "";
                      if (!comment) {
                        toast.error("A rejection comment is required");
                        return;
                      }
                      void runStewardAction("rejected", comment);
                    })}
                  >
                    <XCircle className="h-3.5 w-3.5" /> Reject
                  </Button>
                </>
              )}
            </div>
          </div>
          {stewardVisible && !stewardAllowed && (
            <div className="text-[10px] text-amber-700 flex items-start gap-1">
              <AlertTriangle className="h-3 w-3 mt-[1px]" />
              <span>Steward approve/publish is disabled for your role at this facility. A Site Manager can enable it in System Admin.</span>
            </div>
          )}
          <div className="flex items-center gap-3 text-xs">
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={type === "extensional"} onChange={() => setType("extensional")} />
              Extensional
            </label>
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={type === "intensional"} onChange={() => setType("intensional")} />
              Intensional
            </label>
            <span className="text-slate-400">·</span>
            <span className="text-slate-600">Vocabulary: <strong>{vocab.label}</strong></span>
          </div>

          {type === "intensional" && !isSnomed && (
            <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800 flex items-start gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5 mt-[1px] shrink-0" />
              <span>Intensional (hierarchy-rule) authoring is SNOMED CT only for now. Switch the vocabulary to SNOMED CT to use anchor + operator expansion, or keep the type as Extensional for {vocab.label}.</span>
            </div>
          )}

          {intensionalActive && (
            <div className="rounded border border-sky-200 bg-sky-50/50 p-3 space-y-2">
              <div className="flex items-center gap-1.5 text-[11px] font-semibold text-sky-900">
                <Layers className="h-3.5 w-3.5" /> Intensional Hierarchy Rule (SNOMED CT)
              </div>
              <div className="text-[11px] text-slate-700">
                Anchor:{" "}
                {anchor ? (
                  <span>
                    <span className="font-mono">{anchor.code}</span> · {anchor.display}
                  </span>
                ) : (
                  <span className="text-slate-500">None — pick a concept in the search panel and click "Set as Anchor".</span>
                )}
              </div>
              <div className="grid grid-cols-[1fr_auto_auto] gap-2 items-center">
                <Select value={operator} onValueChange={(v) => setOperator(v as HierarchyOperator)}>
                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {HIERARCHY_OPERATORS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 text-[11px]"
                  onClick={previewExpansion}
                  disabled={!anchor || expanding}
                >
                  {expanding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
                  Preview Expansion
                </Button>
                <Button
                  size="sm"
                  className="h-8 text-[11px] bg-[#0c2340] hover:bg-[#0c2340]/90"
                  onClick={applyExpansionToValueSet}
                  disabled={!anchor || expansion.length === 0}
                >
                  <Download className="h-3.5 w-3.5" /> Apply to Value Set
                </Button>
              </div>
              {expansionTruncated && (
                <div className="text-[10px] text-amber-800 flex items-start gap-1">
                  <AlertTriangle className="h-3 w-3 mt-[1px]" />
                  <span>Expansion truncated at 500 members. Narrow the anchor or use a more specific operator (e.g. childOf).</span>
                </div>
              )}
              {expansion.length > 0 && (
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold mb-1">
                    Expansion Preview ({expansion.length} member{expansion.length === 1 ? "" : "s"})
                  </div>
                  <ul className="border border-slate-200 rounded max-h-40 overflow-y-auto text-[11px] divide-y divide-slate-100 bg-white">
                    {expansion.map((c) => (
                      <li key={c.code} className="px-2 py-1 flex gap-2">
                        <span className="font-mono text-slate-900">{c.code}</span>
                        <span className="truncate text-slate-700">{c.name}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {intensionalClause && (
                <div className="text-[10px] text-slate-600">
                  Saved rule: <span className="font-mono">{intensionalClause.operator}</span> of{" "}
                  <span className="font-mono">{intensionalClause.anchorCode}</span>
                  {" "}({intensionalClause.count} members at {new Date(intensionalClause.computedAt).toLocaleTimeString()})
                </div>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <div>
              <div className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold mb-1 flex items-center gap-1">
                <ShieldCheck className="h-3 w-3" /> Author
              </div>
              <Input
                value={author}
                onChange={(e) => setAuthor(e.target.value)}
                placeholder="e.g. Dr. J. Smith"
                className="h-8 text-xs"
              />
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold mb-1 flex items-center gap-1">
                <ShieldCheck className="h-3 w-3" /> Binding Strength
              </div>
              <Select value={bindingStrength} onValueChange={(v) => setBindingStrength(v as BindingStrength)}>
                <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {BINDING_STRENGTHS.map((b) => (
                    <SelectItem key={b} value={b}>{b}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div>
            <div className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold mb-1">
              Included Concepts ({picks.length})
            </div>
            <div className="border border-slate-200 rounded max-h-44 overflow-y-auto">
              {picks.length === 0 && <div className="px-3 py-3 text-[11px] text-slate-400">No concepts yet — pick from the search panel.</div>}
              {picks.map(p => (
                <div key={p.code} className="flex items-center justify-between px-3 py-1.5 border-b border-slate-100 text-[11px] hover:bg-slate-50">
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <Check className="h-3 w-3 text-emerald-600" />
                    <span className="font-mono">{p.code}</span>
                    <span className="truncate text-slate-700">{p.display}</span>
                  </div>
                  <button onClick={() => removePick(p.code, "in")} className="text-slate-400 hover:text-rose-600"><X className="h-3 w-3" /></button>
                </div>
              ))}
            </div>
          </div>

          <div>
            <div className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold mb-1">
              Excluded Concepts ({excluded.length})
            </div>
            <div className="border border-slate-200 rounded max-h-32 overflow-y-auto">
              {excluded.length === 0 && <div className="px-3 py-2 text-[11px] text-slate-400">None excluded.</div>}
              {excluded.map(p => (
                <div key={p.code} className="flex items-center justify-between px-3 py-1.5 border-b border-slate-100 text-[11px]">
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <X className="h-3 w-3 text-rose-600" />
                    <span className="font-mono">{p.code}</span>
                    <span className="truncate text-slate-700">{p.display}</span>
                  </div>
                  <button onClick={() => removePick(p.code, "out")} className="text-slate-400 hover:text-rose-600"><X className="h-3 w-3" /></button>
                </div>
              ))}
            </div>
          </div>

          <div>
            <div className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold mb-1">Editorial Notes</div>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Add note about authoring decision..." className="text-xs" />
          </div>

          <div>
            <div className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold mb-1 flex items-center justify-between">
              <span>Validation</span>
              <Button size="sm" variant="outline" className="h-6 text-[10px] px-2"
                onClick={runValidation}
                disabled={validating || (picks.length === 0 && excluded.length === 0)}>
                {validating ? <Loader2 className="h-3 w-3 animate-spin" /> : <ShieldCheck className="h-3 w-3" />}
                {validating ? "Validating…" : "Run Validation"}
              </Button>
            </div>
            {validationRows.length === 0 ? (
              <div className="text-[11px] text-slate-400">
                {lastValidatedAt === null
                  ? "Not yet validated. Run validation to check each concept against the live UMLS release."
                  : "No concepts to validate."}
              </div>
            ) : (
              <>
                {validationSummary && (
                  <div className="text-[11px] mb-1 flex flex-wrap gap-2">
                    <span className="text-emerald-700">✓ {validationSummary.valid} valid</span>
                    {validationSummary.unknown > 0 && <span className="text-amber-700">⚠ {validationSummary.unknown} unknown</span>}
                    {validationSummary.inactive > 0 && <span className="text-rose-700">✗ {validationSummary.inactive} inactive</span>}
                    {validationSummary.error > 0 && <span className="text-rose-700">! {validationSummary.error} errored</span>}
                    <span className="text-slate-600">· Binding: <strong>{bindingStrength}</strong></span>
                    {lastValidatedAt && <span className="text-slate-500">· {new Date(lastValidatedAt).toLocaleTimeString()}</span>}
                  </div>
                )}
                <ul className="text-[11px] space-y-0.5 max-h-40 overflow-y-auto border border-slate-200 rounded p-2">
                  {validationRows.map((r) => (
                    <li key={`${r.vocabulary}:${r.code}`} className={
                      r.status === "valid" ? "text-emerald-700"
                      : r.status === "pending" ? "text-slate-500"
                      : r.status === "unknown" ? "text-amber-700"
                      : "text-rose-700"
                    }>
                      {r.status === "valid" ? "✓" : r.status === "pending" ? "…" : r.status === "unknown" ? "⚠" : r.status === "inactive" ? "✗" : "!"}
                      {" "}
                      <span className="font-mono">{r.code}</span> · {r.message}
                    </li>
                  ))}
                </ul>
                {!canSubmitReview && lastValidatedAt && (
                  <div className="text-[10px] text-amber-700 mt-1 flex items-start gap-1">
                    <AlertTriangle className="h-3 w-3 mt-[1px]" />
                    <span>Submit for Review is blocked until Author is set and all concepts pass validation.</span>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-[10px]">
        <div className="font-semibold text-slate-600 mb-1">Authoring Activity Log</div>
        {log.length === 0 ? (
          <div className="text-slate-400">No activity yet.</div>
        ) : (
          <ul className="font-mono text-slate-700 space-y-0.5 max-h-40 overflow-y-auto">
            {log.map((e) => (
              <li key={e.id}>
                <span className="text-slate-400">{new Date(e.created_at).toLocaleTimeString()}</span>
                {" · "}
                <span className="text-slate-500">{e.actor}</span>
                {" · "}
                <span>{e.message}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <details className="rounded-md border border-emerald-200 bg-emerald-50/60 p-4">
        <summary className="cursor-pointer text-sm font-semibold text-slate-900">
          ⚡ FHIR Operation · CodeSystem/$lookup
        </summary>
        <p className="text-[11px] text-slate-600 mt-1 mb-3">
          Look up the meaning of a specific code in any supported code system while drafting a value set.
        </p>
        <LookupCard />
      </details>
    </div>
  );
}