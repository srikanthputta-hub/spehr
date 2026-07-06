import { useEffect, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  Loader2,
  Plus,
  UserPlus,
  Wand2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { type CodeStatus } from "@/lib/patients";
import { analyzeNarrative, loadDictionary, type NlpResult } from "@/lib/nlp-engine";
import {
  autoFillIntake,
  blankIntake,
  CHARACTER_OPTIONS,
  CHRONIC_OPTIONS,
  DURATION_OPTIONS,
  ENV_ALLERGY_OPTIONS,
  FAMILY_OPTIONS,
  GENDER_IDENTITY_OPTIONS,
  RELATIONSHIP_OPTIONS,
  SEX_OPTIONS,
  type IntakeRecord,
} from "@/lib/intake-record";
import type { AdmitInput } from "@/lib/admit-patient";
import { TerminologyCombobox } from "@/components/admissions/TerminologyCombobox";
import type { TerminologyHit } from "@/lib/terminology-search";

export type { AdmitInput };

export function AdmitPatientModal({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: (input: AdmitInput) => Promise<boolean>;
}) {
  const [intake, setIntake] = useState<IntakeRecord>(() => blankIntake());
  const [code, setCode] = useState<CodeStatus>("Full Code");
  const [room, setRoom] = useState("");
  const [mrn, setMrn] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [nlp, setNlp] = useState<NlpResult | null>(null);
  const [, setSuggestedLabs] = useState<string[]>([]);
  const [open, setOpen] = useState<Record<string, boolean>>({
    demo: true,
    cc: true,
    hpi: false,
    pmh: false,
    allergies: false,
    family: false,
  });

  void analyzing;

  const patch = (p: Partial<IntakeRecord>) => setIntake((s) => ({ ...s, ...p }));
  const toggleSection = (k: string) => setOpen((s) => ({ ...s, [k]: !s[k] }));
  const toggleInArray = (arr: string[], v: string) =>
    arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];

  const handleAutoFill = () => {
    const filled = autoFillIntake({
      firstName: intake.firstName || undefined,
      lastName: intake.lastName || undefined,
      age: intake.age || undefined,
      chiefComplaint: intake.chiefComplaint || undefined,
      narrative: intake.narrative || undefined,
    });
    setIntake(filled);
    setOpen({ demo: true, cc: true, hpi: true, pmh: true, allergies: true, family: true });
    toast.success("Intake auto-filled", {
      description: "Review fields, then click Admit Patient.",
    });
  };

  const runAnalyze = async () => {
    const text = intake.narrative.trim();
    if (text.length < 6) {
      toast.error("Enter a longer narrative to analyze");
      return;
    }
    setAnalyzing(true);
    try {
      const dict = await loadDictionary();
      const result = analyzeNarrative(text, dict);
      setNlp(result);
      if (!intake.chiefComplaint.trim() && result.chiefComplaint)
        patch({ chiefComplaint: result.chiefComplaint });
      setSuggestedLabs(result.suggestedLabs.map((l) => `${l.display} (LOINC ${l.code})`));
      toast.success("NLP analysis complete", {
        description: `${result.matches.length} concept${result.matches.length === 1 ? "" : "s"} extracted`,
      });
    } catch (e: any) {
      toast.error("NLP analysis failed", { description: e?.message ?? String(e) });
    } finally {
      setAnalyzing(false);
    }
  };
  void runAnalyze;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const handle = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    const first = intake.firstName.trim();
    const last = intake.lastName.trim();
    if (first.length < 1) {
      setErr("First name is required.");
      setOpen((s) => ({ ...s, demo: true }));
      return;
    }
    if (last.length < 1) {
      setErr("Last name is required.");
      setOpen((s) => ({ ...s, demo: true }));
      return;
    }
    const ageNum = Number(intake.age);
    if (!Number.isFinite(ageNum) || ageNum < 0 || ageNum > 120) {
      setErr("Age must be 0–120.");
      setOpen((s) => ({ ...s, demo: true }));
      return;
    }
    if (intake.chiefComplaint.trim().length < 2) {
      setErr("Chief complaint is required.");
      setOpen((s) => ({ ...s, cc: true }));
      return;
    }
    if (mrn && !/^MRN-[A-Za-z0-9-]{3,20}$/.test(mrn.trim())) {
      setErr("MRN must look like 'MRN-XXXXXX'.");
      return;
    }
    setSubmitting(true);
    const ok = await onSubmit({
      name: `${first} ${last}`,
      age: Math.floor(ageNum),
      gender: intake.sex === "Female" ? "F" : "M",
      room,
      code_status: code,
      diagnosis: intake.chiefComplaint.trim(),
      mrn: mrn.trim() || undefined,
      nlp: nlp ?? undefined,
      intake: { ...intake, age: Math.floor(ageNum) },
    });
    setSubmitting(false);
    if (ok) onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-[var(--navy)]/70 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-4xl max-h-[92vh] overflow-y-auto rounded-xl bg-card border border-border shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 h-12 bg-[var(--navy)] text-white sticky top-0 z-10">
          <div className="flex items-center gap-2">
            <UserPlus className="h-4 w-4 text-[var(--teal)]" />
            <h2 className="text-sm font-semibold">Admission Case History — New Patient</h2>
          </div>
          <button
            onClick={onClose}
            className="grid place-items-center h-7 w-7 rounded-md hover:bg-white/10 transition"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handle} className="p-5 space-y-3">
          <Section title="1 · Patient Demographics (Administrative & Identity)" open={open.demo} onToggle={() => toggleSection("demo")}>
            <div className="grid grid-cols-12 gap-3">
              <Field label="First Name" className="col-span-4">
                <Input value={intake.firstName} onChange={(v) => patch({ firstName: v })} placeholder="John" />
              </Field>
              <Field label="Last Name" className="col-span-4">
                <Input value={intake.lastName} onChange={(v) => patch({ lastName: v })} placeholder="Doe" />
              </Field>
              <Field label="Age" className="col-span-2">
                <Input
                  value={String(intake.age || "")}
                  onChange={(v) => patch({ age: Number(v.replace(/[^\d]/g, "")) || 0 })}
                  placeholder="65"
                />
              </Field>
              <Field label="Date of Birth" className="col-span-2">
                <input
                  type="date"
                  value={intake.dob}
                  onChange={(e) => patch({ dob: e.target.value })}
                  className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-[var(--teal)]/40 focus:border-[var(--teal)]"
                />
              </Field>
              <Field label="Biological Sex" className="col-span-3">
                <Select
                  value={intake.sex}
                  onChange={(v) => patch({ sex: v as IntakeRecord["sex"] })}
                  options={["", ...SEX_OPTIONS]}
                  placeholder="Select…"
                />
              </Field>
              <Field label="Gender Identity" className="col-span-3">
                <Select
                  value={intake.genderIdentity}
                  onChange={(v) => patch({ genderIdentity: v as IntakeRecord["genderIdentity"] })}
                  options={["", ...GENDER_IDENTITY_OPTIONS]}
                  placeholder="Select…"
                />
              </Field>
              <Field label="Phone" className="col-span-3">
                <Input value={intake.phone} onChange={(v) => patch({ phone: v })} placeholder="(555) 123-4567" />
              </Field>
              <Field label="Occupation" className="col-span-3">
                <Input value={intake.occupation} onChange={(v) => patch({ occupation: v })} placeholder="Teacher" />
              </Field>
              <Field label="Address" className="col-span-12">
                <Input value={intake.address} onChange={(v) => patch({ address: v })} placeholder="123 Main St, Springfield" />
              </Field>
              <Field label="Emergency Contact Name" className="col-span-4">
                <Input value={intake.emergencyName} onChange={(v) => patch({ emergencyName: v })} placeholder="Jane Doe" />
              </Field>
              <Field label="Relationship" className="col-span-3">
                <Select
                  value={intake.emergencyRelationship}
                  onChange={(v) => patch({ emergencyRelationship: v as IntakeRecord["emergencyRelationship"] })}
                  options={["", ...RELATIONSHIP_OPTIONS]}
                  placeholder="Select…"
                />
              </Field>
              <Field label="Emergency Phone" className="col-span-5">
                <Input value={intake.emergencyPhone} onChange={(v) => patch({ emergencyPhone: v })} placeholder="(555) 987-6543" />
              </Field>
              <Field label="Insurance Provider" className="col-span-4">
                <Select
                  value={intake.insuranceProvider}
                  onChange={(v) => patch({ insuranceProvider: v })}
                  options={["", "Blue Cross Blue Shield", "Aetna", "UnitedHealthcare", "Cigna", "Humana", "Kaiser Permanente", "Medicare", "Medicaid", "Self-Pay", "Other"]}
                  placeholder="Select…"
                />
              </Field>
              <Field label="Policy #" className="col-span-3">
                <Input value={intake.insurancePolicy} onChange={(v) => patch({ insurancePolicy: v })} placeholder="POL-123456" />
              </Field>
              <Field label="Primary Care Physician" className="col-span-3">
                <Input value={intake.pcp} onChange={(v) => patch({ pcp: v })} placeholder="Dr. Reyes, MD" />
              </Field>
              <Field label="Guarantor" className="col-span-2">
                <Input value={intake.guarantor} onChange={(v) => patch({ guarantor: v })} placeholder="Self" />
              </Field>
              <Field label="Room / Bed" className="col-span-3">
                <Input value={room} onChange={(v) => setRoom(v)} placeholder="412-A" />
              </Field>
              <Field label="Code Status" className="col-span-3">
                <Select value={code} onChange={(v) => setCode(v as CodeStatus)} options={["Full Code", "DNR", "DNI", "Comfort"]} />
              </Field>
              <Field label="MRN (optional)" className="col-span-6">
                <Input value={mrn} onChange={(v) => setMrn(v)} placeholder="MRN-482910 — auto if blank" />
              </Field>
            </div>
          </Section>

          <Section title="2 · Chief Complaint (CC) — Patient's Own Words" open={open.cc} onToggle={() => toggleSection("cc")}>
            <TerminologyCombobox
              value={intake.chiefComplaint}
              onChange={(v) =>
                patch({
                  chiefComplaint: v,
                  chiefComplaintCode:
                    intake.chiefComplaintCode && v === intake.chiefComplaintCode.display
                      ? intake.chiefComplaintCode
                      : undefined,
                })
              }
              onSelect={(hit: TerminologyHit) =>
                patch({ chiefComplaint: hit.display, chiefComplaintCode: hit })
              }
              sabs="SNOMEDCT_US"
              placeholder={'e.g. "Severe chest pain for the last two hours"'}
            />
            {intake.chiefComplaintCode && (
              <p className="mt-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                Coded: {intake.chiefComplaintCode.system} · {intake.chiefComplaintCode.code}
              </p>
            )}
          </Section>

          <Section title="3 · History of Present Illness (HPI)" open={open.hpi} onToggle={() => toggleSection("hpi")}>
            <div className="grid grid-cols-12 gap-3">
              <Field label="Onset" className="col-span-4">
                <Input value={intake.hpiOnset} onChange={(v) => patch({ hpiOnset: v })} placeholder="2 hours ago" />
              </Field>
              <Field label="Location / Radiation" className="col-span-5">
                <Input value={intake.hpiLocation} onChange={(v) => patch({ hpiLocation: v })} placeholder="Substernal, radiates to left arm" />
              </Field>
              <Field label="Duration / Frequency" className="col-span-3">
                <Select
                  value={intake.hpiDuration}
                  onChange={(v) => patch({ hpiDuration: v as IntakeRecord["hpiDuration"] })}
                  options={["", ...DURATION_OPTIONS]}
                  placeholder="Select…"
                />
              </Field>
              <Field label="Character" className="col-span-12">
                <ChipGroup
                  options={CHARACTER_OPTIONS as unknown as string[]}
                  value={intake.hpiCharacter}
                  onToggle={(v) => patch({ hpiCharacter: toggleInArray(intake.hpiCharacter, v) })}
                />
              </Field>
              <Field label="Aggravating Factors" className="col-span-6">
                <Input value={intake.hpiAggravating} onChange={(v) => patch({ hpiAggravating: v })} placeholder="Exertion, deep breathing" />
              </Field>
              <Field label="Alleviating Factors" className="col-span-6">
                <Input value={intake.hpiAlleviating} onChange={(v) => patch({ hpiAlleviating: v })} placeholder="Rest, nitroglycerin" />
              </Field>
              <Field label={`Severity: ${intake.hpiSeverity}/10`} className="col-span-12">
                <input
                  type="range"
                  min={0}
                  max={10}
                  value={intake.hpiSeverity}
                  onChange={(e) => patch({ hpiSeverity: Number(e.target.value) })}
                  className="w-full accent-[var(--teal)]"
                />
              </Field>
            </div>
          </Section>

          <Section title="4 · Past Medical & Surgical History (PMH/PSH)" open={open.pmh} onToggle={() => toggleSection("pmh")}>
            <div className="space-y-3">
              <Field label="Chronic Illnesses">
                <div className="space-y-2">
                  <TerminologyCombobox
                    value=""
                    onChange={() => {}}
                    onSelect={(hit) => {
                      if (intake.chronicIllnesses.includes(hit.display)) return;
                      patch({
                        chronicIllnesses: [...intake.chronicIllnesses, hit.display],
                        chronicIllnessCodes: [
                          ...(intake.chronicIllnessCodes ?? []),
                          hit,
                        ],
                      });
                    }}
                    sabs="SNOMEDCT_US"
                    placeholder="Search SNOMED — e.g. Type 2 diabetes"
                    clearOnSelect
                  />
                  <ChipGroup
                    options={Array.from(new Set([
                      ...(CHRONIC_OPTIONS as unknown as string[]),
                      ...intake.chronicIllnesses,
                    ]))}
                    value={intake.chronicIllnesses}
                    onToggle={(v) => {
                      const next = toggleInArray(intake.chronicIllnesses, v);
                      const codes = (intake.chronicIllnessCodes ?? []).filter(
                        (c) => next.includes(c.display),
                      );
                      patch({ chronicIllnesses: next, chronicIllnessCodes: codes });
                    }}
                  />
                </div>
              </Field>
              <Field label="Previous Surgeries (procedure, year, complications)">
                <textarea
                  value={intake.priorSurgeries}
                  onChange={(e) => patch({ priorSurgeries: e.target.value })}
                  rows={2}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--teal)]/40"
                />
              </Field>
              <Field label="Past Hospitalizations">
                <textarea
                  value={intake.pastHospitalizations}
                  onChange={(e) => patch({ pastHospitalizations: e.target.value })}
                  rows={2}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--teal)]/40"
                />
              </Field>
            </div>
          </Section>

          <Section title="5 · Allergies & Current Medications" open={open.allergies} onToggle={() => toggleSection("allergies")}>
            <div className="space-y-3">
              <Field label="Drug Allergies (name + reaction)">
                <div className="space-y-1.5">
                  {intake.drugAllergies.length === 0 && (
                    <p className="text-[11px] text-muted-foreground italic">No known drug allergies (NKDA)</p>
                  )}
                  {intake.drugAllergies.map((a, idx) => (
                    <div key={idx} className="grid grid-cols-[1fr_1fr_auto] gap-2 items-center">
                      <TerminologyCombobox
                        value={a.name}
                        onChange={(v) =>
                          patch({
                            drugAllergies: intake.drugAllergies.map((x, i) =>
                              i === idx
                                ? {
                                    ...x,
                                    name: v,
                                    code: x.code && v === x.code.display ? x.code : undefined,
                                  }
                                : x,
                            ),
                          })
                        }
                        onSelect={(hit) =>
                          patch({
                            drugAllergies: intake.drugAllergies.map((x, i) =>
                              i === idx ? { ...x, name: hit.display, code: hit } : x,
                            ),
                          })
                        }
                        sabs="SNOMEDCT_US"
                        placeholder="Penicillin"
                      />
                      <Input
                        value={a.reaction}
                        onChange={(v) => patch({ drugAllergies: intake.drugAllergies.map((x, i) => (i === idx ? { ...x, reaction: v } : x)) })}
                        placeholder="Hives / Anaphylaxis"
                      />
                      <button
                        type="button"
                        onClick={() => patch({ drugAllergies: intake.drugAllergies.filter((_, i) => i !== idx) })}
                        className="grid place-items-center h-9 w-9 rounded-md border border-border hover:bg-red-50 hover:text-red-600"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() => patch({ drugAllergies: [...intake.drugAllergies, { name: "", reaction: "" }] })}
                    className="inline-flex items-center gap-1 text-[11px] font-semibold text-[var(--teal)] hover:underline"
                  >
                    <Plus className="h-3 w-3" /> Add drug allergy
                  </button>
                </div>
              </Field>
              <Field label="Environmental / Food Allergies">
                <ChipGroup
                  options={ENV_ALLERGY_OPTIONS as unknown as string[]}
                  value={intake.envAllergies}
                  onToggle={(v) => patch({ envAllergies: toggleInArray(intake.envAllergies, v) })}
                />
              </Field>
              <Field label="Current Medications (Rx, OTC, supplements)">
                <div className="space-y-1.5">
                  {intake.currentMeds.length === 0 && (
                    <p className="text-[11px] text-muted-foreground italic">None reported</p>
                  )}
                  {intake.currentMeds.map((m, idx) => (
                    <div key={idx} className="grid grid-cols-12 gap-2 items-center">
                      <div className="col-span-5">
                        <TerminologyCombobox
                          value={m.name}
                          onChange={(v) =>
                            patch({
                              currentMeds: intake.currentMeds.map((x, i) =>
                                i === idx
                                  ? {
                                      ...x,
                                      name: v,
                                      code: x.code && v === x.code.display ? x.code : undefined,
                                    }
                                  : x,
                              ),
                            })
                          }
                          onSelect={(hit) =>
                            patch({
                              currentMeds: intake.currentMeds.map((x, i) =>
                                i === idx ? { ...x, name: hit.display, code: hit } : x,
                              ),
                            })
                          }
                          sabs="RXNORM"
                          placeholder="Lisinopril"
                        />
                      </div>
                      <div className="col-span-3">
                        <Input
                          value={m.dose}
                          onChange={(v) => patch({ currentMeds: intake.currentMeds.map((x, i) => (i === idx ? { ...x, dose: v } : x)) })}
                          placeholder="10 mg"
                        />
                      </div>
                      <div className="col-span-3">
                        <Select
                          value={m.freq}
                          onChange={(v) => patch({ currentMeds: intake.currentMeds.map((x, i) => (i === idx ? { ...x, freq: v } : x)) })}
                          options={["", "PO Daily", "PO BID", "PO TID", "PO QID", "PO QHS", "PO Q6H", "PO Q8H", "PRN", "IV Daily"]}
                          placeholder="Freq"
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => patch({ currentMeds: intake.currentMeds.filter((_, i) => i !== idx) })}
                        className="col-span-1 grid place-items-center h-9 rounded-md border border-border hover:bg-red-50 hover:text-red-600"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() => patch({ currentMeds: [...intake.currentMeds, { name: "", dose: "", freq: "" }] })}
                    className="inline-flex items-center gap-1 text-[11px] font-semibold text-[var(--teal)] hover:underline"
                  >
                    <Plus className="h-3 w-3" /> Add medication
                  </button>
                </div>
              </Field>
            </div>
          </Section>

          <Section title="6 · Family History" open={open.family} onToggle={() => toggleSection("family")}>
            <div className="space-y-3">
              <Field label="Conditions in Immediate Blood Relatives">
                <ChipGroup
                  options={FAMILY_OPTIONS as unknown as string[]}
                  value={intake.familyConditions}
                  onToggle={(v) => patch({ familyConditions: toggleInArray(intake.familyConditions, v) })}
                />
              </Field>
              <Field label="Notes (relationship, age, condition)">
                <textarea
                  value={intake.familyNotes}
                  onChange={(e) => patch({ familyNotes: e.target.value })}
                  rows={2}
                  placeholder="Father deceased age 68 — MI. Mother alive, HTN."
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--teal)]/40"
                />
              </Field>
            </div>
          </Section>

          {err && (
            <div className="text-xs text-red-600 inline-flex items-center gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5" />
              {err}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-3 border-t border-border sticky bottom-0 bg-card -mx-5 -mb-5 px-5 py-3">
            <button type="button" onClick={onClose} className="rounded-md border border-border bg-background px-3 h-9 text-xs font-medium hover:bg-secondary transition">
              Cancel
            </button>
            <button
              type="button"
              onClick={handleAutoFill}
              className="inline-flex items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 hover:bg-amber-100 text-amber-900 px-3 h-9 text-xs font-semibold shadow-sm transition"
              title="Populate plausible mock data into every field"
            >
              <Wand2 className="h-3.5 w-3.5" /> Auto-Fill
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-1.5 rounded-md bg-[var(--teal)] hover:bg-[var(--teal)]/90 text-white px-4 h-9 text-xs font-semibold shadow-sm transition disabled:opacity-60"
            >
              {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserPlus className="h-3.5 w-3.5" />}
              Admit Patient
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Section({
  title,
  open,
  onToggle,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-background/60">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between px-3 h-10 text-left text-[12px] font-bold uppercase tracking-wider text-slate-700 hover:bg-secondary/40 transition rounded-t-lg"
      >
        <span>{title}</span>
        <ChevronDown className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && <div className="px-3 pb-3 pt-1 border-t border-border">{children}</div>}
    </section>
  );
}

function Input({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-[var(--teal)]/40 focus:border-[var(--teal)] transition"
    />
  );
}

function Select({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  options: readonly string[];
  placeholder?: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-[var(--teal)]/40 focus:border-[var(--teal)] transition"
    >
      {options.map((o) => (
        <option key={o} value={o}>
          {o === "" ? (placeholder ?? "—") : o}
        </option>
      ))}
    </select>
  );
}

function ChipGroup({
  options,
  value,
  onToggle,
}: {
  options: string[];
  value: string[];
  onToggle: (v: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const on = value.includes(o);
        return (
          <button
            key={o}
            type="button"
            onClick={() => onToggle(o)}
            className={`rounded-full px-2.5 py-1 text-[11px] font-medium border transition ${on ? "bg-[var(--teal)] text-white border-[var(--teal)]" : "bg-background text-slate-700 border-border hover:border-[var(--teal)]/60"}`}
          >
            {o}
          </button>
        );
      })}
    </div>
  );
}

function Field({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={`flex flex-col gap-1.5 ${className ?? ""}`}>
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">{label}</span>
      {children}
    </label>
  );
}