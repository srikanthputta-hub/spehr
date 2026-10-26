import { supabase } from "@/integrations/supabase/client";
import { detectBanned, type BannedAbbrev } from "@/lib/safety-conflicts";

/**
 * Clinical NLP Engine
 * --------------------
 * Lightweight keyword-extraction engine that maps free-text physician
 * narratives to the active rows in `medical_terminology`. Used by the
 * Smart Admission Intake form and the NLP Audit Logs panel.
 *
 * It is intentionally deterministic (no LLM) so audits are reproducible
 * and run instantly inside the browser. Matching is token-based against
 * each terminology row's `display` string with a small set of clinical
 * aliases for common chief complaints.
 */

export type DictRow = {
  id: string;
  code_system: string;
  code: string;
  display: string;
  category: string | null;
  description: string | null;
};

export type NlpMatch = {
  code_system: string;
  code: string;
  display: string;
  category: string | null;
  description: string | null;
  snippet: string;
  start: number;
  end: number;
};

export type NlpResult = {
  raw: string;
  matches: NlpMatch[];
  annotated: string;
  standardized: string[];
  chiefComplaint: string;
  suggestedDiagnoses: NlpMatch[];
  suggestedLabs: NlpMatch[];
  suggestedMeds: NlpMatch[];
  symptoms: NlpMatch[];
  byCode: Record<string, NlpMatch[]>;
  confidence: number; // 0-100; <95 means a human must approve
  banned: BannedAbbrev[]; // Joint Commission "Do Not Use" hits in the raw text
  streamAOk: boolean; // structured demographics/vitals parsed cleanly without NLP
  expansions: Array<{ short: string; long: string }>; // shorthand decoded by NLP
  dosingHazards: Array<{ token: string; reason: string }>; // 5.0 mg / .5 mg etc.
};

export type NlpAudit = NlpResult & {
  id: string;
  created_at: string;
  mrn?: string | null;
  patient_name?: string | null;
  facility_name?: string | null;
};

const STOP = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "with",
  "of",
  "to",
  "for",
  "is",
  "are",
  "was",
  "were",
  "has",
  "have",
  "had",
  "in",
  "on",
  "at",
  "by",
  "be",
  "pt",
  "patient",
  "hx",
  "c/o",
  "co",
  "presents",
  "arrives",
  "reports",
  "denies",
  "complains",
  "note",
  "noted",
  "mild",
  "severe",
  "acute",
  "chronic",
  "bad",
  "new",
  "old",
  "known",
  "also",
]);

/** Clinical shorthand → canonical expansion. Surfaced in the audit log so
 *  coders can verify the NLP decoded the abbreviation correctly. */
const ABBREV: Array<{ pattern: RegExp; long: string; short: string }> = [
  { pattern: /\bhx\b/i, short: "Hx", long: "history" },
  { pattern: /\bpmh\b/i, short: "PMH", long: "past medical history" },
  { pattern: /\bpsh\b/i, short: "PSH", long: "past surgical history" },
  { pattern: /\bc\/o\b/i, short: "c/o", long: "complains of" },
  { pattern: /\bs\/p\b/i, short: "s/p", long: "status post" },
  { pattern: /\br\/o\b/i, short: "r/o", long: "rule out" },
  { pattern: /\bnpo\b/i, short: "NPO", long: "nothing by mouth" },
  { pattern: /\bprn\b/i, short: "prn", long: "as needed" },
  { pattern: /\bpo\b/i, short: "PO", long: "by mouth" },
  { pattern: /\biv\b/i, short: "IV", long: "intravenous" },
  { pattern: /\bim\b/i, short: "IM", long: "intramuscular" },
  { pattern: /\bsob\b/i, short: "SOB", long: "shortness of breath" },
  { pattern: /\bcp\b/i, short: "CP", long: "chest pain" },
  { pattern: /\bn\/v\b/i, short: "N/V", long: "nausea and vomiting" },
  { pattern: /\bloc\b/i, short: "LOC", long: "loss of consciousness" },
  { pattern: /\bnkda\b/i, short: "NKDA", long: "no known drug allergies" },
  { pattern: /\bnka\b/i, short: "NKA", long: "no known allergies" },
  { pattern: /\bbid\b/i, short: "BID", long: "twice daily" },
  { pattern: /\btid\b/i, short: "TID", long: "three times daily" },
  { pattern: /\bqid\b/i, short: "QID", long: "four times daily" },
  { pattern: /\bqhs\b/i, short: "qhs", long: "at bedtime" },
];

function detectExpansions(text: string): Array<{ short: string; long: string }> {
  if (!text) return [];
  const seen = new Set<string>();
  const out: Array<{ short: string; long: string }> = [];
  for (const a of ABBREV) {
    if (a.pattern.test(text) && !seen.has(a.short)) {
      seen.add(a.short);
      out.push({ short: a.short, long: a.long });
    }
  }
  return out;
}

/** Joint Commission unsafe dosing patterns — trailing zero "5.0 mg" or
 *  naked decimal ".5 mg". Either causes 10× dosing errors when faxed. */
function detectDosingHazards(text: string): Array<{ token: string; reason: string }> {
  if (!text) return [];
  const out: Array<{ token: string; reason: string }> = [];
  const trailing = text.match(/\b\d+\.0+\s*(mg|mcg|ml|g|units?)\b/gi) ?? [];
  for (const t of trailing) {
    out.push({ token: t, reason: "Trailing zero — strike (could be read as 10×)" });
  }
  const naked = text.match(/(^|\s)\.\d+\s*(mg|mcg|ml|g|units?)\b/gi) ?? [];
  for (const n of naked) {
    out.push({ token: n.trim(), reason: "Naked decimal — write a leading 0 (e.g. 0.5 mg)" });
  }
  return out;
}
/** Common chief-complaint aliases → canonical phrase to seed extra matches. */
const ALIASES: Array<{ pattern: RegExp; phrases: string[] }> = [
  {
    pattern: /\b(sob|short(ness)? of breath|dyspnea|difficulty breathing)\b/i,
    phrases: ["dyspnea", "shortness of breath"],
  },
  { pattern: /\b(chest pain|cp|chest pressure|chest discomfort)\b/i, phrases: ["chest pain"] },
  {
    pattern: /\b(htn|hypertensive|high blood pressure)\b/i,
    phrases: ["hypertension", "essential hypertension"],
  },
  {
    pattern: /\b(dm|t2dm|diabetic|diabetes mellitus)\b/i,
    phrases: ["diabetes", "type 2 diabetes"],
  },
  { pattern: /\b(mi|stemi|nstemi|heart attack)\b/i, phrases: ["myocardial infarction"] },
  { pattern: /\b(cva|stroke|tia)\b/i, phrases: ["stroke", "cerebrovascular accident"] },
  { pattern: /\b(uti|urinary infection|dysuria)\b/i, phrases: ["urinary tract infection"] },
  { pattern: /\b(pna|pneumonia|lung infection)\b/i, phrases: ["pneumonia"] },
  { pattern: /\b(sepsis|septic)\b/i, phrases: ["sepsis"] },
  {
    pattern: /\b(chf|heart failure|chf exacerbation)\b/i,
    phrases: ["heart failure", "congestive heart failure"],
  },
  { pattern: /\b(afib|atrial fib(rillation)?)\b/i, phrases: ["atrial fibrillation"] },
  { pattern: /\b(n\/v|nausea|vomiting)\b/i, phrases: ["nausea", "vomiting"] },
  { pattern: /\b(abd(ominal)? pain|stomach pain|belly pain)\b/i, phrases: ["abdominal pain"] },
  { pattern: /\b(fever|febrile|pyrexia)\b/i, phrases: ["fever"] },
  { pattern: /\b(headache|ha|migraine)\b/i, phrases: ["headache"] },
  { pattern: /\b(asthma|wheezing|bronchospasm)\b/i, phrases: ["asthma"] },
  { pattern: /\b(copd|emphysema)\b/i, phrases: ["copd", "chronic obstructive pulmonary disease"] },
];

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s\-/]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP.has(t));
}

function expandNarrative(text: string): string {
  let out = text;
  for (const a of ALIASES) {
    if (a.pattern.test(text)) out += " " + a.phrases.join(" ");
  }
  return out;
}

let cache: { ts: number; rows: DictRow[] } | null = null;
const CACHE_MS = 30_000;

export async function loadDictionary(force = false): Promise<DictRow[]> {
  if (!force && cache && Date.now() - cache.ts < CACHE_MS) return cache.rows;
  const { data, error } = await supabase
    .from("medical_terminology")
    .select("id, code_system, code, display, category, description")
    .limit(2000);
  if (error) throw error;
  cache = { ts: Date.now(), rows: (data ?? []) as DictRow[] };
  return cache.rows;
}

/** Core match: scan narrative for any terminology display string (or its
 *  alias-expanded form) using whole-word substring matching. */
export function extractMatches(narrative: string, dict: DictRow[]): NlpMatch[] {
  const expanded = expandNarrative(narrative);
  const lower = expanded.toLowerCase();
  const seen = new Set<string>();
  const out: NlpMatch[] = [];
  const narrTokens = new Set(tokens(expanded));

  for (const row of dict) {
    const disp = (row.display ?? "").trim();
    if (!disp || disp.length < 3) continue;
    const key = `${row.code_system}|${row.code}`;
    if (seen.has(key)) continue;

    const dispLower = disp.toLowerCase();
    const dispTokens = tokens(disp);
    if (dispTokens.length === 0) continue;

    let start = -1;
    let matchedText = "";
    // Try full-phrase substring match first (most precise)
    const idx = lower.indexOf(dispLower);
    if (idx >= 0) {
      start = idx;
      matchedText = disp;
    } else {
      // Fall back to "all tokens present" match for multi-word displays
      const allPresent = dispTokens.every((t) => narrTokens.has(t));
      if (!allPresent) continue;
      // Locate first token position for snippet
      const first = dispTokens.find((t) => lower.includes(t));
      start = first ? lower.indexOf(first) : 0;
      matchedText = dispTokens.join(" ");
    }

    const end = start + matchedText.length;
    const snipStart = Math.max(0, start - 24);
    const snipEnd = Math.min(expanded.length, end + 24);
    seen.add(key);
    out.push({
      code_system: row.code_system,
      code: row.code,
      display: row.display,
      category: row.category,
      description: row.description,
      snippet: expanded.slice(snipStart, snipEnd).trim(),
      start,
      end,
    });
  }
  // Sort by appearance order in narrative
  out.sort((a, b) => a.start - b.start);
  return out;
}

function buildAnnotated(raw: string, matches: NlpMatch[]): string {
  // Inject inline [SYSTEM:CODE] tags after each matched phrase (first-hit per phrase).
  let out = raw;
  const used = new Set<string>();
  for (const m of matches) {
    const phrase = m.display.split(/\s+/).slice(0, 4).join(" ");
    const re = new RegExp(`(${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "i");
    if (!re.test(out)) continue;
    const tag = ` [${m.code_system}:${m.code}]`;
    const key = `${m.code_system}|${m.code}`;
    if (used.has(key)) continue;
    out = out.replace(re, `$1${tag}`);
    used.add(key);
  }
  return out;
}

export function analyzeNarrative(narrative: string, dict: DictRow[]): NlpResult {
  const raw = narrative.trim();
  const matches = raw ? extractMatches(raw, dict) : [];
  const byCode: Record<string, NlpMatch[]> = {};
  for (const m of matches) {
    (byCode[m.code_system] ||= []).push(m);
  }
  const suggestedDiagnoses = byCode["ICD-10"] ?? [];
  const suggestedLabs = byCode["LOINC"] ?? [];
  const suggestedMeds = byCode["RxNorm"] ?? [];
  const symptoms = byCode["SNOMED CT"] ?? [];

  const chiefComplaint =
    suggestedDiagnoses[0]?.display ??
    symptoms[0]?.display ??
    (raw.split(/[.;\n]/)[0] || raw).trim().slice(0, 120);

  const standardized: string[] = [];
  if (suggestedDiagnoses.length)
    standardized.push(
      `Suspected diagnoses: ${suggestedDiagnoses.map((d) => `${d.display} (${d.code})`).join("; ")}`,
    );
  if (symptoms.length)
    standardized.push(
      `Clinical findings: ${symptoms.map((d) => `${d.display} (${d.code})`).join("; ")}`,
    );
  if (suggestedLabs.length)
    standardized.push(
      `Recommended labs: ${suggestedLabs.map((d) => `${d.display} (LOINC ${d.code})`).join("; ")}`,
    );
  if (suggestedMeds.length)
    standardized.push(
      `Possible medications: ${suggestedMeds.map((d) => `${d.display} (RxNorm ${d.code})`).join("; ")}`,
    );
  if (standardized.length === 0)
    standardized.push("No standardized concepts matched — manual coding required.");

  /* ---- Confidence heuristic ---------------------------------------- */
  // Start at 60 if there is *any* match; add per-system coverage; penalize
  // long narratives with few hits and any banned abbreviation.
  const banned = detectBanned(raw);
  const expansions = detectExpansions(raw);
  const dosingHazards = detectDosingHazards(raw);
  let confidence = 0;
  if (matches.length > 0) {
    confidence =
      60 +
      Math.min(20, matches.length * 4) +
      (suggestedDiagnoses.length ? 8 : 0) +
      (symptoms.length ? 4 : 0) +
      (suggestedLabs.length ? 4 : 0) +
      (suggestedMeds.length ? 4 : 0);
    const wordCount = raw.split(/\s+/).filter(Boolean).length;
    if (wordCount > 30 && matches.length < 3) confidence -= 10;
  }
  confidence -= banned.length * 8;
  confidence -= dosingHazards.length * 10;
  confidence = Math.max(0, Math.min(100, confidence));

  return {
    raw,
    matches,
    annotated: buildAnnotated(raw, matches),
    standardized,
    chiefComplaint,
    suggestedDiagnoses,
    suggestedLabs,
    suggestedMeds,
    symptoms,
    byCode,
    confidence,
    banned,
    streamAOk: true, // structured intake auto-fill (Stream A) runs server-side
    // and is always considered "parsed" when an audit is written.
    expansions,
    dosingHazards,
  };
}

/* ------------------------------------------------------------ */
/* Audit persistence — localStorage so audits survive reloads.   */
/* ------------------------------------------------------------ */
const AUDIT_KEY = "spehr.nlp_audits.v1";
const MAX_AUDITS = 200;

export function loadAudits(): NlpAudit[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(AUDIT_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as NlpAudit[]) : [];
  } catch {
    return [];
  }
}

export function saveAudit(
  result: NlpResult,
  meta: { mrn?: string | null; patient_name?: string | null; facility_name?: string | null } = {},
): NlpAudit {
  const audit: NlpAudit = {
    ...result,
    id: `nlp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    created_at: new Date().toISOString(),
    ...meta,
  };
  if (typeof window !== "undefined") {
    const all = loadAudits();
    all.unshift(audit);
    window.localStorage.setItem(AUDIT_KEY, JSON.stringify(all.slice(0, MAX_AUDITS)));
    window.dispatchEvent(new CustomEvent("spehr:nlp-audit"));
  }
  return audit;
}

export function clearAudits() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(AUDIT_KEY);
  window.dispatchEvent(new CustomEvent("spehr:nlp-audit"));
}
