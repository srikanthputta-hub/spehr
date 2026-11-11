import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ShieldCheck, X } from "lucide-react";
import { useServerFn } from "@tanstack/react-start";
import {
  checkDrugDisease,
  checkDrugDiseaseFromValueSets,
  type CdsHit,
} from "@/lib/contraindications";
import { logCdsOverride } from "@/lib/auto-api.functions";
import { useAutoApiEnabled } from "@/hooks/useAutomationEnabled";
import { toast } from "sonner";
import { InfoHint } from "@/components/ui/info-hint";
import { supabase } from "@/integrations/supabase/client";

interface Props {
  drugName: string;
  mrn: string;
  patientConditions: string[]; // chief_complaint, diagnosis, etc.
  allergies?: string[];
  physicianName?: string;
}

export function CdsHookAlert({
  drugName,
  mrn,
  patientConditions,
  allergies = [],
  physicianName,
}: Props) {
  const autoApi = useAutoApiEnabled();
  const logOverride = useServerFn(logCdsOverride);
  const [overrideReason, setOverrideReason] = useState("");
  const [overridden, setOverridden] = useState<Set<string>>(new Set());
  const [showInput, setShowInput] = useState<string | null>(null);

  const staticHits = useMemo(() => {
    if (!autoApi || !drugName || drugName.length < 3) return [];
    return checkDrugDisease(drugName, patientConditions);
  }, [drugName, patientConditions, autoApi]);

  // Value-set-backed CDS check runs FIRST; if no published CDS value set
  // governs this drug at all, we fall back to the static rule list.
  const [vsHits, setVsHits] = useState<CdsHit[]>([]);
  const [vsMatchedAnyDrugSet, setVsMatchedAnyDrugSet] = useState(false);
  useEffect(() => {
    let cancelled = false;
    if (!autoApi || !drugName || drugName.length < 3) {
      setVsHits([]);
      setVsMatchedAnyDrugSet(false);
      return;
    }
    checkDrugDiseaseFromValueSets(drugName, patientConditions)
      .then((r) => {
        if (cancelled) return;
        setVsHits(r.hits);
        setVsMatchedAnyDrugSet(r.matchedAnyDrugSet);
      })
      .catch(() => {
        if (cancelled) return;
        setVsHits([]);
        setVsMatchedAnyDrugSet(false);
      });
    return () => {
      cancelled = true;
    };
  }, [drugName, patientConditions, autoApi]);

  const hits = vsMatchedAnyDrugSet ? vsHits : staticHits;

  const allergyHits = useMemo(() => {
    if (!autoApi || !drugName || drugName.length < 3) return [];
    const dn = drugName.toLowerCase();
    return allergies.filter((a) => a && dn.includes(a.toLowerCase().split(/\s|,/)[0] ?? ""));
  }, [drugName, allergies, autoApi]);

  // `auto_api_enabled` is documented (see useAutomationEnabled.ts) as
  // scoped to autocomplete/sync features, but it also gates the
  // drug-disease / drug-allergy contraindication checks above — with no
  // disclosure and no audit trail. Rather than fail silently, log once per
  // (patient, drug) that a check was skipped for this reason.
  const loggedSkipKeysRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (autoApi) return;
    if (!drugName || drugName.length < 3 || !mrn) return;
    const key = `${mrn}:${drugName.toLowerCase()}`;
    if (loggedSkipKeysRef.current.has(key)) return;
    loggedSkipKeysRef.current.add(key);
    (async () => {
      try {
        await supabase.from("auto_doc_logs").insert({
          mrn,
          stage: "cds-contraindication-check",
          level: "warning",
          message: `Drug-disease/drug-allergy contraindication checking SKIPPED for "${drugName}" — "Auto API" (auto_api_enabled) is OFF. This flag's documented scope is autocomplete/sync only; it also silently gates this safety check.`,
          meta: { drugName, physicianName: physicianName ?? null },
          created_by_type: "automation",
        });
      } catch {
        // Best-effort audit log — never block the UI on this.
      }
    })();
  }, [autoApi, drugName, mrn, physicianName]);

  if (!autoApi) {
    if (!drugName || drugName.length < 3) return null;
    return (
      <div className="flex items-start gap-2 rounded-md border-2 border-amber-300 bg-amber-50 p-3 text-amber-900">
        <AlertTriangle className="h-4 w-4 shrink-0 text-amber-700 mt-0.5" />
        <div className="flex-1 text-[12px]">
          <div className="text-[11px] font-bold uppercase tracking-wider inline-flex items-center gap-1">
            Contraindication Checking Disabled
            <InfoHint text='The system-wide "Auto API" toggle (system_settings.auto_api_enabled) is OFF. That flag is meant to control CPOE autocomplete and FHIR sync, but it also suppresses drug-disease and drug-allergy CDS checks for this order. Each occurrence is logged to auto_doc_logs for audit.' />
          </div>
          <div className="mt-0.5">
            Drug-disease and drug-allergy CDS alerts for{" "}
            <span className="font-semibold">{drugName}</span> are not running right now — verify
            manually. This has been written to the audit log.
          </div>
        </div>
      </div>
    );
  }

  if (hits.length === 0 && allergyHits.length === 0) return null;

  const handleOverride = async (key: string, hit: CdsHit | null, allergy: string | null) => {
    if (!overrideReason.trim()) {
      toast.error("Override reason is required");
      return;
    }
    try {
      await logOverride({
        data: {
          mrn,
          alert_type: allergy ? "drug-allergy" : "drug-disease",
          severity: hit?.rule.severity ?? "CONTRAINDICATION",
          drug_name: drugName,
          drug_rxnorm: hit?.rule.drug_rxnorm,
          condition_name: hit?.matched_condition ?? allergy ?? undefined,
          condition_snomed: hit?.rule.condition_snomed,
          reason: overrideReason.trim(),
          physician_name: physicianName,
        },
      });
      setOverridden((p) => new Set(p).add(key));
      setShowInput(null);
      setOverrideReason("");
      toast.success("Override logged to audit trail");
    } catch (e) {
      toast.error("Failed to log override", {
        description: e instanceof Error ? e.message : undefined,
      });
    }
  };

  return (
    <div className="space-y-2">
      {allergyHits.map((a) => {
        const key = `allergy:${a}`;
        if (overridden.has(key)) {
          return (
            <div
              key={key}
              className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-[11px] text-emerald-800"
            >
              <ShieldCheck className="h-3.5 w-3.5" />
              Allergy alert overridden — proceed with caution.
            </div>
          );
        }
        return (
          <div key={key} className="rounded-md border-2 border-rose-300 bg-rose-50 p-3">
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 text-rose-700 mt-0.5" />
              <div className="flex-1">
                <div className="text-[11px] font-bold uppercase tracking-wider text-rose-800 inline-flex items-center gap-1">
                  Drug-Allergy Alert · CONTRAINDICATION
                  <InfoHint text="CDS Hook = Clinical Decision Support hook — an automated real-time check fired at order entry against the patient's documented allergies (mapped RxNorm → allergen family). CONTRAINDICATION = clinically prohibited combination, distinct from a WARNING (elevated risk, monitoring required)." />
                </div>
                <div className="text-[13px] text-rose-900 mt-0.5">
                  Patient has documented allergy to <span className="font-semibold">{a}</span>.
                </div>
              </div>
            </div>
            {showInput === key ? (
              <div className="mt-2 flex items-center gap-2">
                <input
                  autoFocus
                  value={overrideReason}
                  onChange={(e) => setOverrideReason(e.target.value)}
                  placeholder="Clinical justification (required)"
                  className="flex-1 rounded border border-rose-300 px-2 py-1 text-[12px]"
                />
                <button
                  type="button"
                  onClick={() => handleOverride(key, null, a)}
                  className="rounded bg-rose-700 px-2 py-1 text-[11px] font-semibold text-white"
                >
                  Accept &amp; Override
                </button>
                <button type="button" onClick={() => setShowInput(null)} className="text-rose-700">
                  <X className="h-4 w-4" />
                </button>
              </div>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => setShowInput(key)}
                  className="mt-2 text-[11px] font-semibold text-rose-800 underline"
                >
                  Override with reason →
                </button>
                <InfoHint
                  className="ml-2 align-middle"
                  text="Overriding is not silent — it writes a permanent audit row to cds_overrides with your name, the drug (RxNorm), the condition/allergy, and your justification. Reviewable in System Admin → CDS Hook Decisions."
                />
              </>
            )}
          </div>
        );
      })}

      {hits.map((h, idx) => {
        const key = `dd:${idx}:${h.rule.severity}`;
        const isContra = h.rule.severity === "CONTRAINDICATION";
        const tone = isContra
          ? "border-rose-300 bg-rose-50 text-rose-900"
          : "border-amber-300 bg-amber-50 text-amber-900";
        if (overridden.has(key)) {
          return (
            <div
              key={key}
              className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-[11px] text-emerald-800"
            >
              <ShieldCheck className="h-3.5 w-3.5" />
              {h.rule.severity} override logged.
            </div>
          );
        }
        return (
          <div key={key} className={`rounded-md border-2 p-3 ${tone}`}>
            <div className="flex items-start gap-2">
              <AlertTriangle
                className={`h-4 w-4 mt-0.5 ${isContra ? "text-rose-700" : "text-amber-700"}`}
              />
              <div className="flex-1">
                <div className="text-[11px] font-bold uppercase tracking-wider inline-flex items-center gap-1">
                  Drug-Disease · {h.rule.severity}
                  <InfoHint text="CDS Hook drug-disease check. CONTRAINDICATION = clinically prohibited combination, override strongly discouraged. WARNING = elevated risk requiring monitoring but not an absolute prohibition — either can be overridden with a logged justification." />
                </div>
                <div className="text-[13px] mt-0.5">
                  Matched condition: <span className="font-semibold">{h.matched_condition}</span>
                </div>
                <div className="text-[11px] mt-1 italic">{h.rule.rationale}</div>
              </div>
            </div>
            {showInput === key ? (
              <div className="mt-2 flex items-center gap-2">
                <input
                  autoFocus
                  value={overrideReason}
                  onChange={(e) => setOverrideReason(e.target.value)}
                  placeholder="Clinical justification (required)"
                  className="flex-1 rounded border px-2 py-1 text-[12px]"
                />
                <button
                  type="button"
                  onClick={() => handleOverride(key, h, null)}
                  className={`rounded px-2 py-1 text-[11px] font-semibold text-white ${isContra ? "bg-rose-700" : "bg-amber-700"}`}
                >
                  Accept &amp; Override
                </button>
                <button type="button" onClick={() => setShowInput(null)}>
                  <X className="h-4 w-4" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setShowInput(key)}
                className="mt-2 text-[11px] font-semibold underline"
              >
                Override with reason →
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
