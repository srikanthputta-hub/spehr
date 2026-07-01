import { useEffect, useMemo, useState } from "react";
import { Plus, Download, Upload, Loader2, FileJson, Copy, Play, Save, Check, Trash2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { toast } from "sonner";

type ValueSet = {
  id: string;
  name: string;
  oid: string | null;
  vocabulary: string | null;
  type: "extensional" | "intensional";
  codes: any[];
  intensional_rule: any | null;
  status: "draft" | "review" | "published" | "deprecated";
  clinical_application: string | null;
  fhir_url: string | null;
  steward: string | null;
  peer_reviewer: string | null;
  version: string | null;
  binding_strength: string | null;
  description: string | null;
  updated_at: string;
};

const STATUS_STYLES: Record<string, string> = {
  published: "bg-emerald-100 text-emerald-800 border-emerald-200",
  review: "bg-amber-100 text-amber-800 border-amber-200",
  draft: "bg-slate-100 text-slate-700 border-slate-200",
  deprecated: "bg-rose-100 text-rose-800 border-rose-200",
};

const TYPE_STYLES: Record<string, string> = {
  extensional: "bg-sky-100 text-sky-800 border-sky-200",
  intensional: "bg-violet-100 text-violet-800 border-violet-200",
};

export function ValueSetLibrary() {
  const [rows, setRows] = useState<ValueSet[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ValueSet | null>(null);
  const [publishTarget, setPublishTarget] = useState<ValueSet | null>(null);
  const [deprecateTarget, setDeprecateTarget] = useState<ValueSet | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ValueSet | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const { data, error } = await supabase
        .from("custom_value_sets")
        .select("*")
        .order("status", { ascending: true })
        .order("name", { ascending: true });
      if (!alive) return;
      if (!error && data) setRows(data as any);
      setLoading(false);
    };
    load();
    const ch = supabase
      .channel("value-sets-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "custom_value_sets" }, load)
      .subscribe();
    return () => { alive = false; supabase.removeChannel(ch); };
  }, []);

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return rows;
    return rows.filter(r =>
      r.name.toLowerCase().includes(q) ||
      (r.oid ?? "").toLowerCase().includes(q) ||
      (r.vocabulary ?? "").toLowerCase().includes(q),
    );
  }, [rows, query]);

  const transitionStatus = async (
    row: ValueSet,
    next: ValueSet["status"],
    confirmMsg: string | null,
    successMsg: string,
    extra: Record<string, unknown> = {},
  ) => {
    if (confirmMsg && !confirm(confirmMsg)) return;
    const history = Array.isArray((row as any).change_history) ? (row as any).change_history : [];
    const { error } = await supabase
      .from("custom_value_sets")
      .update({
        status: next,
        ...extra,
        change_history: [...history, {
          at: new Date().toISOString(),
          actor: "S.P.E.H.R. Terminology Services",
          change: `Status: ${row.status} → ${next}`,
        }],
        updated_at: new Date().toISOString(),
      } as any)
      .eq("id", row.id);
    if (error) return toast.error(error.message);
    toast.success(successMsg);
    setRows(rs => rs.map(r => r.id === row.id ? { ...r, status: next, ...(extra as any) } : r));
    setSelected(s => s && s.id === row.id ? { ...s, status: next, ...(extra as any) } : s);
  };

  const handleDelete = async (row: ValueSet) => {
    const { error } = await supabase.from("custom_value_sets").delete().eq("id", row.id);
    if (error) return toast.error(error.message);
    toast.success(`Deleted "${row.name}"`);
    setRows(rs => rs.filter(r => r.id !== row.id));
    setSelected(s => s && s.id === row.id ? null : s);
  };

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-slate-200 bg-white p-5">
        <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
          <div>
            <h3 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
              📚 Value Set Library
            </h3>
            <p className="text-xs text-slate-500 mt-1 max-w-2xl">
              VSAC-aligned value set repository. Browse, author, and publish extensional
              and intensional value sets across SNOMED CT, ICD-10-CM, LOINC, RxNorm, CPT, and MedDRA.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => toast.info("Use Authoring Workbench to create a new value set")}>
              <Plus className="h-3.5 w-3.5" /> New Value Set
            </Button>
            <Button size="sm" variant="outline" onClick={() => toast.info("VSAC import coming soon")}>
              <Upload className="h-3.5 w-3.5" /> Import from VSAC
            </Button>
            <Button size="sm" variant="outline" onClick={() => exportBundle(rows)}>
              <Download className="h-3.5 w-3.5" /> Export FHIR Bundle
            </Button>
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search value sets..."
              className="h-8 text-xs w-56"
            />
          </div>
        </div>

        <div className="overflow-hidden rounded border border-slate-200">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="text-left px-3 py-2 font-semibold">Value Set Name</th>
                <th className="text-left px-3 py-2 font-semibold">OID / Identifier</th>
                <th className="text-left px-3 py-2 font-semibold">Vocabulary</th>
                <th className="text-left px-3 py-2 font-semibold">Type</th>
                <th className="text-right px-3 py-2 font-semibold">Codes</th>
                <th className="text-left px-3 py-2 font-semibold">Status</th>
                <th className="text-left px-3 py-2 font-semibold">Last Updated</th>
                <th className="text-right px-3 py-2 font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 bg-white">
              {loading && (
                <tr><td colSpan={8} className="px-3 py-6 text-center text-slate-500">
                  <Loader2 className="h-4 w-4 animate-spin inline mr-2" /> Loading value sets…
                </td></tr>
              )}
              {!loading && filtered.length === 0 && (
                <tr><td colSpan={8} className="px-3 py-6 text-center text-slate-500">No value sets match.</td></tr>
              )}
              {filtered.map(r => (
                <tr key={r.id} className="hover:bg-slate-50 cursor-pointer" onClick={() => setSelected(r)}>
                  <td className="px-3 py-2 font-semibold text-slate-900">{r.name}</td>
                  <td className="px-3 py-2 font-mono text-[10px] text-slate-600">{r.oid ?? "—"}</td>
                  <td className="px-3 py-2 text-slate-700">{r.vocabulary ?? "—"}</td>
                  <td className="px-3 py-2">
                    <span className={`inline-block px-2 py-0.5 rounded border text-[10px] font-semibold capitalize ${TYPE_STYLES[r.type] ?? ""}`}>
                      {r.type}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right font-mono">{Array.isArray(r.codes) ? r.codes.length : 0}</td>
                  <td className="px-3 py-2">
                    <StatusBadge
                      row={r}
                      onSubmit={() => transitionStatus(r, "review",
                        `Submit "${r.name}" for review?`, "Submitted for review")}
                      onOpenPublish={() => setPublishTarget(r)}
                      onOpenDeprecate={() => setDeprecateTarget(r)}
                    />
                  </td>
                  <td className="px-3 py-2 text-slate-500">{new Date(r.updated_at).toLocaleDateString()}</td>
                  <td className="px-3 py-2 text-right">
                    <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); setSelected(r); }}>
                      Open
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <ValueSetDrawer
        vs={selected}
        onClose={() => setSelected(null)}
        onSubmitForReview={(r) => transitionStatus(r, "review",
          `Submit "${r.name}" for review?`, "Submitted for review")}
        onApprove={(r) => setPublishTarget(r)}
        onRequestChanges={(r) => transitionStatus(r, "draft",
          `Send "${r.name}" back to draft?`, "Returned to draft")}
        onDeprecate={(r) => setDeprecateTarget(r)}
      />

      <Dialog open={!!publishTarget} onOpenChange={(o) => !o && setPublishTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Approve & Publish</DialogTitle>
            <DialogDescription>
              This will publish <span className="font-semibold">{publishTarget?.name}</span> and make it available for clinical use. Confirm?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={async () => {
              const t = publishTarget; if (!t) return;
              setPublishTarget(null);
              await transitionStatus(t, "draft", null, "Returned to draft for changes");
            }}>Request Changes</Button>
            <Button className="bg-emerald-600 hover:bg-emerald-700 text-white" onClick={async () => {
              const t = publishTarget; if (!t) return;
              setPublishTarget(null);
              await transitionStatus(t, "published", null, "Published successfully", { published_at: new Date().toISOString() });
            }}>Approve & Publish</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deprecateTarget} onOpenChange={(o) => !o && setDeprecateTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Deprecate this value set?</DialogTitle>
            <DialogDescription>
              <span className="font-semibold">{deprecateTarget?.name}</span> will be marked inactive in the registry. Existing references remain but new bindings are discouraged.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setDeprecateTarget(null)}>Cancel</Button>
            <Button className="bg-rose-600 hover:bg-rose-700 text-white" onClick={async () => {
              const t = deprecateTarget; if (!t) return;
              setDeprecateTarget(null);
              await transitionStatus(t, "deprecated", null, "Deprecated");
            }}>Confirm Deprecate</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StatusBadge({
  row, onSubmit, onOpenPublish, onOpenDeprecate,
}: {
  row: ValueSet;
  onSubmit: () => void;
  onOpenPublish: () => void;
  onOpenDeprecate: () => void;
}) {
  const cls = `inline-block px-2 py-0.5 rounded border text-[10px] font-semibold capitalize cursor-pointer ${STATUS_STYLES[row.status] ?? ""}`;
  if (row.status === "draft") {
    return (
      <button className={`${cls} hover:ring-2 hover:ring-slate-300`}
        onClick={(e) => { e.stopPropagation(); onSubmit(); }}
        title="Submit for review">
        draft ▸
      </button>
    );
  }
  if (row.status === "review") {
    return (
      <button className={`${cls} hover:ring-2 hover:ring-amber-300`}
        onClick={(e) => { e.stopPropagation(); onOpenPublish(); }}
        title="Approve & publish or request changes">
        In Review ▸
      </button>
    );
  }
  if (row.status === "published") {
    return (
      <button className={`${cls} hover:ring-2 hover:ring-rose-300`}
        onClick={(e) => { e.stopPropagation(); onOpenDeprecate(); }}
        title="Deprecate this value set">
        published ▸
      </button>
    );
  }
  return <span className={cls}>{row.status}</span>;
}

function exportBundle(rows: ValueSet[]) {
  const bundle = {
    resourceType: "Bundle",
    type: "collection",
    entry: rows.map(r => ({ resource: toFhirValueSet(r) })),
  };
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/fhir+json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `spehr-value-sets-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast.success(`Exported ${rows.length} value sets`);
}

function toFhirValueSet(vs: ValueSet) {
  const systemUri = sysUri(vs.vocabulary ?? "");
  const base: any = {
    resourceType: "ValueSet",
    id: slug(vs.name),
    url: vs.fhir_url,
    identifier: vs.oid ? [{ system: "urn:ietf:rfc:3986", value: `urn:oid:${vs.oid}` }] : undefined,
    version: vs.version ?? "1.0.0",
    name: vs.name.replace(/[^A-Za-z0-9]/g, ""),
    title: vs.name,
    status: vs.status === "published" ? "active" : vs.status === "draft" ? "draft" : "active",
    experimental: vs.status !== "published",
    description: vs.description,
  };
  if (vs.type === "intensional" && vs.intensional_rule?.rootConcept) {
    base.compose = {
      include: [{
        system: systemUri,
        filter: [{ property: "concept", op: "is-a", value: vs.intensional_rule.rootConcept }],
      }],
    };
  } else {
    base.compose = {
      include: [{
        system: systemUri,
        concept: (vs.codes ?? []).map((c: any) => ({ code: c.code, display: c.display })),
      }],
    };
  }
  return base;
}

function sysUri(v: string): string {
  if (/snomed/i.test(v)) return "http://snomed.info/sct";
  if (/icd-?10/i.test(v)) return "http://hl7.org/fhir/sid/icd-10-cm";
  if (/loinc/i.test(v)) return "http://loinc.org";
  if (/rxnorm/i.test(v)) return "http://www.nlm.nih.gov/research/umls/rxnorm";
  if (/cpt/i.test(v)) return "http://www.ama-assn.org/go/cpt";
  if (/meddra/i.test(v)) return "http://terminology.hl7.org/CodeSystem/meddra";
  return "urn:oid:unknown";
}

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function ValueSetDrawer({
  vs, onClose, onSubmitForReview, onApprove, onRequestChanges, onDeprecate,
}: {
  vs: ValueSet | null;
  onClose: () => void;
  onSubmitForReview: (r: ValueSet) => void;
  onApprove: (r: ValueSet) => void;
  onRequestChanges: (r: ValueSet) => void;
  onDeprecate: (r: ValueSet) => void;
}) {
  const [expanding, setExpanding] = useState(false);
  const [expansion, setExpansion] = useState<any>(null);
  const [copied, setCopied] = useState(false);

  // --- Editable Rule state (intensional) -----------------------------------
  const [ruleRoot, setRuleRoot] = useState("");
  const [ruleRootName, setRuleRootName] = useState("");
  const [ruleInclude, setRuleInclude] = useState<"descendants" | "children">("descendants");
  const [ruleExclude, setRuleExclude] = useState("");
  const [ruleActiveOnly, setRuleActiveOnly] = useState(true);
  const [savingRule, setSavingRule] = useState(false);
  const [previewCount, setPreviewCount] = useState<number | null>(null);

  // --- Editable Metadata state --------------------------------------------
  const [metaPurpose, setMetaPurpose] = useState("");
  const [metaBinding, setMetaBinding] = useState("preferred");
  const [metaApp, setMetaApp] = useState("");
  const [metaVersion, setMetaVersion] = useState("1.0.0");
  const [savingMeta, setSavingMeta] = useState(false);

  useEffect(() => {
    setExpansion(null);
    setPreviewCount(null);
    setCopied(false);
    if (vs) {
      const r = vs.intensional_rule ?? {};
      setRuleRoot(r.rootConcept ?? "");
      setRuleRootName(r.rootDisplay ?? "");
      setRuleInclude(r.include === "children" ? "children" : "descendants");
      setRuleExclude(Array.isArray(r.exclude) ? r.exclude.join(", ") : (r.exclude ?? ""));
      setRuleActiveOnly(r.activeOnly !== false);
      setMetaPurpose(vs.description ?? "");
      setMetaBinding(vs.binding_strength ?? "preferred");
      setMetaApp(vs.clinical_application ?? "");
      setMetaVersion(vs.version ?? "1.0.0");
    }
  }, [vs?.id]);

  if (!vs) return null;

  const slugName = slug(vs.name);
  const autoFhirUrl = `http://spehr.live/fhir/ValueSet/${slugName}`;
  const fhir = toFhirValueSet({ ...vs, fhir_url: vs.fhir_url ?? autoFhirUrl });
  const fhirJson = JSON.stringify(fhir, null, 2);
  const changeHistory: any[] = Array.isArray((vs as any).change_history) ? (vs as any).change_history : [];

  const runExpand = async () => {
    setExpanding(true);
    try {
      const { data: row, error } = await supabase
        .from("custom_value_sets")
        .select("codes, status, name")
        .eq("name", vs.name)
        .maybeSingle();
      if (error) throw error;
      const codes = Array.isArray((row as any)?.codes) ? (row as any).codes : [];
      const sysFor = (v: string) =>
        v === "ICD-10-CM" ? "http://hl7.org/fhir/sid/icd-10-cm"
        : v === "SNOMED CT" ? "http://snomed.info/sct"
        : v === "LOINC" ? "http://loinc.org"
        : v === "RxNorm" ? "http://www.nlm.nih.gov/research/umls/rxnorm"
        : v === "CPT" ? "http://www.ama-assn.org/go/cpt"
        : "unknown";
      const expanded = {
        resourceType: "ValueSet",
        status: (row as any)?.status ?? "unknown",
        expansion: {
          timestamp: new Date().toISOString(),
          total: codes.length,
          contains: codes.map((c: any) => ({
            system: sysFor(c.vocabulary ?? vs.vocabulary),
            code: c.code,
            display: c.display,
          })),
        },
      };
      setExpansion(expanded);
      toast.success(`Expanded to ${codes.length} concepts`);
    } catch (e: any) {
      toast.error(`$expand failed: ${e.message}`);
    } finally { setExpanding(false); }
  };

  const previewRule = async () => {
    if (!ruleRoot && !ruleRootName) return toast.error("Set a root concept first");
    setExpanding(true);
    try {
      const { data } = await supabase.functions.invoke("umls-proxy", {
        body: { action: "search", params: { string: ruleRootName || ruleRoot, sabs: "SNOMEDCT_US", pageSize: 50 } },
      });
      const total = data?.result?.recCount ?? data?.result?.results?.length ?? 0;
      setPreviewCount(total);
      toast.success(`Rule expands to ${total} concepts in SNOMED CT`);
    } catch (e: any) { toast.error(e.message); }
    finally { setExpanding(false); }
  };

  const saveRule = async () => {
    setSavingRule(true);
    const rule = {
      rootConcept: ruleRoot,
      rootDisplay: ruleRootName,
      include: ruleInclude,
      exclude: ruleExclude.split(",").map(s => s.trim()).filter(Boolean),
      activeOnly: ruleActiveOnly,
    };
    const { error } = await supabase
      .from("custom_value_sets")
      .update({ intensional_rule: rule, updated_at: new Date().toISOString() })
      .eq("id", vs.id);
    setSavingRule(false);
    if (error) return toast.error(error.message);
    toast.success("Rule saved");
  };

  const saveMetadata = async () => {
    setSavingMeta(true);
    const history = [...changeHistory, {
      at: new Date().toISOString(),
      actor: "S.P.E.H.R. Terminology Services",
      change: `Metadata updated (binding=${metaBinding}, version=${metaVersion})`,
    }];
    const { error } = await supabase
      .from("custom_value_sets")
      .update({
        description: metaPurpose,
        binding_strength: metaBinding,
        clinical_application: metaApp,
        version: metaVersion,
        fhir_url: autoFhirUrl,
        change_history: history,
        updated_at: new Date().toISOString(),
      } as any)
      .eq("id", vs.id);
    setSavingMeta(false);
    if (error) return toast.error(error.message);
    toast.success("Metadata saved");
  };

  const copyJson = async () => {
    await navigator.clipboard.writeText(fhirJson);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const downloadJson = () => {
    const blob = new Blob([fhirJson], { type: "application/fhir+json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${slugName}.json`; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Sheet open={!!vs} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-2xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            {vs.name}
            {vs.status === "draft" ? (
              <button
                className={`text-[10px] px-2 py-0.5 rounded border font-semibold hover:ring-2 hover:ring-slate-300 ${STATUS_STYLES[vs.status]}`}
                onClick={() => onSubmitForReview(vs)}
                title="Submit for review">
                draft ▸ submit
              </button>
            ) : vs.status === "review" ? (
              <span className="inline-flex items-center gap-1">
                <span className={`text-[10px] px-2 py-0.5 rounded border font-semibold ${STATUS_STYLES[vs.status]}`}>In Review</span>
                <button className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-600 text-white hover:bg-emerald-700"
                  onClick={() => onApprove(vs)}>Approve & Publish</button>
                <button className="text-[10px] px-1.5 py-0.5 rounded bg-amber-600 text-white hover:bg-amber-700"
                  onClick={() => onRequestChanges(vs)}>Request Changes</button>
              </span>
            ) : vs.status === "published" ? (
              <button
                className={`text-[10px] px-2 py-0.5 rounded border font-semibold capitalize cursor-pointer hover:ring-2 hover:ring-rose-300 ${STATUS_STYLES[vs.status]}`}
                onClick={() => onDeprecate(vs)}
                title="Deprecate this value set">
                published ▸
              </button>
            ) : (
              <span className={`text-[10px] px-2 py-0.5 rounded border font-semibold ${STATUS_STYLES[vs.status] ?? ""}`}>
                {vs.status}
              </span>
            )}
            <span className={`text-[10px] px-2 py-0.5 rounded border font-semibold capitalize ${TYPE_STYLES[vs.type] ?? ""}`}>
              {vs.type}
            </span>
          </SheetTitle>
          <SheetDescription className="font-mono text-[10px]">
            OID {vs.oid} · v{vs.version ?? "1.0.0"} · updated {new Date(vs.updated_at).toLocaleString()}
          </SheetDescription>
        </SheetHeader>

        <Tabs defaultValue="members" className="mt-4">
          <TabsList className="grid grid-cols-4 w-full">
            <TabsTrigger value="members">Concept Members</TabsTrigger>
            <TabsTrigger value="rule" disabled={vs.type !== "intensional"}>Rule Editor</TabsTrigger>
            <TabsTrigger value="meta">Metadata</TabsTrigger>
            <TabsTrigger value="fhir">FHIR Preview</TabsTrigger>
          </TabsList>

          <TabsContent value="members" className="mt-3 space-y-2">
            {vs.type === "intensional" && (
              <div className="rounded border border-violet-200 bg-violet-50 px-3 py-2 text-[11px] text-violet-900">
                Rule-generated — expands dynamically. Use <strong>$expand</strong> below to materialize the current expansion.
              </div>
            )}
            <table className="w-full text-[11px] border border-slate-200">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="text-left px-2 py-1.5 font-semibold">Code</th>
                  <th className="text-left px-2 py-1.5 font-semibold">Display</th>
                  <th className="text-left px-2 py-1.5 font-semibold">Vocabulary</th>
                  <th className="text-left px-2 py-1.5 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {(vs.codes ?? []).map((c: any, i: number) => (
                  <tr key={i} className="hover:bg-slate-50">
                    <td className="px-2 py-1.5 font-mono">{c.code}</td>
                    <td className="px-2 py-1.5">{c.display}</td>
                    <td className="px-2 py-1.5 text-slate-600">{c.vocabulary ?? vs.vocabulary}</td>
                    <td className="px-2 py-1.5"><span className="text-emerald-700">● active</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TabsContent>

          <TabsContent value="rule" className="mt-3 space-y-3 text-xs">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <div className="text-[10px] uppercase font-semibold text-slate-500 mb-1">Root Concept Code</div>
                <Input value={ruleRoot} onChange={(e) => setRuleRoot(e.target.value)} className="h-8 text-xs font-mono" placeholder="e.g. 22298006" />
              </div>
              <div>
                <div className="text-[10px] uppercase font-semibold text-slate-500 mb-1">Root Concept Name</div>
                <Input value={ruleRootName} onChange={(e) => setRuleRootName(e.target.value)} className="h-8 text-xs" placeholder="e.g. Myocardial infarction" />
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase font-semibold text-slate-500 mb-1">Include</div>
              <Select value={ruleInclude} onValueChange={(v) => setRuleInclude(v as any)}>
                <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="descendants">All descendants</SelectItem>
                  <SelectItem value="children">Direct children only</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <div className="text-[10px] uppercase font-semibold text-slate-500 mb-1">Exclude concepts (comma-separated codes)</div>
              <Input value={ruleExclude} onChange={(e) => setRuleExclude(e.target.value)} className="h-8 text-xs font-mono" placeholder="e.g. 123456, 789012" />
            </div>
            <label className="flex items-center gap-2 text-[11px] text-slate-700">
              <Checkbox checked={ruleActiveOnly} onCheckedChange={(v) => setRuleActiveOnly(!!v)} />
              Active concepts only
            </label>
            <div className="flex items-center gap-2 pt-1">
              <Button size="sm" variant="outline" onClick={previewRule} disabled={expanding}>
                {expanding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />} Preview Expansion
              </Button>
              <Button size="sm" className="bg-[#0c2340] hover:bg-[#0c2340]/90" onClick={saveRule} disabled={savingRule}>
                {savingRule ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} Save Rule
              </Button>
            </div>
            {previewCount !== null && (
              <div className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-[11px] text-emerald-900">
                This rule currently expands to <strong>{previewCount}</strong> concepts in SNOMED CT.
              </div>
            )}
          </TabsContent>

          <TabsContent value="meta" className="mt-3 space-y-3 text-xs">
            <div>
              <div className="text-[10px] uppercase font-semibold text-slate-500 mb-1">Purpose / Use Case</div>
              <Textarea value={metaPurpose} onChange={(e) => setMetaPurpose(e.target.value)} className="text-xs" rows={3} />
            </div>
            <div>
              <div className="text-[10px] uppercase font-semibold text-slate-500 mb-1">FHIR Value Set URL (auto)</div>
              <Input value={autoFhirUrl} readOnly className="h-8 text-xs font-mono bg-slate-50" />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <div className="text-[10px] uppercase font-semibold text-slate-500 mb-1">HL7 Binding Strength</div>
                <Select value={metaBinding} onValueChange={setMetaBinding}>
                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="required">Required</SelectItem>
                    <SelectItem value="preferred">Preferred</SelectItem>
                    <SelectItem value="extensible">Extensible</SelectItem>
                    <SelectItem value="example">Example</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <div className="text-[10px] uppercase font-semibold text-slate-500 mb-1">Clinical Application</div>
                <Select value={metaApp || "CDS"} onValueChange={setMetaApp}>
                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="CDS">CDS</SelectItem>
                    <SelectItem value="Quality Measure">Quality Measure</SelectItem>
                    <SelectItem value="Population Health">Population Health</SelectItem>
                    <SelectItem value="Billing">Billing</SelectItem>
                    <SelectItem value="Research">Research</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <div className="text-[10px] uppercase font-semibold text-slate-500 mb-1">Steward</div>
                <Input value="S.P.E.H.R. Terminology Services" readOnly className="h-8 text-xs bg-slate-50" />
              </div>
              <div>
                <div className="text-[10px] uppercase font-semibold text-slate-500 mb-1">Version</div>
                <Input value={metaVersion} onChange={(e) => setMetaVersion(e.target.value)} className="h-8 text-xs font-mono" />
              </div>
            </div>
            <Button size="sm" className="bg-[#0c2340] hover:bg-[#0c2340]/90" onClick={saveMetadata} disabled={savingMeta}>
              {savingMeta ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} Save Metadata
            </Button>
            <div>
              <div className="text-[10px] uppercase font-semibold text-slate-500 mt-3 mb-1">Change History</div>
              {changeHistory.length === 0 ? (
                <div className="text-[11px] text-slate-500 italic">No changes recorded yet.</div>
              ) : (
                <ul className="space-y-1 text-[11px] text-slate-700 max-h-40 overflow-y-auto">
                  {changeHistory.slice().reverse().map((h: any, i: number) => (
                    <li key={i} className="border-l-2 border-slate-200 pl-2">
                      <span className="font-mono text-[10px] text-slate-500">{new Date(h.at).toLocaleString()}</span> — {h.change}
                      {h.actor && <span className="text-slate-500"> · {h.actor}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </TabsContent>

          <TabsContent value="fhir" className="mt-3 space-y-2">
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={copyJson}>
                {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? "Copied!" : "Copy JSON"}
              </Button>
              <Button size="sm" variant="outline" onClick={downloadJson}>
                <Download className="h-3.5 w-3.5" /> Download .json
              </Button>
              <Button size="sm" variant="outline" onClick={runExpand} disabled={expanding}>
                <FileJson className="h-3.5 w-3.5" /> $expand via FHIR Server
              </Button>
            </div>
            <pre className="rounded border border-slate-200 bg-slate-900 text-emerald-300 p-3 text-[10px] overflow-x-auto max-h-96">
              {fhirJson}
            </pre>
            {expansion && (
              <div className="rounded border border-emerald-200 bg-emerald-50 p-3 text-[11px]">
                <div className="font-semibold mb-1">$expand returned {expansion.expansion?.total ?? 0} concepts</div>
                <div className="space-y-1 max-h-40 overflow-y-auto">
                  {(expansion.expansion?.contains ?? []).slice(0, 30).map((c: any, i: number) => (
                    <div key={i} className="font-mono">{c.code} · {c.display}</div>
                  ))}
                </div>
              </div>
            )}
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}
