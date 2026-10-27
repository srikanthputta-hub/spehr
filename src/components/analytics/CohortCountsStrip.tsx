import { AlertTriangle, ChevronDown } from "lucide-react";
import { Link } from "@tanstack/react-router";
import {
  useHighAcuityCohort,
  HIGH_ACUITY_VS_NAME,
  type HighAcuityPatient,
} from "@/hooks/useCohortCounts";
import { InfoHint } from "@/components/ui/info-hint";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

type Variant = "pill" | "card";

interface Props {
  className?: string;
  facilityName?: string;
  variant?: Variant;
}

function patientLabel(p: HighAcuityPatient): string {
  const full = [p.first_name, p.last_name].filter(Boolean).join(" ").trim();
  return full || p.name || p.mrn;
}

function scopeSuffix(facilityName?: string) {
  return facilityName
    ? ` Scoped to admitted patients at ${facilityName}.`
    : " Scoped to admitted patients across the entire SPEHR network.";
}

function PatientList({
  patients,
  loading,
  facilityName,
}: {
  patients: HighAcuityPatient[] | null;
  loading: boolean;
  facilityName?: string;
}) {
  if (loading && patients === null) {
    return <div className="text-xs text-slate-500 px-2 py-3">Loading…</div>;
  }
  if (!patients || patients.length === 0) {
    return (
      <div className="text-xs text-slate-500 px-2 py-3">
        No high-acuity admissions{facilityName ? ` at ${facilityName}` : ""}.
      </div>
    );
  }
  return (
    <ul className="max-h-72 overflow-y-auto divide-y divide-slate-100">
      {patients.map((p) => (
        <li key={p.mrn}>
          <Link
            to="/patient/$mrn"
            params={{ mrn: p.mrn }}
            className="flex items-center justify-between gap-3 px-2.5 py-2 text-xs hover:bg-rose-50 rounded-sm"
          >
            <span className="flex flex-col leading-tight min-w-0">
              <span className="font-medium text-slate-900 truncate">{patientLabel(p)}</span>
              <span className="text-[10px] uppercase tracking-wider text-slate-500 tabular-nums">
                MRN {p.mrn}
                {p.room ? ` · Room ${p.room}` : ""}
              </span>
            </span>
            <span className="text-[10px] text-rose-700 font-semibold shrink-0">Open chart →</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * Compact clickable tile — shows currently-admitted patients whose active
 * conditions match the published High-Acuity ED Presentations value set.
 * Click to open a popover listing the actual patients (each linkable to
 * their chart at /patient/$mrn).
 *
 * Pass `facilityName` to scope to a single facility; omit for the true
 * network-wide total (only appropriate on the Network Analytics page).
 */
export default function CohortCountsStrip({
  className = "",
  facilityName,
  variant = "pill",
}: Props) {
  const { count, patients, loading } = useHighAcuityCohort(facilityName);
  const display = loading && count === null ? "…" : count === null ? "—" : String(count);
  const hintText = `Currently admitted patients (patients.status = "Admitted") who have at least one active condition coded to the published "${HIGH_ACUITY_VS_NAME}" value set (chest pain, ischemic stroke, cardiac arrest, acute MI, anaphylaxis, acute respiratory failure, GI hemorrhage, altered mental status, cerebrovascular accident).${scopeSuffix(facilityName)} Click the tile to see the matched patients.`;

  if (variant === "card") {
    return (
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="Currently admitted high-acuity patients — open list"
            className={`text-left rounded-xl border bg-white p-5 shadow-sm w-full transition-colors ${
              (count ?? 0) > 0
                ? "border-red-300 hover:border-red-400"
                : "border-slate-200 hover:border-slate-300"
            } ${className}`}
          >
            <div className="flex items-center justify-between">
              <div className="text-xs font-medium uppercase tracking-widest text-slate-500 flex items-center">
                Admitted · High-Acuity
                <InfoHint className="ml-1.5" text={hintText} />
              </div>
              <div className="grid place-items-center h-8 w-8 rounded-md bg-red-50 text-red-700">
                <AlertTriangle className="h-5 w-5" />
              </div>
            </div>
            <div className="mt-2 text-3xl font-bold text-slate-900 flex items-center gap-2">
              {display}
              <ChevronDown className="h-4 w-4 text-slate-400" />
            </div>
            <div className="mt-1 text-xs text-slate-500">
              High-Acuity ED Presentations value set
            </div>
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 p-2">
          <PatientList patients={patients} loading={loading} facilityName={facilityName} />
        </PopoverContent>
      </Popover>
    );
  }

  return (
    <section className={`flex ${className}`} aria-label="Currently admitted high-acuity patients">
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="inline-flex items-center gap-2.5 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 shadow-[0_1px_0_rgba(15,23,42,0.03)] hover:bg-rose-100 transition-colors text-left"
          >
            <AlertTriangle className="h-4 w-4 text-rose-600 flex-none" />
            <div className="flex flex-col leading-none">
              <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-rose-700 font-semibold">
                Admitted · High-Acuity
                <InfoHint className="ml-0.5" text={hintText} />
              </div>
              <div className="text-lg font-bold tabular-nums text-rose-900 flex items-center gap-1">
                {display}
                <ChevronDown className="h-3 w-3 text-rose-500" />
              </div>
            </div>
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 p-2">
          <PatientList patients={patients} loading={loading} facilityName={facilityName} />
        </PopoverContent>
      </Popover>
    </section>
  );
}
