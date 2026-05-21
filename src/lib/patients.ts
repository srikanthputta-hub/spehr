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

export const PATIENTS: Patient[] = [
  {
    room: "401-A",
    name: "Margaret Chen",
    age: 78,
    sex: "F",
    mrn: "MRN-884213",
    dob: "1947-03-12",
    code: "DNR",
    allergies: ["Penicillin", "Sulfa", "Latex"],
    diagnosis: "CHF Exacerbation",
    hr: 112,
    hrTrend: [98, 104, 101, 108, 110, 109, 112],
    bp: "98/54",
    bpTrend: [118, 112, 108, 104, 102, 100, 98],
    temp: 99.1,
    tempTrend: [98.6, 98.7, 98.9, 99.0, 99.1, 99.0, 99.1],
    o2: 91,
    o2Trend: [96, 95, 94, 93, 92, 92, 91],
    task: "IV Lasix due 14:00",
    admitNote:
      "78F w/ HFrEF (EF 30%), CKD III, prior CABG presenting with 4d progressive dyspnea, 2-pillow orthopnea, +6lb weight gain. ED exam: JVD to angle of jaw, bibasilar crackles, 2+ pitting edema to knees. CXR: pulmonary edema, cardiomegaly. BNP 2,840. Trop-I negative x2. Admitted to telemetry for IV diuresis, strict I/O, daily weights, ACE-I uptitration. Goals discussed with patient and daughter; DNR confirmed.",
    meds: [
      {
        id: "m1",
        name: "Furosemide (Lasix)",
        dose: "40 mg",
        route: "IV",
        freq: "Q12H",
        due: "14:00",
        notes: "Hold if SBP <90",
      },
      {
        id: "m2",
        name: "Lisinopril",
        dose: "10 mg",
        route: "PO",
        freq: "Daily",
        due: "14:00",
      },
      {
        id: "m3",
        name: "Potassium Chloride",
        dose: "20 mEq",
        route: "PO",
        freq: "BID",
        due: "14:00",
      },
      {
        id: "m4",
        name: "Atorvastatin",
        dose: "40 mg",
        route: "PO",
        freq: "QHS",
        due: "21:00",
      },
    ],
  },
  {
    room: "402-B",
    name: "Robert Alvarez",
    age: 64,
    sex: "M",
    mrn: "MRN-771902",
    dob: "1961-09-04",
    code: "Full Code",
    allergies: ["NKDA"],
    diagnosis: "Sepsis, UTI source",
    hr: 124,
    hrTrend: [110, 115, 118, 120, 122, 121, 124],
    bp: "86/48",
    bpTrend: [104, 100, 96, 92, 90, 88, 86],
    temp: 102.4,
    tempTrend: [101.0, 101.4, 101.8, 102.0, 102.2, 102.3, 102.4],
    o2: 94,
    o2Trend: [97, 96, 96, 95, 95, 94, 94],
    task: "Blood cultures x2",
    admitNote:
      "64M w/ T2DM, BPH presenting with 2d dysuria, rigors, AMS per family. ED vitals 102.6F, HR 128, BP 84/46, lactate 3.8. UA grossly purulent, blood and urine cultures pending. Started broad-spectrum Zosyn after cultures; 30 mL/kg LR bolus completed, on maintenance fluids. Admitted to PCU for sepsis bundle q1h reassessment.",
    meds: [
      {
        id: "m1",
        name: "Piperacillin-Tazobactam",
        dose: "4.5 g",
        route: "IV",
        freq: "Q8H",
        due: "14:00",
        notes: "Infuse over 30 min",
      },
      {
        id: "m2",
        name: "Lactated Ringer's",
        dose: "125 mL/hr",
        route: "IV",
        freq: "Continuous",
        due: "Now",
      },
      {
        id: "m3",
        name: "Acetaminophen",
        dose: "650 mg",
        route: "PO",
        freq: "Q6H PRN",
        due: "14:00",
        notes: "For T >101.5",
      },
    ],
  },
  {
    room: "404-A",
    name: "Janelle Owusu",
    age: 41,
    sex: "F",
    mrn: "MRN-902551",
    dob: "1984-06-22",
    code: "Full Code",
    allergies: ["Codeine"],
    diagnosis: "Post-op Day 1 — Lap chole",
    hr: 82,
    hrTrend: [88, 86, 84, 82, 80, 82, 82],
    bp: "118/74",
    bpTrend: [122, 120, 118, 116, 118, 118, 118],
    temp: 98.4,
    tempTrend: [98.2, 98.3, 98.4, 98.5, 98.4, 98.4, 98.4],
    o2: 98,
    o2Trend: [98, 98, 99, 98, 98, 98, 98],
    task: "PO Meds due 14:00",
    admitNote:
      "41F otherwise healthy s/p uncomplicated laparoscopic cholecystectomy for symptomatic cholelithiasis. POD#1: tolerating clear liquids, ambulating in hallway, pain 3/10 controlled on oral regimen. Incisions C/D/I. Plan: advance diet, transition off IV access, anticipate discharge today pending PT clearance.",
    meds: [
      {
        id: "m1",
        name: "Acetaminophen",
        dose: "1 g",
        route: "PO",
        freq: "Q6H",
        due: "14:00",
      },
      {
        id: "m2",
        name: "Ibuprofen",
        dose: "600 mg",
        route: "PO",
        freq: "Q8H",
        due: "14:00",
        notes: "Take with food",
      },
      {
        id: "m3",
        name: "Ondansetron",
        dose: "4 mg",
        route: "PO",
        freq: "Q8H PRN",
        due: "PRN",
      },
    ],
  },
  {
    room: "407-B",
    name: "Henry Whitaker",
    age: 71,
    sex: "M",
    mrn: "MRN-650118",
    dob: "1954-11-18",
    code: "DNI",
    allergies: ["Iodine contrast"],
    diagnosis: "COPD Exacerbation",
    hr: 96,
    hrTrend: [92, 94, 95, 96, 97, 96, 96],
    bp: "142/88",
    bpTrend: [138, 140, 142, 144, 142, 142, 142],
    temp: 99.8,
    tempTrend: [99.2, 99.4, 99.6, 99.7, 99.8, 99.8, 99.8],
    o2: 88,
    o2Trend: [92, 91, 90, 89, 88, 88, 88],
    task: "Wound care 15:30",
    admitNote:
      "71M w/ severe COPD (GOLD IV, FEV1 28%), former smoker (60 pack-yr), on 2L home O2. Presented w/ 3d increased sputum production, purulence, and worsening dyspnea. CXR w/ hyperinflation, no infiltrate. Started on prednisone burst, doxycycline, scheduled DuoNebs. Wound: chronic R lower extremity ulcer, dressing changes BID. DNI confirmed; BiPAP if needed.",
    meds: [
      {
        id: "m1",
        name: "Albuterol-Ipratropium Nebulizer",
        dose: "3 mL",
        route: "Neb",
        freq: "Q4H",
        due: "14:00",
      },
      {
        id: "m2",
        name: "Prednisone",
        dose: "40 mg",
        route: "PO",
        freq: "Daily",
        due: "14:00",
      },
      {
        id: "m3",
        name: "Doxycycline",
        dose: "100 mg",
        route: "PO",
        freq: "BID",
        due: "14:00",
      },
      {
        id: "m4",
        name: "Tiotropium",
        dose: "18 mcg",
        route: "Inh",
        freq: "Daily",
        due: "08:00",
      },
    ],
  },
];

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
