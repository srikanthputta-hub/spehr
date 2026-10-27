/**
 * Terminology auto-lookup helpers.
 *
 * Hits public NLM / NIH terminology services so the Add Terminology
 * dialog (and any auto-seeded entry) can resolve a code into a real
 * Display Name + suggested Category + Description without the operator
 * typing them. No API key required.
 */

export type LookupResult = {
  display: string;
  category: string;
  description: string;
};

export const DEFAULT_CATEGORY: Record<string, string> = {
  "ICD-10": "Chief Complaint",
  "SNOMED CT": "Clinical Finding",
  LOINC: "Laboratory",
  RxNorm: "Medication",
  VSAC: "Value Set",
};

const DEFAULT_USAGE: Record<string, (display: string) => string> = {
  "ICD-10": (d) =>
    `ICD-10-CM diagnosis code used for problem list, encounter coding, and claims (${d}).`,
  "SNOMED CT": (d) =>
    `SNOMED CT clinical concept used for structured documentation and decision support (${d}).`,
  LOINC: (d) => `LOINC observation code used by the Lab Board / lab catalog for ${d}.`,
  RxNorm: (d) => `RxNorm clinical drug used by the Pharmacy / medication catalog for ${d}.`,
  VSAC: (d) => `VSAC value set member used for cohort definitions and quality measures (${d}).`,
};

export function defaultUsage(system: string, display: string): string {
  const fn = DEFAULT_USAGE[system];
  return fn ? fn(display) : `${system} concept: ${display}`;
}

async function safeJson(url: string, init?: RequestInit): Promise<unknown | null> {
  try {
    const r = await fetch(url, init);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

/** ICD-10-CM exact code lookup via NLM Clinical Tables. */
async function lookupIcd10(code: string): Promise<LookupResult | null> {
  const q = encodeURIComponent(code.trim());
  const j = await safeJson(
    `https://clinicaltables.nlm.nih.gov/api/icd10cm/v3/search?sf=code&terms=${q}&maxList=5`,
  );
  if (!j || !Array.isArray(j) || !Array.isArray(j[3])) return null;
  const match =
    (j[3] as string[][]).find((row) => row[0]?.toUpperCase() === code.trim().toUpperCase()) ??
    j[3][0];
  if (!match) return null;
  const display = match[1] ?? code;
  return {
    display,
    category: DEFAULT_CATEGORY["ICD-10"],
    description: defaultUsage("ICD-10", display),
  };
}

/** LOINC exact code lookup. */
async function lookupLoinc(code: string): Promise<LookupResult | null> {
  const q = encodeURIComponent(code.trim());
  const j = await safeJson(
    `https://clinicaltables.nlm.nih.gov/api/loinc_items/v3/search?terms=${q}&df=LOINC_NUM,LONG_COMMON_NAME,CLASS&maxList=5`,
  );
  if (!j || !Array.isArray(j) || !Array.isArray(j[3])) return null;
  const match = (j[3] as string[][]).find((row) => row[0] === code.trim()) ?? j[3][0];
  if (!match) return null;
  const display = match[1] ?? code;
  const klass = match[2] ?? "Laboratory";
  return {
    display,
    category: klass || DEFAULT_CATEGORY.LOINC,
    description: defaultUsage("LOINC", display),
  };
}

/** RxNorm RxCUI lookup via RxNav. */
async function lookupRxNorm(code: string): Promise<LookupResult | null> {
  const j = (await safeJson(
    `https://rxnav.nlm.nih.gov/REST/rxcui/${encodeURIComponent(code.trim())}/properties.json`,
  )) as { properties?: { name?: string; tty?: string } } | null;
  const display: string | undefined = j?.properties?.name;
  if (!display) return null;
  const tty: string | undefined = j?.properties?.tty;
  return {
    display,
    category: tty ? `Medication · ${tty}` : DEFAULT_CATEGORY.RxNorm,
    description: defaultUsage("RxNorm", display),
  };
}

/** SNOMED CT concept lookup via NLM clinical tables (problems subset). */
async function lookupSnomed(code: string): Promise<LookupResult | null> {
  const q = encodeURIComponent(code.trim());
  const j = await safeJson(
    `https://clinicaltables.nlm.nih.gov/api/snomedct_problems/v3/search?terms=${q}&maxList=5`,
  );
  if (!j || !Array.isArray(j) || !Array.isArray(j[3])) return null;
  const match = (j[3] as string[][]).find((row) => row[0] === code.trim()) ?? j[3][0];
  if (!match) return null;
  const display = match[1] ?? code;
  return {
    display,
    category: DEFAULT_CATEGORY["SNOMED CT"],
    description: defaultUsage("SNOMED CT", display),
  };
}

/**
 * Resolve a code → {display, category, description} for the given
 * code system. Returns null if no public match is found (operator can
 * still fill the form manually).
 */
export async function lookupTerminology(
  system: string,
  code: string,
): Promise<LookupResult | null> {
  const c = code.trim();
  if (!c) return null;
  switch (system) {
    case "ICD-10":
      return lookupIcd10(c);
    case "LOINC":
      return lookupLoinc(c);
    case "RxNorm":
      return lookupRxNorm(c);
    case "SNOMED CT":
      return lookupSnomed(c);
    default:
      return null;
  }
}

/** Build a FHIR-flavored CodeSystem resource for interoperability export. */
export function toFhirCodeSystem(
  system: string,
  entries: Array<{ code: string; display: string; description: string | null }>,
) {
  const url: Record<string, string> = {
    "ICD-10": "http://hl7.org/fhir/sid/icd-10-cm",
    "SNOMED CT": "http://snomed.info/sct",
    LOINC: "http://loinc.org",
    RxNorm: "http://www.nlm.nih.gov/research/umls/rxnorm",
    VSAC: "http://cts.nlm.nih.gov/fhir/",
  };
  return {
    resourceType: "CodeSystem",
    url: url[system] ?? `urn:spehr:${system.toLowerCase()}`,
    name: system.replace(/[^A-Za-z0-9]/g, ""),
    title: `S.P.E.H.R ${system} Subset`,
    status: "active",
    content: "fragment",
    count: entries.length,
    concept: entries.map((e) => ({
      code: e.code,
      display: e.display,
      definition: e.description ?? undefined,
    })),
  };
}
