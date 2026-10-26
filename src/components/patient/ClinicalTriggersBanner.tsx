/**
 * Phase 4 — Auto Doc / Auto Admin additive suggestion banners.
 *
 * Loads three published value sets via the value-set-dependency registry
 * and renders small, dismissible, informational banners whenever the
 * patient's coded diagnoses or procedures match:
 *
 *  - "Specialist Consult Triggers" → suggest a specialist consult
 *  - "Isolation Precaution Diagnoses" → suggest Contact / Droplet / Airborne
 *  - "Inpatient-Only Procedures (Starter Set)" → suggest inpatient status
 *
 * Purely additive — never replaces existing routing / admission logic.
 */
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ShieldAlert, Stethoscope, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { loadPublishedValueSetsForConsumer } from "@/lib/value-set-registry";

type CodeEntry = {
  code: string;
  display?: string;
  vocabulary?: string;
  recommended_specialty?: string;
  precaution_type?: string;
};

type ValueSet = {
  name: string;
  codes: CodeEntry[];
};

const DISMISS_KEY = (mrn: string, kind: string) => `spehr.p4.dismiss.${kind}.${mrn}`;

function useDismissable(mrn: string, kind: string) {
  const [dismissed, setDismissed] = useState<boolean>(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    setDismissed(!!window.sessionStorage.getItem(DISMISS_KEY(mrn, kind)));
  }, [mrn, kind]);
  const dismiss = () => {
    if (typeof window !== "undefined") {
      window.sessionStorage.setItem(DISMISS_KEY(mrn, kind), "1");
    }
    setDismissed(true);
  };
  return { dismissed, dismiss };
}

function useValueSets(): {
  specialist: ValueSet | null;
  isolation: ValueSet | null;
  inpatient: ValueSet | null;
} {
  const [vs, setVs] = useState<{
    specialist: ValueSet | null;
    isolation: ValueSet | null;
    inpatient: ValueSet | null;
  }>({ specialist: null, isolation: null, inpatient: null });
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [consult, admin] = await Promise.all([
        loadPublishedValueSetsForConsumer({ consumer: "Auto Doc — Specialist Consult" }),
        loadPublishedValueSetsForConsumer({ consumer: "Auto Admin — Isolation/Status Flags" }),
      ]);
      if (cancelled) return;
      const pick = (hits: any[], name: string): ValueSet | null => {
        const h = hits.find((x) => x.value_set_name === name);
        if (!h?.row?.codes) return null;
        return { name, codes: h.row.codes as CodeEntry[] };
      };
      setVs({
        specialist: pick(consult, "Specialist Consult Triggers"),
        isolation: pick(admin, "Isolation Precaution Diagnoses"),
        inpatient: pick(admin, "Inpatient-Only Procedures (Starter Set)"),
      });
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return vs;
}

export default function ClinicalTriggersBanner({ mrn }: { mrn: string }) {
  const { specialist, isolation, inpatient } = useValueSets();
  const [dxCodes, setDxCodes] = useState<Set<string>>(new Set());
  const [procCodes, setProcCodes] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [{ data: conds }, { data: procs }] = await Promise.all([
        supabase.from("conditions").select("snomed_code").eq("mrn", mrn),
        supabase.from("procedures").select("snomed_code, cpt_code").eq("mrn", mrn),
      ]);
      if (cancelled) return;
      setDxCodes(
        new Set(((conds ?? []) as any[]).map((c) => String(c.snomed_code ?? "")).filter(Boolean)),
      );
      setProcCodes(
        new Set(
          ((procs ?? []) as any[])
            .flatMap((p) => [p.snomed_code, p.cpt_code])
            .filter(Boolean)
            .map(String),
        ),
      );
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [mrn]);

  const consultHits = useMemo<CodeEntry[]>(
    () => (specialist?.codes ?? []).filter((c) => dxCodes.has(c.code)),
    [specialist, dxCodes],
  );
  const isolationHits = useMemo<CodeEntry[]>(
    () => (isolation?.codes ?? []).filter((c) => dxCodes.has(c.code)),
    [isolation, dxCodes],
  );
  const inpatientHits = useMemo<CodeEntry[]>(
    () => (inpatient?.codes ?? []).filter((c) => procCodes.has(c.code)),
    [inpatient, procCodes],
  );

  const consult = useDismissable(mrn, "consult");
  const iso = useDismissable(mrn, "isolation");
  const inp = useDismissable(mrn, "inpatient");

  if (!consultHits.length && !isolationHits.length && !inpatientHits.length) return null;

  return (
    <div className="space-y-1.5 px-3 pt-2">
      {consultHits.length > 0 && !consult.dismissed && (
        <div className="flex items-start gap-2 rounded-md border border-sky-300 bg-sky-50 px-3 py-2 text-[12px] text-sky-900">
          <Stethoscope className="h-4 w-4 mt-0.5 shrink-0" />
          <div className="flex-1">
            {consultHits.map((c) => (
              <div key={c.code}>
                Consider <strong>{c.recommended_specialty ?? "specialist"}</strong> consult —{" "}
                {c.display} is a specialist-consult trigger diagnosis.
              </div>
            ))}
          </div>
          <button
            onClick={consult.dismiss}
            className="text-sky-700 hover:text-sky-900"
            aria-label="Dismiss"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      {isolationHits.length > 0 && !iso.dismissed && (
        <div className="flex items-start gap-2 rounded-md border border-amber-400 bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
          <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0" />
          <div className="flex-1">
            {isolationHits.map((c) => (
              <div key={c.code} className="flex items-center gap-2">
                <span className="inline-flex items-center rounded-full bg-amber-200 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider">
                  {c.precaution_type ?? "Contact"} precautions
                </span>
                <span>{c.display}</span>
              </div>
            ))}
          </div>
          <button
            onClick={iso.dismiss}
            className="text-amber-700 hover:text-amber-900"
            aria-label="Dismiss"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      {inpatientHits.length > 0 && !inp.dismissed && (
        <div className="flex items-start gap-2 rounded-md border border-indigo-300 bg-indigo-50 px-3 py-2 text-[12px] text-indigo-900">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <div className="flex-1">
            {inpatientHits.map((c) => (
              <div key={c.code}>
                Recommend <strong>inpatient status</strong> (not observation) — {c.display} is on
                the Inpatient-Only Procedures starter list.
              </div>
            ))}
          </div>
          <button
            onClick={inp.dismiss}
            className="text-indigo-700 hover:text-indigo-900"
            aria-label="Dismiss"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
