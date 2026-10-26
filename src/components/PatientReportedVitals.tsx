import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Activity, Loader2, Smartphone } from "lucide-react";

interface ObsRow {
  id: string;
  patient_mrn: string;
  status: string;
  resource: any;
  created_at: string | null;
}

function isPatientReported(r: any): boolean {
  const cats: any[] = r?.resource?.category ?? [];
  for (const c of cats) {
    for (const coding of c?.coding ?? []) {
      const code = String(coding?.code ?? "").toLowerCase();
      if (code === "survey" || code === "patient-reported" || code === "self-reported") return true;
    }
    if (
      String(c?.text ?? "")
        .toLowerCase()
        .includes("patient")
    )
      return true;
  }
  // FHIR extension or performer hint
  const perf = r?.resource?.performer ?? [];
  for (const p of perf) {
    if (
      String(p?.reference ?? "")
        .toLowerCase()
        .startsWith("patient/")
    )
      return true;
  }
  return false;
}

function describe(r: any): { label: string; value: string; when: string } {
  const res = r?.resource ?? {};
  const label =
    res?.code?.text ||
    res?.code?.coding?.[0]?.display ||
    res?.code?.coding?.[0]?.code ||
    "Observation";
  let value = "—";
  if (res?.valueQuantity) {
    value = `${res.valueQuantity.value ?? ""} ${res.valueQuantity.unit ?? ""}`.trim();
  } else if (res?.valueString) {
    value = String(res.valueString);
  } else if (res?.component?.length) {
    value = res.component
      .map(
        (c: any) =>
          `${c?.code?.text ?? c?.code?.coding?.[0]?.display ?? "?"} ${c?.valueQuantity?.value ?? ""}${c?.valueQuantity?.unit ?? ""}`,
      )
      .join(" / ");
  }
  const when = res?.effectiveDateTime || res?.issued || r?.created_at || "";
  return { label, value, when };
}

export function PatientReportedVitals({ mrn }: { mrn: string }) {
  const [rows, setRows] = useState<ObsRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    const load = async () => {
      const { data } = await (supabase as any)
        .from("fhir_observations")
        .select("id, patient_mrn, status, resource, created_at")
        .eq("patient_mrn", mrn)
        .order("created_at", { ascending: false })
        .limit(50);
      if (!active) return;
      setRows(((data ?? []) as ObsRow[]).filter((r) => isPatientReported(r)));
      setLoading(false);
    };
    load();
    const ch = supabase
      .channel(`pr-vitals-${mrn}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "fhir_observations",
          filter: `patient_mrn=eq.${mrn}`,
        },
        () => load(),
      )
      .subscribe();
    return () => {
      active = false;
      supabase.removeChannel(ch);
    };
  }, [mrn]);

  return (
    <section className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="flex items-center justify-between px-5 h-11 border-b border-border bg-secondary/40">
        <div className="flex items-center gap-2">
          <Smartphone className="h-4 w-4 text-[var(--teal)]" />
          <h3 className="text-sm font-semibold">Home Vitals · Patient Reported</h3>
        </div>
        <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--teal)]">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--teal)]" /> Live · FHIR Observation
        </span>
      </div>
      {loading ? (
        <div className="grid place-items-center h-24 text-slate-500 text-xs">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      ) : rows.length === 0 ? (
        <div className="px-5 py-6 text-center text-xs text-muted-foreground">
          No patient-reported vitals submitted yet from MySPEHR.
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {rows.slice(0, 10).map((r) => {
            const { label, value, when } = describe(r);
            return (
              <li key={r.id} className="flex items-center justify-between px-5 py-2.5">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-slate-900 flex items-center gap-1.5">
                    <Activity className="h-3.5 w-3.5 text-[var(--teal)]" /> {label}
                  </div>
                  <div className="text-[11px] text-slate-500 font-mono">
                    {when ? new Date(when).toLocaleString() : ""}
                  </div>
                </div>
                <div className="font-mono text-sm font-bold text-slate-900">{value}</div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
