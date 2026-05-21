import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export const FACILITIES = ["Memorial Hospital"] as const;

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
      if (r && ["RN", "MD", "PharmD", "RT", "Admin", "Lab"].includes(r)) {
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