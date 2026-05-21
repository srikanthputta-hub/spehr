import {
  MEDICATION_CATALOG,
  LAB_CATALOG,
  type MedicationCatalogEntry,
  type LabCatalogEntry,
} from "@/constants/clinical-catalog";

// Re-export the Master Clinical Catalog so patient generation / admission
// randomizer logic can pull diverse meds + labs from a single source of truth.
export { MEDICATION_CATALOG, LAB_CATALOG };

export type CodeStatus = "Full Code" | "DNR" | "DNI" | "Comfort";

export interface MedOrder {
  id: string;
  name: string;
  dose: string;
  route: string;
  freq: string;
  due: string;
  notes?: string;
}

export interface LabResult {
  id: string;
  name: string;
  value: string;
  unit: string;
  referenceRange: string;
  status: "RESULTED";
}

export interface Patient {
  room: string;
  name: string;
  age: number;
  sex: "M" | "F";
  mrn: string;
  dob: string;
  code: CodeStatus;
  allergies: string[];
  diagnosis: string;
  hr: number;
  hrTrend: number[];
  bp: string;
  bpTrend: number[];
  temp: number;
  tempTrend: number[];
  o2: number;
  o2Trend: number[];
  task: string;
  admitNote: string;
  meds: MedOrder[];
  labs?: LabResult[];
}

// Legacy mock census purged — the live system is fully driven by the Supabase
// `patients` table seeded via the Ghost AI admission randomizer.
export const PATIENTS: Patient[] = [];

/* ------------------------------------------------------------------ */
/* Clinical Randomizer — applied to the initial mock census so every  */
/* starting patient ships with 3 random meds + 2 random labs drawn    */
/* from the Master Clinical Catalog (mirrors the admission flow).     */
/* ------------------------------------------------------------------ */
function pickUnique<T>(arr: readonly T[], n: number): T[] {
  const copy = [...arr];
  const out: T[] = [];
  for (let i = 0; i < n && copy.length; i++) {
    out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
  }
  return out;
}

function mockLabValue(lab: LabCatalogEntry): string {
  const rng = lab.referenceRange.trim();
  if (/negative/i.test(rng)) return "Negative";
  const lt = rng.match(/^<\s*([\d.]+)/);
  if (lt) return (Math.random() * parseFloat(lt[1])).toFixed(2);
  const range = rng.match(/([\d.]+)\s*[–-]\s*([\d.]+)/);
  if (range) {
    const lo = parseFloat(range[1]);
    const hi = parseFloat(range[2]);
    const decimals = (range[1].split(".")[1]?.length ?? 0) || 1;
    return (lo + Math.random() * (hi - lo)).toFixed(decimals);
  }
  return (Math.random() * 10).toFixed(1);
}

function randomMedsFor(mrn: string): MedOrder[] {
  return pickUnique(MEDICATION_CATALOG, 3).map(
    (m: MedicationCatalogEntry, i): MedOrder => ({
      id: `${mrn}-m${i + 1}`,
      name: m.name,
      dose: m.dose,
      route: m.route,
      freq: "Q8H",
      due: ["08:00", "12:00", "14:00", "18:00", "22:00"][
        Math.floor(Math.random() * 5)
      ],
    }),
  );
}

function randomLabsFor(mrn: string): LabResult[] {
  return pickUnique(LAB_CATALOG, 2).map(
    (l: LabCatalogEntry, i): LabResult => ({
      id: `${mrn}-l${i + 1}`,
      name: l.name,
      value: mockLabValue(l),
      unit: l.unit,
      referenceRange: l.referenceRange,
      status: "RESULTED",
    }),
  );
}

// (No seed census to randomize — PATIENTS is intentionally empty.)
void randomMedsFor;
void randomLabsFor;

// One-time stale-cache flush: prior builds may have persisted the census
// to localStorage, which would shadow the freshly randomized seed data.
// Bump CENSUS_CACHE_VERSION to force-clear any future stale entries.
const CENSUS_CACHE_VERSION = "v3-purge-legacy";
const CENSUS_CACHE_FLAG = "spehr.censusCacheVersion";
if (typeof window !== "undefined") {
  try {
    if (localStorage.getItem(CENSUS_CACHE_FLAG) !== CENSUS_CACHE_VERSION) {
      ["spehr.patients", "spehr.census", "patients", "census"].forEach((k) => {
        localStorage.removeItem(k);
        sessionStorage.removeItem(k);
      });
      localStorage.setItem(CENSUS_CACHE_FLAG, CENSUS_CACHE_VERSION);
    }
  } catch {
    /* storage unavailable — ignore */
  }
}

export function getPatient(mrn: string): Patient | undefined {
  return PATIENTS.find((p) => p.mrn === mrn);
}

export function hrOutOfRange(hr: number) {
  return hr < 60 || hr > 100;
}
export function bpOutOfRange(bp: string) {
  const [s, d] = bp.split("/").map(Number);
  return s < 90 || s > 140 || d < 60 || d > 90;
}
export function o2OutOfRange(o2: number) {
  return o2 < 92;
}
export function tempOutOfRange(t: number) {
  return t < 97 || t > 100.4;
}
