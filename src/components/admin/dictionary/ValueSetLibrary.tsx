import { useEffect, useMemo, useState } from "react";
import { Plus, Download, Upload, Loader2, FileJson, Copy, Play } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
                    <span className={`inline-block px-2 py-0.5 rounded border text-[10px] font-semibold capitalize ${STATUS_STYLES[r.status] ?? ""}`}>
                      {r.status === "review" ? "In Review" : r.status}
                    </span>
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

      <ValueSetDrawer vs={selected} onClose={() => setSelected(null)} />
    </div>
  );
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

function ValueSetDrawer({ vs, onClose }: { vs: ValueSet | null; onClose: () => void }) {
  const [expanding, setExpanding] = useState(false);
  const [expansion, setExpansion] = useState<any>(null);

  useEffect(() => { setExpansion(null); }, [vs?.id]);

  if (!vs) return null;

  const fhir = toFhirValueSet(vs);
  const fhirJson = JSON.stringify(fhir, null, 2);

  const runExpand = async () => {
    setExpanding(true);
    try {
      const { data, error } = await supabase.functions.invoke("fhir-terminology", {
        body: { operation: "expand", params: { valueSet: vs.name, count: 100 } },
      });
      if (error) throw error;
      setExpansion(data);
      toast.success(`Expanded to ${data?.expansion?.total ?? 0} concepts`);
    } catch (e: any) {
      toast.error(`$expand failed: ${e.message}`);
    } finally { setExpanding(false); }
  };

  return (
    <Sheet open={!!vs} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-2xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            {vs.name}
            <span className={`text-[10px] px-2 py-0.5 rounded border font-semibold ${STATUS_STYLES[vs.status] ?? ""}`}>
              {vs.status === "review" ? "In Review" : vs.status}
            </span>
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
            {vs.intensional_rule && (
              <div className="rounded border border-slate-200 bg-slate-50 p-3 space-y-2 font-mono text-[11px]">
                {vs.intensional_rule.rootConcept && (
                  <div><strong>Root Concept:</strong> {vs.intensional_rule.rootConcept} · {vs.intensional_rule.rootDisplay}</div>
                )}
                {vs.intensional_rule.include && (
                  <div><strong>Include:</strong> {vs.intensional_rule.include}</div>
                )}
                {vs.intensional_rule.drugClass && (
                  <div><strong>Drug Class:</strong> {vs.intensional_rule.drugClass}</div>
                )}
                {vs.intensional_rule.filters && (
                  <div><strong>Filters:</strong> {JSON.stringify(vs.intensional_rule.filters)}</div>
                )}
              </div>
            )}
            <Button size="sm" variant="outline" onClick={runExpand} disabled={expanding}>
              {expanding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              Preview Expansion (calls UMLS live)
            </Button>
            {expansion && (
              <div className="rounded border border-emerald-200 bg-emerald-50 p-3 text-[11px]">
                <div className="font-semibold mb-2">
                  Expands to {expansion.expansion?.total ?? 0} concepts
                </div>
                <div className="space-y-1 max-h-64 overflow-y-auto">
                  {(expansion.expansion?.contains ?? []).slice(0, 30).map((c: any, i: number) => (
                    <div key={i} className="font-mono">{c.code} · {c.display}</div>
                  ))}
                </div>
              </div>
            )}
          </TabsContent>

          <TabsContent value="meta" className="mt-3 space-y-3 text-xs">
            <Field label="Purpose / Use Case" value={vs.description ?? "—"} />
            <Field label="Steward" value={vs.steward ?? "S.P.E.H.R. Terminology Services"} />
            <Field label="FHIR Value Set URL" value={vs.fhir_url ?? "—"} mono />
            <Field label="HL7 Binding Strength" value={vs.binding_strength ?? "preferred"} />
            <Field label="Clinical Application" value={vs.clinical_application ?? "—"} />
            <Field label="Peer Reviewer" value={vs.peer_reviewer ?? "Unassigned"} />
            <Field label="Version" value={vs.version ?? "1.0.0"} />
          </TabsContent>

          <TabsContent value="fhir" className="mt-3 space-y-2">
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => {
                navigator.clipboard.writeText(fhirJson);
                toast.success("FHIR JSON copied");
              }}>
                <Copy className="h-3.5 w-3.5" /> Copy FHIR JSON
              </Button>
              <Button size="sm" variant="outline" onClick={runExpand} disabled={expanding}>
                <FileJson className="h-3.5 w-3.5" /> $expand via FHIR Server
              </Button>
            </div>
            <pre className="rounded border border-slate-200 bg-slate-900 text-emerald-300 p-3 text-[10px] overflow-x-auto max-h-96">
              {fhirJson}
            </pre>
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">{label}</div>
      <div className={`text-slate-900 ${mono ? "font-mono text-[11px] break-all" : ""}`}>{value}</div>
    </div>
  );
}