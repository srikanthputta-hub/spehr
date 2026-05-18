import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Activity,
  Brain,
  ClipboardList,
  Loader2,
  Send,
  Stethoscope,
  User,
} from "lucide-react";
import { BoardHeader } from "@/components/BoardShell";
import { supabase } from "@/integrations/supabase/client";
import { useFacility } from "@/lib/facility-context";

type Patient = {
  mrn: string;
  first_name: string | null;
  last_name: string | null;
  age: number | null;
  gender: string | null;
  room: string | null;
  code_status: string | null;
  chief_complaint: string | null;
  diagnosis: string | null;
  hr: number | null;
  bp_systolic: number | null;
  bp_diastolic: number | null;
  spo2: number | null;
  facility_name: string | null;
};

const ROUTES = ["PO", "IV", "IM", "SubQ", "Inh", "Neb", "Topical", "PR"];
const FREQS = ["Once", "Daily", "BID", "TID", "QID", "Q4H", "Q6H", "Q8H", "Q12H", "PRN", "Continuous"];

function PhysicianBoard() {
  const { facility } = useFacility();
  const [patients, setPatients] = useState<Patient[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedMrn, setSelectedMrn] = useState<string | null>(null);

  // Order form
  const [drug, setDrug] = useState("");
  const [dose, setDose] = useState("");
  const [route, setRoute] = useState("PO");
  const [freq, setFreq] = useState("Daily");
  const [submitting, setSubmitting] = useState(false);

  // AI DDx
  const [ddxLoading, setDdxLoading] = useState(false);
  const [ddx, setDdx] = useState<{ dx: string; likelihood: string; rationale: string }[] | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      const { data, error } = await supabase
        .from("patients")
        .select(
          "mrn, first_name, last_name, age, gender, room, code_status, chief_complaint, diagnosis, hr, bp_systolic, bp_diastolic, spo2, facility_name",
        )
        .order("room", { ascending: true });
      if (!active) return;
      if (error) {
        setError(error.message);
      } else {
        setPatients((data ?? []) as Patient[]);
        if (data && data.length > 0) setSelectedMrn((data[0] as Patient).mrn);
      }
      setLoading(false);
    })();

    const channel = supabase
      .channel("physician-patients")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "patients" },
        () => {
          supabase
            .from("patients")
            .select(
              "mrn, first_name, last_name, age, gender, room, code_status, chief_complaint, diagnosis, hr, bp_systolic, bp_diastolic, spo2, facility_name",
            )
            .order("room", { ascending: true })
            .then(({ data }) => {
              if (data) setPatients(data as Patient[]);
            });
        },
      )
      .subscribe();
    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  }, []);

  const visiblePatients = useMemo(
    () => patients.filter((p) => (p.facility_name ?? "Memorial Hospital") === facility),
    [patients, facility],
  );

  const selected = useMemo(
    () => visiblePatients.find((p) => p.mrn === selectedMrn) ?? null,
    [visiblePatients, selectedMrn],
  );

  useEffect(() => {
    if (selected) return;
    if (visiblePatients.length > 0) {
      setSelectedMrn(visiblePatients[0].mrn);
    } else {
      setSelectedMrn(null);
    }
  }, [visiblePatients, selected]);

  // Reset side panels when patient changes
  useEffect(() => {
    setDdx(null);
    setDrug("");
    setDose("");
    setRoute("PO");
    setFreq("Daily");
  }, [selectedMrn]);

  const submitOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    if (!drug.trim() || !dose.trim()) {
      toast.error("Drug name and dose are required");
      return;
    }
    setSubmitting(true);
    const { error } = await supabase.from("medication_orders").insert({
      mrn: selected.mrn,
      drug_name: drug.trim(),
      dose: dose.trim(),
      route,
      frequency: freq,
      status: "PENDING_PHARMACY",
    });
    setSubmitting(false);
    if (error) {
      toast.error("Order failed", { description: error.message });
      return;
    }
    toast.success("Order routed to Pharmacy", {
      description: `${drug.trim()} ${dose.trim()} ${route} ${freq}`,
    });
    setDrug("");
    setDose("");
  };

  const runDdx = async () => {
    if (!selected) return;
    setDdxLoading(true);
    setDdx(null);
    await new Promise((r) => setTimeout(r, 1400));
    setDdx(generateDdx(selected));
    setDdxLoading(false);
  };

  return (
    <main className="min-h-screen bg-slate-50">
      <BoardHeader
        title="Attending Physician Board"
        badge="Provider · MD"
        subtitle="Computerized Provider Order Entry"
      />
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 p-6">
        {/* Patient list */}
        <aside className="lg:col-span-1">
          <div className="rounded-lg border border-slate-200 bg-white">
            <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
              <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">
                Active Census
              </div>
              <span className="text-[11px] text-slate-500">{patients.length}</span>
            </div>
            <div className="max-h-[calc(100vh-160px)] overflow-y-auto divide-y divide-slate-100">
              {loading && (
                <div className="p-4 text-xs text-slate-500">Loading patients…</div>
              )}
              {error && (
                <div className="p-4 text-xs text-red-600">Unable to load — {error}</div>
              )}
              {!loading && patients.length === 0 && !error && (
                <div className="p-4 text-xs text-slate-500">No active patients.</div>
              )}
              {patients.map((p) => {
                const active = p.mrn === selectedMrn;
                const alert =
                  (p.spo2 !== null && p.spo2 < 92) ||
                  (p.hr !== null && (p.hr > 110 || p.hr < 50));
                return (
                  <button
                    key={p.mrn}
                    onClick={() => setSelectedMrn(p.mrn)}
                    className={`w-full text-left px-3 py-2.5 transition ${
                      active ? "bg-[#0c2340] text-white" : "hover:bg-slate-50"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-sm font-medium truncate">
                        {p.first_name} {p.last_name}
                      </div>
                      <span
                        className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${
                          active ? "bg-white/15 text-white" : "bg-slate-100 text-slate-600"
                        }`}
                      >
                        {p.room ?? "—"}
                      </span>
                    </div>
                    <div
                      className={`mt-0.5 text-[11px] truncate ${
                        active ? "text-white/75" : "text-slate-500"
                      }`}
                    >
                      {p.diagnosis || p.chief_complaint || "—"}
                    </div>
                    <div
                      className={`mt-1 flex items-center gap-2 text-[10px] ${
                        active ? "text-white/80" : "text-slate-500"
                      }`}
                    >
                      <span>HR {p.hr ?? "—"}</span>
                      <span>
                        BP {p.bp_systolic ?? "—"}/{p.bp_diastolic ?? "—"}
                      </span>
                      <span>SpO₂ {p.spo2 ?? "—"}</span>
                      {alert && (
                        <span
                          className={`ml-auto inline-flex items-center gap-0.5 font-semibold ${
                            active ? "text-amber-300" : "text-red-600"
                          }`}
                        >
                          <Activity className="h-3 w-3" /> alert
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </aside>

        {/* CPOE workspace */}
        <section className="lg:col-span-2 space-y-4">
          {!selected ? (
            <div className="rounded-lg border border-dashed border-slate-300 bg-white p-12 text-center text-sm text-slate-500">
              Select a patient from the census to open CPOE workspace.
            </div>
          ) : (
            <>
              {/* Demographic banner */}
              <div className="rounded-lg border border-slate-200 bg-white">
                <div className="flex flex-wrap items-center gap-6 px-5 py-4">
                  <div className="flex items-center gap-3">
                    <div className="grid place-items-center h-10 w-10 rounded-md bg-[#0c2340] text-white">
                      <User className="h-5 w-5" />
                    </div>
                    <div>
                      <div className="text-base font-semibold text-slate-900 leading-tight">
                        {selected.first_name} {selected.last_name}
                      </div>
                      <div className="text-[11px] text-slate-500 font-mono">
                        {selected.mrn}
                      </div>
                    </div>
                  </div>
                  <BannerStat label="Age / Sex" value={`${selected.age ?? "—"} ${selected.gender ?? ""}`} />
                  <BannerStat label="Room" value={selected.room ?? "—"} />
                  <BannerStat
                    label="Code"
                    value={selected.code_status ?? "—"}
                    accent={selected.code_status === "DNR" || selected.code_status === "DNI" ? "amber" : "default"}
                  />
                  <BannerStat
                    label="Diagnosis"
                    value={selected.diagnosis || selected.chief_complaint || "—"}
                    wide
                  />
                </div>
              </div>

              {/* CPOE form */}
              <div className="rounded-lg border border-slate-200 bg-white">
                <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
                  <div className="flex items-center gap-2">
                    <ClipboardList className="h-4 w-4 text-[#0c2340]" />
                    <h2 className="text-sm font-semibold text-slate-900">
                      CPOE: Write New Orders
                    </h2>
                  </div>
                  <span className="text-[10px] uppercase tracking-[0.18em] text-slate-500">
                    Routes to Pharmacy Queue
                  </span>
                </div>
                <form onSubmit={submitOrder} className="grid grid-cols-12 gap-3 p-5">
                  <Field label="Drug Name" className="col-span-12 md:col-span-5">
                    <input
                      value={drug}
                      onChange={(e) => setDrug(e.target.value)}
                      placeholder="e.g. Furosemide"
                      className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0c2340]/30"
                    />
                  </Field>
                  <Field label="Dose" className="col-span-6 md:col-span-3">
                    <input
                      value={dose}
                      onChange={(e) => setDose(e.target.value)}
                      placeholder="40 mg"
                      className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0c2340]/30"
                    />
                  </Field>
                  <Field label="Route" className="col-span-6 md:col-span-2">
                    <select
                      value={route}
                      onChange={(e) => setRoute(e.target.value)}
                      className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0c2340]/30"
                    >
                      {ROUTES.map((r) => (
                        <option key={r} value={r}>{r}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Frequency" className="col-span-12 md:col-span-2">
                    <select
                      value={freq}
                      onChange={(e) => setFreq(e.target.value)}
                      className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0c2340]/30"
                    >
                      {FREQS.map((f) => (
                        <option key={f} value={f}>{f}</option>
                      ))}
                    </select>
                  </Field>
                  <div className="col-span-12 flex items-center justify-between pt-1">
                    <div className="text-[11px] text-slate-500">
                      New orders set to <span className="font-mono text-slate-700">PENDING_PHARMACY</span>
                    </div>
                    <button
                      type="submit"
                      disabled={submitting}
                      className="inline-flex items-center gap-2 rounded-md bg-[#0c2340] px-4 py-2 text-sm font-medium text-white hover:bg-[#0c2340]/90 disabled:opacity-60"
                    >
                      {submitting ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Send className="h-4 w-4" />
                      )}
                      Submit &amp; Route to Pharmacy
                    </button>
                  </div>
                </form>
              </div>

              {/* AI DDx */}
              <div className="rounded-lg border border-slate-200 bg-white">
                <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
                  <div className="flex items-center gap-2">
                    <Brain className="h-4 w-4 text-violet-600" />
                    <h2 className="text-sm font-semibold text-slate-900">
                      Clinical AI Consult: Differential Diagnosis
                    </h2>
                  </div>
                  <button
                    onClick={runDdx}
                    disabled={ddxLoading}
                    className="inline-flex items-center gap-2 rounded-md border border-violet-200 bg-violet-50 px-3 py-1.5 text-xs font-medium text-violet-700 hover:bg-violet-100 disabled:opacity-60"
                  >
                    {ddxLoading ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Stethoscope className="h-3.5 w-3.5" />
                    )}
                    {ddxLoading ? "Analyzing…" : "Run AI Differential"}
                  </button>
                </div>
                <div className="p-5">
                  {ddxLoading && (
                    <div className="text-xs text-slate-500 flex items-center gap-2">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Analyzing clinical presentation…
                    </div>
                  )}
                  {!ddxLoading && !ddx && (
                    <div className="text-xs text-slate-500">
                      Generate an AI-assisted differential based on{" "}
                      <span className="font-medium text-slate-700">
                        {selected.diagnosis || selected.chief_complaint || "the active presentation"}
                      </span>.
                    </div>
                  )}
                  {ddx && (
                    <ol className="space-y-3">
                      {ddx.map((d, i) => (
                        <li
                          key={i}
                          className="rounded-md border border-slate-200 bg-slate-50/60 p-3"
                        >
                          <div className="flex items-center justify-between">
                            <div className="text-sm font-semibold text-slate-900">
                              {i + 1}. {d.dx}
                            </div>
                            <span className="text-[10px] uppercase tracking-[0.18em] text-violet-700 bg-violet-100 rounded px-1.5 py-0.5">
                              {d.likelihood}
                            </span>
                          </div>
                          <div className="mt-1 text-xs text-slate-600 leading-relaxed">
                            {d.rationale}
                          </div>
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              </div>
            </>
          )}
        </section>
      </div>
    </main>
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
    <label className={`block ${className ?? ""}`}>
      <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500 mb-1">
        {label}
      </div>
      {children}
    </label>
  );
}

function BannerStat({
  label,
  value,
  wide,
  accent = "default",
}: {
  label: string;
  value: string;
  wide?: boolean;
  accent?: "default" | "amber";
}) {
  return (
    <div className={wide ? "min-w-0 flex-1" : ""}>
      <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">{label}</div>
      <div
        className={`text-sm font-medium truncate ${
          accent === "amber" ? "text-amber-700" : "text-slate-900"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function generateDdx(p: Patient): { dx: string; likelihood: string; rationale: string }[] {
  const seed = `${p.diagnosis ?? ""} ${p.chief_complaint ?? ""}`.toLowerCase();
  const sets: { match: RegExp; out: { dx: string; likelihood: string; rationale: string }[] }[] = [
    {
      match: /chf|heart failure|pulmonary edema/,
      out: [
        { dx: "Acute Decompensated HFrEF", likelihood: "High", rationale: "Progressive dyspnea, orthopnea, weight gain and JVD with low SpO₂ and hypotension consistent with volume overload." },
        { dx: "Acute Coronary Syndrome (NSTEMI)", likelihood: "Moderate", rationale: "Demand ischemia from decompensation; recommend serial troponin and 12-lead ECG to exclude type II MI." },
        { dx: "Hospital-Acquired Pneumonia", likelihood: "Low-Moderate", rationale: "Overlap of crackles and hypoxia; obtain CXR to evaluate for new infiltrate vs. cephalization." },
      ],
    },
    {
      match: /sepsis|uti|septic/,
      out: [
        { dx: "Urosepsis (Gram-negative bacteremia)", likelihood: "High", rationale: "Pyuria with SIRS criteria, lactate elevation, and hypotension responsive to fluids supports urinary source bacteremia." },
        { dx: "Pyelonephritis with AKI", likelihood: "Moderate", rationale: "Ascending UTI with flank tenderness pattern; trend creatinine and consider renal US if no improvement." },
        { dx: "Septic Shock from Alternate Source", likelihood: "Low-Moderate", rationale: "Broaden workup with blood cultures x2, CXR, and intra-abdominal imaging if hemodynamics worsen." },
      ],
    },
    {
      match: /copd|emphysema|asthma/,
      out: [
        { dx: "Acute COPD Exacerbation, infectious trigger", likelihood: "High", rationale: "Increased sputum purulence, dyspnea, and hypoxia on home O₂ baseline; appropriate for steroids and macrolide/doxy." },
        { dx: "Community-Acquired Pneumonia", likelihood: "Moderate", rationale: "Low-grade fever and worsening gas exchange — repeat CXR and procalcitonin to risk-stratify." },
        { dx: "Pulmonary Embolism", likelihood: "Low-Moderate", rationale: "Disproportionate hypoxia and tachycardia in immobile patient; consider Wells score and CTPA if indicated." },
      ],
    },
    {
      match: /post.?op|lap chole|cholecystectomy|surgical/,
      out: [
        { dx: "Expected Post-operative Recovery", likelihood: "High", rationale: "POD#1 vitals within normal range, ambulating, tolerating PO — consistent with uneventful course." },
        { dx: "Surgical Site Infection (early)", likelihood: "Low", rationale: "Monitor incisions for erythema, induration, or drainage; trend WBC and temperature curve." },
        { dx: "Post-op Ileus", likelihood: "Low", rationale: "Assess bowel sounds, flatus, and PO tolerance before advancing diet aggressively." },
      ],
    },
    {
      match: /fever|febrile|pyrexia/,
      out: [
        { dx: "Viral Syndrome", likelihood: "High", rationale: "Self-limited febrile illness with stable hemodynamics and unremarkable focal exam supports viral etiology." },
        { dx: "Occult Bacterial Infection", likelihood: "Moderate", rationale: "Obtain CBC w/diff, UA, CXR, and blood cultures if persistent fever >72h or new localizing signs." },
        { dx: "Drug Fever / Inflammatory", likelihood: "Low", rationale: "Review medication list and inflammatory markers (CRP/ESR) if fever persists without source." },
      ],
    },
  ];
  for (const s of sets) {
    if (s.match.test(seed)) return s.out;
  }
  return [
    { dx: "Undifferentiated Acute Illness", likelihood: "Moderate", rationale: "Broad presentation; obtain CBC, CMP, lactate, UA, and CXR to narrow the differential." },
    { dx: "Electrolyte / Metabolic Derangement", likelihood: "Moderate", rationale: "Check Na, K, Mg, Ca, glucose, and renal function to exclude reversible contributors." },
    { dx: "Medication-Related Adverse Effect", likelihood: "Low-Moderate", rationale: "Reconcile home and inpatient medications for interactions or new agents temporally linked to symptoms." },
  ];
}

export const Route = createFileRoute("/physician-board")({
  component: PhysicianBoard,
});