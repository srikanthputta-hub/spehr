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