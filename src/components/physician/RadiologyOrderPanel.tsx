import { useState } from "react";
import { Loader2, Send, ChevronDown, Scan } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { InfoHint } from "@/components/ui/info-hint";

interface Props {
  mrn: string;
  patientName: string | null;
  facility: string | null;
  diagnosis: string | null;
  physicianName?: string;
}

// SNOMED CT procedure codes for common imaging studies. Internal consistency
// matters more than perfect real-world accuracy — the partner Imaging center
// keys result DiagnosticReports back to us via `basedOn` on the ServiceRequest,
// not by matching these codes.
const RADIOLOGY_CATALOG: Array<{
  exam: string;
  modality: "XR" | "CT" | "MRI" | "US";
  bodyPart: string;
  snomed: string;
  snomedDisplay: string;
}> = [
  { exam: "Chest X-ray",               modality: "XR",  bodyPart: "Chest",        snomed: "399208008", snomedDisplay: "Plain chest X-ray" },
  { exam: "Knee X-ray",                modality: "XR",  bodyPart: "Knee",         snomed: "168731009", snomedDisplay: "Plain X-ray of knee" },
  { exam: "CT Head (non-contrast)",    modality: "CT",  bodyPart: "Head",         snomed: "303653007", snomedDisplay: "Computed tomography of head" },
  { exam: "CT Chest",                  modality: "CT",  bodyPart: "Chest",        snomed: "169069000", snomedDisplay: "Computed tomography of chest" },
  { exam: "CT Abdomen/Pelvis",         modality: "CT",  bodyPart: "Abdomen/Pelvis", snomed: "418023006", snomedDisplay: "Computed tomography of abdomen and pelvis" },
  { exam: "MRI Brain",                 modality: "MRI", bodyPart: "Brain",        snomed: "816077007", snomedDisplay: "MRI of brain" },
  { exam: "MRI Spine",                 modality: "MRI", bodyPart: "Spine",        snomed: "241645008", snomedDisplay: "MRI of spine" },
  { exam: "Abdominal Ultrasound",      modality: "US",  bodyPart: "Abdomen",      snomed: "45036003",  snomedDisplay: "Ultrasonography of abdomen" },
];

export function RadiologyOrderPanel({ mrn, patientName, facility, diagnosis, physicianName }: Props) {
  const [open, setOpen] = useState(false);
  const [examIdx, setExamIdx] = useState(0);
  const [indication, setIndication] = useState(diagnosis ?? "");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    const trimmed = indication.trim();
    if (!trimmed) {
      toast.error("Clinical indication required", {
        description: "Radiology orders must include a clinical reason.",
      });
      return;
    }
    const chosen = RADIOLOGY_CATALOG[examIdx];
    setSubmitting(true);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.from("radiology_orders") as any)
        .insert({
          patient_mrn: mrn,
          patient_name: patientName,
          facility_name: facility,
          requested_by: physicianName ?? "Physician",
          exam_type: chosen.exam,
          modality: chosen.modality,
          body_part: chosen.bodyPart,
          clinical_indication: trimmed,
          status: "ordered",
          snomed_code: chosen.snomed,
          snomed_display: chosen.snomedDisplay,
          source: "spehr",
          created_by_type: "human",
        })
        .select("id")
        .single();
      if (error) throw error;
      toast.success(`${chosen.exam} ordered`, {
        description: `Routed to imaging queue · order ${data?.id?.slice(0, 8)}`,
      });
      setIndication(diagnosis ?? "");
    } catch (e: any) {
      toast.error("Failed to submit radiology order", { description: e?.message });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="rounded-lg border border-slate-200 bg-white">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-2 border-b border-slate-200 px-5 py-3 hover:bg-slate-50"
      >
        <div className="flex items-center gap-2">
          <Scan className="h-4 w-4 text-cyan-600" />
          <div className="text-left">
            <div className="text-sm font-semibold text-slate-900 inline-flex items-center gap-1">
              Radiology / Imaging Orders
              <InfoHint text="Order an imaging study (X-ray / CT / MRI / US). SPEHR pushes a FHIR ServiceRequest to the shared server; the partner imaging center returns a DiagnosticReport once the study is read." />
            </div>
            <div className="text-[11px] text-slate-500">
              {RADIOLOGY_CATALOG.length} exam types · SNOMED-coded
            </div>
          </div>
        </div>
        <ChevronDown
          className={`h-4 w-4 text-slate-500 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div className="p-4 space-y-3">
          <div className="grid gap-3 md:grid-cols-2">
            <label className="block">
              <span className="block text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-1">
                Exam
              </span>
              <select
                value={examIdx}
                onChange={(e) => setExamIdx(Number(e.target.value))}
                className="w-full h-9 rounded-md border border-slate-300 bg-white px-2 text-sm"
              >
                {RADIOLOGY_CATALOG.map((r, i) => (
                  <option key={r.snomed} value={i}>
                    {r.exam} · {r.modality}
                  </option>
                ))}
              </select>
            </label>
            <div className="text-[11px] text-slate-500 self-end pb-2">
              SNOMED {RADIOLOGY_CATALOG[examIdx].snomed} · Body site:{" "}
              <span className="font-medium text-slate-700">{RADIOLOGY_CATALOG[examIdx].bodyPart}</span>
            </div>
          </div>
          <label className="block">
            <span className="block text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-1">
              Clinical Indication <span className="text-red-500">*</span>
            </span>
            <textarea
              value={indication}
              onChange={(e) => setIndication(e.target.value)}
              rows={2}
              placeholder="e.g. Acute chest pain, r/o pneumonia"
              className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
            />
          </label>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={submit}
              disabled={submitting}
              className="inline-flex items-center gap-1.5 rounded-md bg-cyan-700 hover:bg-cyan-700/90 disabled:opacity-60 text-white px-4 h-9 text-xs font-semibold"
            >
              {submitting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
              {submitting ? "Submitting…" : "Submit Radiology Order"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}