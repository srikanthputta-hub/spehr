/**
 * Hardcoded ingredient → RxNorm map used by Stream C of the coding pipeline.
 * Consulted BEFORE any UMLS/RxNav call so common drugs never fuzzy-match
 * onto the wrong molecule (e.g. Omeprazole → esomeprazole).
 */

export type RxHit = { code: string; display: string };

// Canonical ingredient → RxCUI
const DRUG_RXNORM: Record<string, RxHit> = {
  omeprazole:    { code: "7646",   display: "Omeprazole" },
  metformin:     { code: "6809",   display: "Metformin" },
  aspirin:       { code: "1191",   display: "Aspirin" },
  atorvastatin:  { code: "83367",  display: "Atorvastatin" },
  lisinopril:    { code: "29046",  display: "Lisinopril" },
  metoprolol:    { code: "41493",  display: "Metoprolol" },
  pantoprazole:  { code: "40790",  display: "Pantoprazole" },
  amoxicillin:   { code: "723",    display: "Amoxicillin" },
  azithromycin:  { code: "18631",  display: "Azithromycin" },
  acetaminophen: { code: "161",    display: "Acetaminophen" },
  ibuprofen:     { code: "5640",   display: "Ibuprofen" },
  amlodipine:    { code: "17767",  display: "Amlodipine" },
  warfarin:      { code: "11289",  display: "Warfarin" },
  furosemide:    { code: "4603",   display: "Furosemide" },
  insulin:       { code: "253182", display: "Insulin" },
};

// Brand / abbreviation → canonical ingredient key above.
const ALIASES: Record<string, string> = {
  asa: "aspirin",
  apap: "acetaminophen",
  tylenol: "acetaminophen",
  advil: "ibuprofen",
  motrin: "ibuprofen",
  lasix: "furosemide",
  norvasc: "amlodipine",
  coumadin: "warfarin",
  zithromax: "azithromycin",
  zestril: "lisinopril",
  prinivil: "lisinopril",
  lipitor: "atorvastatin",
  glucophage: "metformin",
  prilosec: "omeprazole",
  protonix: "pantoprazole",
  lopressor: "metoprolol",
  toprol: "metoprolol",
};

const UNIT_WORDS = new Set([
  "mg","mcg","g","kg","ml","l","iu","units","unit","tab","tabs","cap","caps",
  "po","iv","im","sc","sq","pr","sl","od","bid","tid","qid","qhs","qd","prn",
  "daily","nightly","hourly","hs","stat",
]);

/** Return the leading alphabetic ingredient token from a free-text drug string. */
export function leadingDrugToken(text: string): string {
  const s = String(text ?? "").toLowerCase();
  // Split on whitespace / punctuation, drop numbers, units, route/frequency words.
  const tokens = s.split(/[^a-z]+/).filter(Boolean).filter((t) => !UNIT_WORDS.has(t));
  return tokens[0] ?? "";
}

/** Hardcoded lookup. Returns null when the ingredient isn't in the table. */
export function lookupDrugRxnorm(name: string): RxHit | null {
  const head = leadingDrugToken(name);
  if (!head) return null;
  const canonical = ALIASES[head] ?? head;
  return DRUG_RXNORM[canonical] ?? null;
}