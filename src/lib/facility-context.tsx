import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export const FACILITIES = [
  "Memorial Hospital",
  "St. Jude Medical Center",
  "City General Infirmary",
  "County Health Pavilion",
  "Mercy Childrens Hospital",
] as const;

export type Facility = (typeof FACILITIES)[number];

export interface NurseProfile {
  name: string;
  facility: Facility;
  ward: string;
}

export type StaffRole = "RN" | "MD" | "PharmD" | "RT" | "Admin" | "Lab";

export interface StaffProfile {
  name: string;
  role: StaffRole;
  roleLabel: string;
  facility: Facility;
  ward: string;
}

export const STAFF_BY_FACILITY: Record<Facility, Record<StaffRole, StaffProfile>> = {
  "Memorial Hospital": {
    RN: { name: "Sarah Jenkins, RN", role: "RN", roleLabel: "Registered Nurse", facility: "Memorial Hospital", ward: "Unit 4B - MedSurg" },
    MD: { name: "Dr. Robert Patel", role: "MD", roleLabel: "Attending Physician", facility: "Memorial Hospital", ward: "Internal Medicine" },
    PharmD: { name: "Elena Rostova, PharmD", role: "PharmD", roleLabel: "Clinical Pharmacist", facility: "Memorial Hospital", ward: "Central Pharmacy" },
    RT: { name: "Marcus Brody, RRT", role: "RT", roleLabel: "Respiratory Therapist", facility: "Memorial Hospital", ward: "Pulmonary Services" },
    Admin: { name: "Diane Whitaker", role: "Admin", roleLabel: "Unit Administrator", facility: "Memorial Hospital", ward: "Operations" },
    Lab: { name: "Sarah Collins, CLT", role: "Lab", roleLabel: "Laboratory Technician", facility: "Memorial Hospital", ward: "Central Lab" },
  },
  "St. Jude Medical Center": {
    RN: { name: "Michael Chang, RN", role: "RN", roleLabel: "Registered Nurse", facility: "St. Jude Medical Center", ward: "ICU - Pod B" },
    MD: { name: "Dr. Jonathan Vance", role: "MD", roleLabel: "Attending Physician", facility: "St. Jude Medical Center", ward: "Critical Care" },
    PharmD: { name: "Amina Diop, PharmD", role: "PharmD", roleLabel: "Clinical Pharmacist", facility: "St. Jude Medical Center", ward: "ICU Pharmacy" },
    RT: { name: "Thomas Wright, RRT", role: "RT", roleLabel: "Respiratory Therapist", facility: "St. Jude Medical Center", ward: "Critical Care RT" },
    Admin: { name: "Harold Pierce", role: "Admin", roleLabel: "Unit Administrator", facility: "St. Jude Medical Center", ward: "Operations" },
    Lab: { name: "Alex Wong, CLT", role: "Lab", roleLabel: "Laboratory Technician", facility: "St. Jude Medical Center", ward: "ICU Diagnostic Lab" },
  },
  "City General Infirmary": {
    RN: { name: "Amanda Ross, RN", role: "RN", roleLabel: "Registered Nurse", facility: "City General Infirmary", ward: "ER - Trauma Bay" },
    MD: { name: "Dr. Carlos Mendez", role: "MD", roleLabel: "Attending Physician", facility: "City General Infirmary", ward: "Emergency Medicine" },
    PharmD: { name: "Chloe Kim, PharmD", role: "PharmD", roleLabel: "Clinical Pharmacist", facility: "City General Infirmary", ward: "ER Pharmacy" },
    RT: { name: "David Goldstein, RRT", role: "RT", roleLabel: "Respiratory Therapist", facility: "City General Infirmary", ward: "Emergency RT" },
    Admin: { name: "Renee Cabrera", role: "Admin", roleLabel: "Unit Administrator", facility: "City General Infirmary", ward: "Operations" },
    Lab: { name: "Maya Lin, CLT", role: "Lab", roleLabel: "Laboratory Technician", facility: "City General Infirmary", ward: "ER STAT Lab" },
  },
  "County Health Pavilion": {
    RN: { name: "Jordan Lee, RN", role: "RN", roleLabel: "Registered Nurse", facility: "County Health Pavilion", ward: "Med-Surg Float" },
    MD: { name: "Dr. Arjun Mehta", role: "MD", roleLabel: "Attending Physician", facility: "County Health Pavilion", ward: "Hospitalist Service" },
    PharmD: { name: "Fatima Al-Sayed, PharmD", role: "PharmD", roleLabel: "Clinical Pharmacist", facility: "County Health Pavilion", ward: "Inpatient Pharmacy" },
    RT: { name: "Grace Mulligan, RRT", role: "RT", roleLabel: "Respiratory Therapist", facility: "County Health Pavilion", ward: "Pulmonary Services" },
    Admin: { name: "Marcus Hadley", role: "Admin", roleLabel: "Unit Administrator", facility: "County Health Pavilion", ward: "Operations" },
    Lab: { name: "James Carter, CLT", role: "Lab", roleLabel: "Laboratory Technician", facility: "County Health Pavilion", ward: "Diagnostic Lab" },
  },
  "Mercy Childrens Hospital": {
    RN: { name: "Priya Shah, RN", role: "RN", roleLabel: "Registered Nurse", facility: "Mercy Childrens Hospital", ward: "Pediatrics - Wing C" },
    MD: { name: "Dr. William Bradshaw", role: "MD", roleLabel: "Attending Physician", facility: "Mercy Childrens Hospital", ward: "Pediatrics" },
    PharmD: { name: "Xavier Dupont, PharmD", role: "PharmD", roleLabel: "Clinical Pharmacist", facility: "Mercy Childrens Hospital", ward: "Pediatric Pharmacy" },
    RT: { name: "Jackson Brooks, RRT", role: "RT", roleLabel: "Respiratory Therapist", facility: "Mercy Childrens Hospital", ward: "Pediatric RT" },
    Admin: { name: "Olivia Sterling", role: "Admin", roleLabel: "Unit Administrator", facility: "Mercy Childrens Hospital", ward: "Operations" },
    Lab: { name: "Nisha Patel, CLT", role: "Lab", roleLabel: "Laboratory Technician", facility: "Mercy Childrens Hospital", ward: "Pediatric Lab" },
  },
};

export function staffForFacility(f: Facility, role: StaffRole): StaffProfile {
  return STAFF_BY_FACILITY[f][role];
}

export function useActiveStaff(role: StaffRole): StaffProfile {
  const { facility } = useFacility();
  return STAFF_BY_FACILITY[facility][role];
}

export const NURSES_BY_FACILITY: Record<Facility, NurseProfile> = {
  "Memorial Hospital": {
    name: "Sarah Jenkins, RN",
    facility: "Memorial Hospital",
    ward: "Unit 4B - MedSurg",
  },
  "St. Jude Medical Center": {
    name: "Michael Chang, RN",
    facility: "St. Jude Medical Center",
    ward: "ICU - Pod B",
  },
  "City General Infirmary": {
    name: "Amanda Ross, RN",
    facility: "City General Infirmary",
    ward: "ER - Trauma Bay",
  },
  "County Health Pavilion": {
    name: "Jordan Lee, RN",
    facility: "County Health Pavilion",
    ward: "Med-Surg Float",
  },
  "Mercy Childrens Hospital": {
    name: "Priya Shah, RN",
    facility: "Mercy Childrens Hospital",
    ward: "Pediatrics - Wing C",
  },
};

export function nurseForFacility(f: Facility): NurseProfile {
  return NURSES_BY_FACILITY[f];
}

export function useActiveNurse(): NurseProfile {
  const { facility } = useFacility();
  return NURSES_BY_FACILITY[facility];
}

const STORAGE_KEY = "spehr.activeFacility";

interface FacilityContextValue {
  facility: Facility;
  setFacility: (f: Facility) => void;
}

const FacilityContext = createContext<FacilityContextValue | null>(null);

export function FacilityProvider({ children }: { children: ReactNode }) {
  const [facility, setFacilityState] = useState<Facility>("Memorial Hospital");

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored && (FACILITIES as readonly string[]).includes(stored)) {
        setFacilityState(stored as Facility);
      }
    } catch {}
  }, []);

  const setFacility = (f: Facility) => {
    setFacilityState(f);
    try {
      localStorage.setItem(STORAGE_KEY, f);
    } catch {}
  };

  return (
    <FacilityContext.Provider value={{ facility, setFacility }}>
      {children}
    </FacilityContext.Provider>
  );
}

export function useFacility(): FacilityContextValue {
  const ctx = useContext(FacilityContext);
  if (!ctx) {
    // Safe fallback so components outside provider still render.
    return { facility: "Memorial Hospital", setFacility: () => {} };
  }
  return ctx;
}

export function FacilitySwitcher({
  variant = "dark",
  className = "",
}: {
  variant?: "dark" | "light";
  className?: string;
}) {
  const { facility, setFacility } = useFacility();
  const dark = variant === "dark";
  return (
    <label className={`inline-flex items-center gap-1.5 ${className}`}>
      <span
        className={`text-[10px] uppercase tracking-[0.18em] ${
          dark ? "text-white/55" : "text-slate-500"
        }`}
      >
        🏥 Select Facility Network
      </span>
      <select
        value={facility}
        onChange={(e) => setFacility(e.target.value as Facility)}
        className={
          dark
            ? "h-8 rounded-md bg-white/10 ring-1 ring-white/15 px-2 text-xs font-medium text-white outline-none hover:bg-white/15 focus:ring-[var(--teal)]/50 transition cursor-pointer"
            : "h-8 rounded-md border border-slate-200 bg-white px-2 text-xs font-medium text-slate-800 outline-none hover:bg-slate-50 focus:border-slate-400 transition cursor-pointer"
        }
      >
        {FACILITIES.map((f) => (
          <option key={f} value={f} className="text-slate-900">
            {f}
          </option>
        ))}
      </select>
    </label>
  );
}