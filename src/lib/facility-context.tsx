import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export const FACILITIES = [
  "Memorial Hospital",
  "St. Jude Medical Center",
  "City General Infirmary",
  "County Health Pavilion",
  "Srik Health Clinic",
] as const;

export type Facility = (typeof FACILITIES)[number];

export interface NurseProfile {
  name: string;
  facility: Facility;
  ward: string;
}

export type StaffRole = "RN" | "MD" | "PharmD" | "Finance" | "Admin" | "Lab" | "Reception";

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
    Finance: { name: "Daniel Whitfield, CPA", role: "Finance", roleLabel: "Corporate Finance & Accounts", facility: "Memorial Hospital", ward: "Revenue Cycle Office" },
    Admin: { name: "Diane Whitaker", role: "Admin", roleLabel: "Unit Administrator", facility: "Memorial Hospital", ward: "Operations" },
    Lab: { name: "Sarah Collins, CLT", role: "Lab", roleLabel: "Laboratory Technician", facility: "Memorial Hospital", ward: "Central Lab" },
    Reception: { name: "Hannah Brooks", role: "Reception", roleLabel: "Admissions / Reception", facility: "Memorial Hospital", ward: "Front Desk · Main Lobby" },
  },
  "St. Jude Medical Center": {
    RN: { name: "Michael Chang, RN", role: "RN", roleLabel: "Registered Nurse", facility: "St. Jude Medical Center", ward: "ICU - Pod B" },
    MD: { name: "Dr. Jonathan Vance", role: "MD", roleLabel: "Attending Physician", facility: "St. Jude Medical Center", ward: "Critical Care" },
    PharmD: { name: "Amina Diop, PharmD", role: "PharmD", roleLabel: "Clinical Pharmacist", facility: "St. Jude Medical Center", ward: "ICU Pharmacy" },
    Finance: { name: "Rachel Bergman, CFO", role: "Finance", roleLabel: "Corporate Finance & Accounts", facility: "St. Jude Medical Center", ward: "Hospital Billing Office" },
    Admin: { name: "Harold Pierce", role: "Admin", roleLabel: "Unit Administrator", facility: "St. Jude Medical Center", ward: "Operations" },
    Lab: { name: "Alex Wong, CLT", role: "Lab", roleLabel: "Laboratory Technician", facility: "St. Jude Medical Center", ward: "ICU Diagnostic Lab" },
    Reception: { name: "Marisol Vega", role: "Reception", roleLabel: "Admissions / Reception", facility: "St. Jude Medical Center", ward: "Admissions Desk · Tower B" },
  },
  "City General Infirmary": {
    RN: { name: "Amanda Ross, RN", role: "RN", roleLabel: "Registered Nurse", facility: "City General Infirmary", ward: "ER - Trauma Bay" },
    MD: { name: "Dr. Carlos Mendez", role: "MD", roleLabel: "Attending Physician", facility: "City General Infirmary", ward: "Emergency Medicine" },
    PharmD: { name: "Chloe Kim, PharmD", role: "PharmD", roleLabel: "Clinical Pharmacist", facility: "City General Infirmary", ward: "ER Pharmacy" },
    Finance: { name: "Andre Lacroix, CPA", role: "Finance", roleLabel: "Corporate Finance & Accounts", facility: "City General Infirmary", ward: "Patient Accounts" },
    Admin: { name: "Renee Cabrera", role: "Admin", roleLabel: "Unit Administrator", facility: "City General Infirmary", ward: "Operations" },
    Lab: { name: "Maya Lin, CLT", role: "Lab", roleLabel: "Laboratory Technician", facility: "City General Infirmary", ward: "ER STAT Lab" },
    Reception: { name: "Devon Carter", role: "Reception", roleLabel: "Admissions / Reception", facility: "City General Infirmary", ward: "ER Registration" },
  },
  "County Health Pavilion": {
    RN: { name: "Jordan Lee, RN", role: "RN", roleLabel: "Registered Nurse", facility: "County Health Pavilion", ward: "Med-Surg Float" },
    MD: { name: "Dr. Arjun Mehta", role: "MD", roleLabel: "Attending Physician", facility: "County Health Pavilion", ward: "Hospitalist Service" },
    PharmD: { name: "Fatima Al-Sayed, PharmD", role: "PharmD", roleLabel: "Clinical Pharmacist", facility: "County Health Pavilion", ward: "Inpatient Pharmacy" },
    Finance: { name: "Monica Schaeffer, MBA", role: "Finance", roleLabel: "Corporate Finance & Accounts", facility: "County Health Pavilion", ward: "Patient Accounts" },
    Admin: { name: "Marcus Hadley", role: "Admin", roleLabel: "Unit Administrator", facility: "County Health Pavilion", ward: "Operations" },
    Lab: { name: "James Carter, CLT", role: "Lab", roleLabel: "Laboratory Technician", facility: "County Health Pavilion", ward: "Diagnostic Lab" },
    Reception: { name: "Aisha Bennett", role: "Reception", roleLabel: "Admissions / Reception", facility: "County Health Pavilion", ward: "Patient Access Office" },
  },
  "Srik Health Clinic": {
    RN: { name: "Priya Shah, RN", role: "RN", roleLabel: "Registered Nurse", facility: "Srik Health Clinic", ward: "Pediatrics - Wing C" },
    MD: { name: "Dr. William Bradshaw", role: "MD", roleLabel: "Attending Physician", facility: "Srik Health Clinic", ward: "Pediatrics" },
    PharmD: { name: "Xavier Dupont, PharmD", role: "PharmD", roleLabel: "Clinical Pharmacist", facility: "Srik Health Clinic", ward: "Pediatric Pharmacy" },
    Finance: { name: "Kenji Aoyama, CPA", role: "Finance", roleLabel: "Corporate Finance & Accounts", facility: "Srik Health Clinic", ward: "Revenue Cycle Office" },
    Admin: { name: "Olivia Sterling", role: "Admin", roleLabel: "Unit Administrator", facility: "Srik Health Clinic", ward: "Operations" },
    Lab: { name: "Nisha Patel, CLT", role: "Lab", roleLabel: "Laboratory Technician", facility: "Srik Health Clinic", ward: "Pediatric Lab" },
    Reception: { name: "Theo Nakamura", role: "Reception", roleLabel: "Admissions / Reception", facility: "Srik Health Clinic", ward: "Clinic Reception" },
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
  "Srik Health Clinic": {
    name: "Priya Shah, RN",
    facility: "Srik Health Clinic",
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
const ROLE_STORAGE_KEY = "spehr.activeRole";

interface FacilityContextValue {
  facility: Facility;
  setFacility: (f: Facility) => void;
  activeRole: StaffRole;
  setActiveRole: (r: StaffRole) => void;
}

const FacilityContext = createContext<FacilityContextValue | null>(null);

export function FacilityProvider({ children }: { children: ReactNode }) {
  const [facility, setFacilityState] = useState<Facility>("Memorial Hospital");
  const [activeRole, setActiveRoleState] = useState<StaffRole>("RN");

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored && (FACILITIES as readonly string[]).includes(stored)) {
        setFacilityState(stored as Facility);
      }
      const r = localStorage.getItem(ROLE_STORAGE_KEY);
      if (r && ["RN", "MD", "PharmD", "Finance", "Admin", "Lab", "Reception"].includes(r)) {
        setActiveRoleState(r as StaffRole);
      }
    } catch {}
  }, []);

  const setFacility = (f: Facility) => {
    setFacilityState(f);
    try {
      localStorage.setItem(STORAGE_KEY, f);
    } catch {}
  };

  const setActiveRole = (r: StaffRole) => {
    setActiveRoleState(r);
    try {
      localStorage.setItem(ROLE_STORAGE_KEY, r);
    } catch {}
  };

  return (
    <FacilityContext.Provider value={{ facility, setFacility, activeRole, setActiveRole }}>
      {children}
    </FacilityContext.Provider>
  );
}

export function useFacility(): FacilityContextValue {
  const ctx = useContext(FacilityContext);
  if (!ctx) {
    // Safe fallback so components outside provider still render.
    return { facility: "Memorial Hospital", setFacility: () => {}, activeRole: "RN", setActiveRole: () => {} };
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