/**
 * Auto Terminologist — autonomous VSAC discovery & retrieval pass.
 * --------------------------------------------------------------
 * The "reuse before you create" step a real clinical terminologist does
 * first: when a consumer engine (Safety Alerts, Auto Doc, Auto Admin, or the
 * proactive sweep) files a terminology request because patient data holds a
 * code no published value set covers, look in NLM's Value Set Authority
 * Center for an existing, steward-governed value set that already contains
 * it — and bring that value set in, with provenance, instead of authoring
 * something new.
 *
 * WHAT THIS PASS MAY DO (and nothing else):
 *   1. Search VSAC's catalog (read-only) and retrieve candidate expansions.
 *   2. Grade each against the request's real seed codes, deterministically.
 *   3. Stage the single best match as an INERT DRAFT in `custom_value_sets`
 *      (or, in `preview` mode, as a `ready_to_import` preview on the request).
 *
 * WHAT IT NEVER DOES — the publish gate (unchanged from before this pass):
 *   - It never sets a value set to `review` or `published`. A draft is read
 *     by nothing clinical: every runtime consumer filters on
 *     `status = 'published'`. A human steward reviews the draft in the Value
 *     Set Library and is the only actor who can promote it. A database
 *     trigger (migration 20261127120000) refuses the service-role
 *     credential this pass runs under from moving an auto-staged row to
 *     `review`/`published`, so a bug here still cannot publish.
 *   - It never invents content. Codes, OID, version, timestamps and
 *     publisher are VSAC's verbatim values (see vsac-client.ts); a candidate
 *     whose expansion can't be proven complete is rejected, never trimmed.
 *   - It never stages on a name match alone. A candidate must contain the
 *     request's actual seed codes; name-only hits remain suggestions (the
 *     existing `known_vsac_candidates` callout) for a human to look at.
 *
 * Decoupled from the cycle on purpose: the DB client, the VSAC gateway and
 * the activity-log sink are all injected, so this module imports nothing
 * from `auto-terminologist-cycle.ts` and every rule below is unit-testable
 * with plain fakes.
 */

import {
  buildVsacImportInsert,
  cleanedSearchKeyword,
  isValidVsacOid,
  type MinimalUmlsClient,
  type VsacExpansionResult,
  type VsacImportInsert,
} from "./value-set-registry.ts";
import {
  VsacError,
  type VsacCandidate,
  type VsacErrorKind,
  type VsacGateway,
  type VsacProvenance,
  type VsacRetrieval,
} from "./vsac-client.ts";

/* ------------------------------------------------------------------ */
/*  Tunables                                                            */
/* ------------------------------------------------------------------ */

/** Requests worked per cycle — keeps one 10-minute tick's VSAC traffic small. */
export const DISCOVERY_BATCH_SIZE = 3;
/** Candidate expansions retrieved per request (each costs ≥ 2 HTTP calls). */
export const MAX_RETRIEVALS_PER_REQUEST = 3;
export const SEARCH_RESULT_COUNT = 10;
/** A request that finds no match is retried at most this many times… */
export const MAX_DISCOVERY_ATTEMPTS = 3;
/** …waiting attempts × this long between tries (NLM asks callers to cache 12–24h). */
export const DISCOVERY_COOLDOWN_BASE_MS = 24 * 60 * 60_000;
/** Fraction of a request's seed codes a candidate must contain. */
export const MIN_SEED_COVERAGE = 0.5;
/** A set with no name relevance is only accepted if it's this small. */
export const SMALL_SET_CODES = 250;
/**
 * Wall-clock budget for the whole discovery pass, checked before every VSAC
 * call. The edge function has a hard limit and the rest of the cycle (demand
 * pass, sweeps, watchdog log) runs AFTER discovery, so discovery must never be
 * able to eat it.
 */
export const DISCOVERY_DEADLINE_MS = 40_000;
/** A request whose VSAC calls flaked is skipped for 30 min, doubling up to 6 h. */
export const TRANSIENT_COOLDOWN_BASE_MS = 30 * 60_000;
export const TRANSIENT_COOLDOWN_MAX_MS = 6 * 60 * 60_000;

const ERROR_RELOG_MS = 6 * 60 * 60_000;

export type StageMode = "draft" | "preview" | "off";

/**
 * Parses the `VSAC_AUTO_STAGE_MODE` setting. Writing drafts is an explicit
 * opt-in: unset, empty or unrecognised all mean `preview` (no write to
 * `custom_value_sets`; a human clicks Import Now). Only `draft` stages drafts.
 */
export function parseStageMode(raw: string | null | undefined): StageMode {
  const v = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (v === "draft" || v === "off") return v;
  return "preview";
}

/** Why a pass stopped early: a VSAC condition, or our own wall-clock budget. */
export type StopReason = VsacErrorKind | "deadline";

/* ------------------------------------------------------------------ */
/*  Types                                                               */
/* ------------------------------------------------------------------ */

export type DiscoverySeed = { code: string; display: string; vocabulary: string };

export type DiscoveryRequestRow = {
  id: string;
  requesting_consumer: string | null;
  requested_name: string | null;
  priority: string | null;
  vocabulary: string | null;
  seed_codes: unknown;
  request_type: string | null;
  known_vsac_candidates: unknown;
  occurrence_count: number | null;
  requested_at: string | null;
  vsac_discovery_at: string | null;
  vsac_discovery_attempts: number | null;
  vsac_discovery_result: Record<string, unknown> | null;
};

export type DiscoveryLog = (entry: {
  action: string;
  message: string;
  theme?: string | null;
  value_set_id?: string | null;
  codes_count?: number | null;
  /** Mirror to the shared `terminology_activity_log` bus (Library panel). */
  bus?: boolean;
}) => Promise<void>;

export type VsacDiscoverySummary = {
  skipped?: "no-gateway" | "mode-off";
  scanned: number;
  attempted: number;
  staged: number;
  previewed: number;
  noMatch: number;
  alreadyInLibrary: number;
  /** Staged requests closed because a steward published their draft. */
  reconciledResolved: number;
  /** Staged requests re-opened because a steward deleted their draft. */
  reconciledWithdrawn: number;
  errors: number;
  stopped: StopReason | null;
  apiRequests: number;
};

export type Grade = {
  accepted: boolean;
  reason: string;
  seedTotal: number;
  seedMatched: number;
  coverage: number;
  nameScore: number;
  matched: Array<{ code: string; vocabulary: string }>;
};

type Considered = {
  oid: string;
  name: string | null;
  publisher: string | null;
  total?: number;
  outcome: "accepted" | "rejected" | "error";
  reason: string;
  coverage?: number;
  name_score?: number;
};

/* ------------------------------------------------------------------ */
/*  Pure helpers (exported for tests)                                   */
/* ------------------------------------------------------------------ */

/** Collapses the many spellings of a vocabulary to one comparable family. */
export function vocabFamily(v: string | null | undefined): string {
  const t = String(v ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  if (!t) return "";
  if (t.startsWith("snomed")) return "snomed";
  if (t.startsWith("icd10pcs")) return "icd10pcs";
  if (t.startsWith("icd10")) return "icd10";
  if (t.startsWith("rxnorm")) return "rxnorm";
  if (t.startsWith("loinc") || t === "lnc") return "loinc";
  if (t === "cpt") return "cpt";
  return t;
}

/** Comparable form of a code within its family (ICD-10 ignores the dot). */
export function normalizeCode(family: string, code: string): string {
  const c = String(code ?? "").trim();
  return family === "icd10" || family === "icd10pcs" ? c.toUpperCase().replace(/\./g, "") : c;
}

export function normalizeSeeds(row: {
  seed_codes: unknown;
  vocabulary: string | null;
}): DiscoverySeed[] {
  const raw = Array.isArray(row.seed_codes)
    ? (row.seed_codes as Array<Record<string, unknown>>)
    : [];
  const out: DiscoverySeed[] = [];
  for (const s of raw) {
    const code = String(s?.code ?? "").trim();
    if (!code) continue;
    out.push({
      code,
      display: String(s?.display ?? "").trim(),
      vocabulary: String(s?.vocabulary ?? row.vocabulary ?? "").trim(),
    });
  }
  return out;
}

/**
 * The vocabulary families VSAC can be matched on: exactly the code systems
 * `VSAC_SYSTEM_TO_VOCAB` labels. A seed in anything else (ICD-9, free text, a
 * local code) can never be found in a VSAC expansion, so it is not gradeable.
 */
const GRADEABLE_FAMILIES = new Set(["snomed", "icd10", "loinc", "rxnorm", "cpt"]);

/** Seeds we can actually grade: a code in a vocabulary VSAC is matched on. */
export function gradeableSeeds(seeds: DiscoverySeed[]): DiscoverySeed[] {
  return seeds.filter((s) => s.code && GRADEABLE_FAMILIES.has(vocabFamily(s.vocabulary)));
}

const QUOTED_REQUEST_NAME = /^(?:condition|allergy-class|drug-allergy)\s+coverage\s+for\s+"(.+)"$/i;

/**
 * The keyword(s) to search VSAC's catalog for. The proactive sweep files
 * names like `Condition coverage for "Hypertension"`; searching that whole
 * sentence finds nothing, so the quoted clinical term is extracted. A second
 * term comes from the first seed's own display text (the chart's wording).
 */
export function deriveSearchTerms(row: {
  requested_name: string | null;
  seed_codes: unknown;
  vocabulary: string | null;
}): string[] {
  const name = String(row.requested_name ?? "").trim();
  const terms: string[] = [];
  const quoted = QUOTED_REQUEST_NAME.exec(name);
  terms.push(quoted ? quoted[1].trim() : cleanedSearchKeyword(name));
  const display = normalizeSeeds(row)[0]?.display.trim();
  if (display && !terms.some((t) => t.toLowerCase() === display.toLowerCase())) terms.push(display);
  return terms.filter(Boolean).slice(0, 2);
}

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "without",
  "of",
  "in",
  "on",
  "to",
  "from",
  "due",
  "coverage",
  "condition",
  "allergy",
  "class",
  "drug",
  "value",
  "set",
  "unspecified",
]);

/** Lower-case significant tokens (camelCase split, light plural stemming). */
export function significantTokens(text: string): string[] {
  const spaced = String(text ?? "").replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  const out = new Set<string>();
  for (const raw of spaced.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOPWORDS.has(raw)) continue;
    out.add(raw.length > 3 && raw.endsWith("s") ? raw.slice(0, -1) : raw);
  }
  return [...out];
}

/** Fraction of the request's significant tokens found in a candidate's name/title. */
export function nameScore(termTokens: string[], candidateText: string): number {
  if (termTokens.length === 0) return 0;
  const have = new Set(significantTokens(candidateText));
  return termTokens.filter((t) => have.has(t)).length / termTokens.length;
}

/**
 * Grades a retrieved expansion against the request. Deterministic — no model.
 *
 * Accepted only when: VSAC lists the value set as `active`; the request has
 * gradeable seed codes (a name match alone never qualifies); at least
 * MIN_SEED_COVERAGE of them are present in the expansion (exact code match
 * within a vocabulary family); and the set is either relevant by name or
 * small enough (SMALL_SET_CODES) that being broad isn't a concern. The
 * steward still reviews everything — this only decides what's worth staging.
 */
export function gradeRetrieval(args: {
  seeds: DiscoverySeed[];
  retrieval: Pick<VsacRetrieval, "status" | "codes" | "name" | "title">;
  termTokens: string[];
}): Grade {
  const { seeds, retrieval, termTokens } = args;
  const score = nameScore(termTokens, `${retrieval.name ?? ""} ${retrieval.title ?? ""}`);

  const have = new Set<string>();
  for (const c of retrieval.codes) {
    // An inactive (retired) code in the expansion is not coverage of a live one.
    if (c.inactive) continue;
    const fam = vocabFamily(c.vocabulary);
    if (fam) have.add(`${fam}|${normalizeCode(fam, c.code)}`);
  }
  const gradeable = gradeableSeeds(seeds);
  const matched = gradeable.filter((s) => {
    const fam = vocabFamily(s.vocabulary);
    return have.has(`${fam}|${normalizeCode(fam, s.code)}`);
  });
  const coverage = gradeable.length === 0 ? 0 : matched.length / gradeable.length;
  const base = {
    seedTotal: gradeable.length,
    seedMatched: matched.length,
    coverage,
    nameScore: score,
    matched: matched.map((s) => ({ code: s.code, vocabulary: s.vocabulary })),
  };

  if (retrieval.status !== "active") {
    return {
      ...base,
      accepted: false,
      reason: `VSAC status is '${retrieval.status ?? "unknown"}', not 'active'`,
    };
  }
  if (gradeable.length === 0) {
    return {
      ...base,
      accepted: false,
      reason:
        "request has no gradeable seed codes (name-only matches are suggestions, never auto-staged)",
    };
  }
  if (coverage < MIN_SEED_COVERAGE) {
    return {
      ...base,
      accepted: false,
      reason: `contains ${matched.length}/${gradeable.length} seed code(s), below the ${MIN_SEED_COVERAGE * 100}% floor`,
    };
  }
  if (score === 0 && retrieval.codes.length > SMALL_SET_CODES) {
    return {
      ...base,
      accepted: false,
      reason: `contains the seed code(s) but its name shares nothing with the request and it is large (${retrieval.codes.length} codes)`,
    };
  }
  return {
    ...base,
    accepted: true,
    reason: `contains ${matched.length}/${gradeable.length} seed code(s)`,
  };
}

/** Best-first: coverage, then name relevance, then the smaller (more specific) set, then OID. */
export function rankAccepted<T extends { grade: Grade; total: number; oid: string }>(
  items: T[],
): T[] {
  return [...items].sort(
    (a, b) =>
      b.grade.coverage - a.grade.coverage ||
      b.grade.nameScore - a.grade.nameScore ||
      a.total - b.total ||
      a.oid.localeCompare(b.oid),
  );
}

export function cooldownMs(attempts: number): number {
  return attempts <= 0 ? 0 : attempts * DISCOVERY_COOLDOWN_BASE_MS;
}

/** The provenance record to store: what VSAC sent, plus why/how we staged it. */
export function buildStagedProvenance(
  retrieval: VsacRetrieval,
  ctx: { mode: "draft" | "preview"; requestId: string; grade: Grade },
): VsacProvenance {
  return {
    ...retrieval.provenance,
    staged_by: "auto-terminologist",
    stage_mode: ctx.mode,
    request_id: ctx.requestId,
    match: {
      basis: "seed_overlap",
      seed_total: ctx.grade.seedTotal,
      seed_matched: ctx.grade.seedMatched,
      coverage: ctx.grade.coverage,
      name_score: ctx.grade.nameScore,
      matched_codes: ctx.grade.matched,
    },
  };
}

/** A VSAC retrieval as the `VsacExpansionResult` shape the rest of the app already speaks. */
export function toExpansionResult(
  retrieval: VsacRetrieval,
  provenance: VsacProvenance,
): VsacExpansionResult {
  return {
    oid: retrieval.oid,
    name: retrieval.name,
    title: retrieval.title,
    total: retrieval.total,
    type: retrieval.type,
    codes: retrieval.codes.map((c) => ({
      code: c.code,
      display: c.display,
      vocabulary: c.vocabulary,
    })),
    publisher: retrieval.publisher,
    provenance,
  };
}

/**
 * The `custom_value_sets` row to insert. Built on the same
 * `buildVsacImportInsert` a human "Import from VSAC" uses (so the two paths
 * can't drift), with the description and change history making plain that
 * nobody has reviewed it yet. Always `status: "draft"`.
 */
export function buildAutoStagedDraft(
  retrieval: VsacRetrieval,
  provenance: VsacProvenance,
  nowIso: string,
): VsacImportInsert {
  const name = retrieval.title || retrieval.name || `VSAC ${retrieval.oid}`;
  const base = buildVsacImportInsert(toExpansionResult(retrieval, provenance), name);
  const p = provenance;
  return {
    ...base,
    // The shared import builder drops VSAC's per-code `inactive` flag; keep it
    // (only where true, so active codes keep their usual three-key shape) so a
    // steward can see which codes VSAC marks inactive. Same order as `base.codes`.
    codes: retrieval.codes.map((c) => ({
      code: c.code,
      display: c.display,
      system: c.vocabulary,
      ...(c.inactive ? { inactive: true } : {}),
    })),
    status: "draft",
    // Deliberately a statement of origin, not of state: this text outlives the
    // draft stage and must not claim "unreviewed" on a value set a steward has
    // since published. Review state is the row's `status` and `change_history`.
    description:
      "Retrieved automatically from NLM VSAC by the Auto Terminologist to cover a terminology " +
      "request; the retrieval record (OID, VSAC version, timestamps, content hash) is in this " +
      "value set's provenance. Review it against the request before publishing.",
    change_history: [
      {
        at: nowIso,
        actor: "Auto Terminologist",
        change:
          `Retrieved from VSAC (OID ${retrieval.oid}, version ${p.vsac_version ?? "not reported"}, ` +
          `${retrieval.codes.length} codes, content sha256 ${p.content_sha256.slice(0, 12)}…) to cover ` +
          `request ${p.request_id ?? "n/a"} (${p.match?.seed_matched ?? 0}/${p.match?.seed_total ?? 0} seed codes present). ` +
          `Staged as DRAFT — awaiting steward review and publish.`,
      },
    ],
  };
}

/* ------------------------------------------------------------------ */
/*  The pass                                                            */
/* ------------------------------------------------------------------ */

const STOP_KINDS = new Set<VsacErrorKind>([
  "auth",
  "rate_limited",
  "circuit_open",
  "budget_exhausted",
]);

const lastErrorLoggedAt = new Map<string, number>();

function timeLabel(): string {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function priorityRank(p: string | null | undefined): number {
  const v = String(p ?? "normal").toLowerCase();
  return v === "urgent" ? 0 : v === "high" ? 1 : v === "low" ? 3 : 2;
}

const REQUEST_COLUMNS =
  "id, requesting_consumer, requested_name, priority, vocabulary, seed_codes, request_type, known_vsac_candidates, occurrence_count, requested_at, vsac_discovery_at, vsac_discovery_attempts, vsac_discovery_result";

/** Cooldown after `count` consecutive flaky (transient-only) attempts on one request. */
export function transientCooldownMs(count: number): number {
  if (!(count > 0)) return 0;
  return Math.min(TRANSIENT_COOLDOWN_MAX_MS, TRANSIENT_COOLDOWN_BASE_MS * 2 ** (count - 1));
}

function transientState(result: unknown): { count: number; at: number } | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  if (r.outcome !== "transient_error" || typeof r.at !== "string") return null;
  const at = Date.parse(r.at);
  if (!Number.isFinite(at)) return null;
  return { count: Number(r.transient_count) || 1, at };
}

function candidatesFromKnown(raw: unknown): VsacCandidate[] {
  if (!Array.isArray(raw)) return [];
  const out: VsacCandidate[] = [];
  for (const c of raw as Array<Record<string, unknown>>) {
    const oid = String(c?.oid ?? "").trim();
    if (!oid) continue;
    out.push({
      oid,
      name: (c.name as string) ?? null,
      title: (c.title as string) ?? null,
      publisher: (c.publisher as string) ?? null,
      // `known_vsac_candidates` only ever stores VSAC-`active` entries.
      status: "active",
      version: null,
    });
  }
  return out;
}

/**
 * Closes the loop on requests the pass staged (`status = 'vsac_staged'`), so
 * the steward's ONLY action is reviewing + publishing the draft:
 *
 *  - the draft is now `published`  → the request is `resolved` (it did its job);
 *  - the draft no longer exists    → a steward deleted it, i.e. rejected the
 *    staging. The request goes back to `pending` for a human with its attempt
 *    counter maxed, so discovery will NOT silently re-stage the same set in a
 *    loop. (This is the only way a deleted draft could ever come back.)
 *  - anything else (draft/review/…) → untouched, still waiting on the steward.
 *
 * Writes `terminology_requests` only — never `custom_value_sets`.
 */
export async function reconcileStagedRequests(
  client: MinimalUmlsClient,
  log: DiscoveryLog,
  now: () => number,
): Promise<{ resolved: number; withdrawn: number }> {
  const out = { resolved: 0, withdrawn: 0 };
  const { data: staged, error } = await client
    .from("terminology_requests")
    .select("id, requested_name, value_set_id, vsac_discovery_result")
    .eq("status", "vsac_staged");
  if (error || !Array.isArray(staged) || staged.length === 0) return out;

  type StagedRow = {
    id: string;
    requested_name: string | null;
    value_set_id: string | null;
    vsac_discovery_result: Record<string, unknown> | null;
  };
  const rows = staged as StagedRow[];
  const ids = [...new Set(rows.map((r) => r.value_set_id).filter((v): v is string => !!v))];
  const { data: sets, error: setsErr } = ids.length
    ? await client.from("custom_value_sets").select("id, name, status").in("id", ids)
    : { data: [], error: null };
  // Can't see the library → can't tell "deleted" from "unreadable": do nothing.
  if (setsErr || !Array.isArray(sets)) return out;
  const byId = new Map<string, { id: string; name: string; status: string }>(
    (sets as Array<{ id: string; name: string; status: string }>).map((v) => [v.id, v]),
  );

  const nowIso = new Date(now()).toISOString();
  for (const r of rows) {
    const name = String(r.requested_name ?? "").trim();
    const vs = r.value_set_id ? byId.get(r.value_set_id) : undefined;

    if (vs && vs.status === "published") {
      const { data: changed, error: upErr } = await client
        .from("terminology_requests")
        .update({
          status: "resolved",
          resolved_at: nowIso,
          updated_at: nowIso,
          quality_gate_notes: null,
        })
        .eq("id", r.id)
        .eq("status", "vsac_staged")
        .select("id");
      // Matched nothing (another runner got there first) → not ours to count or log.
      if (upErr || !Array.isArray(changed) || changed.length === 0) continue;
      out.resolved += 1;
      await log({
        action: "vsac_staged_resolved",
        message: `${timeLabel()} — Request '${name}' resolved: a steward published the auto-staged VSAC value set '${vs.name}'.`,
        theme: name || null,
        value_set_id: vs.id,
        bus: true,
      });
    } else if (!vs) {
      const withdrawnResult = {
        ...(r.vsac_discovery_result ?? {}),
        outcome: "withdrawn",
        withdrawn_at: nowIso,
      };
      const reopen = {
        status: "pending",
        value_set_id: null,
        vsac_discovery_at: nowIso,
        vsac_discovery_attempts: MAX_DISCOVERY_ATTEMPTS,
        vsac_discovery_result: withdrawnResult,
        quality_gate_notes:
          "The auto-staged VSAC draft for this request was deleted by a steward, so it will not be staged again automatically. Handle this request manually.",
        updated_at: nowIso,
      };
      let { data: changed, error: upErr } = await client
        .from("terminology_requests")
        .update(reopen)
        .eq("id", r.id)
        .eq("status", "vsac_staged")
        .select("id");
      let supersededBy = false;
      if (upErr && (upErr as { code?: string }).code === "23505") {
        // While this request sat in 'vsac_staged' the demand engines were free to file a NEW
        // pending request for the same gap (the dedup index only covers 'pending'). Re-opening
        // this one would collide with it, so close this one instead; the newer request carries
        // on, and `stewardRejectedOids` still sees this row's withdrawn OID so it is not re-proposed.
        supersededBy = true;
        ({ data: changed, error: upErr } = await client
          .from("terminology_requests")
          .update({
            status: "rejected",
            value_set_id: null,
            vsac_discovery_result: withdrawnResult,
            quality_gate_notes:
              "The auto-staged VSAC draft was deleted by a steward, and a newer pending request for the same gap already exists — closed in its favour.",
            updated_at: nowIso,
          })
          .eq("id", r.id)
          .eq("status", "vsac_staged")
          .select("id"));
      }
      // Matched nothing (another runner got there first) → not ours to count or log.
      if (upErr || !Array.isArray(changed) || changed.length === 0) continue;
      out.withdrawn += 1;
      await log({
        action: "vsac_stage_withdrawn",
        message: supersededBy
          ? `${timeLabel()} — The auto-staged VSAC draft for '${name}' was deleted by a steward; a newer pending request for the same gap exists, so this one was closed in its favour.`
          : `${timeLabel()} — The auto-staged VSAC draft for '${name}' was deleted by a steward; the request is back in the queue for manual handling and will not be re-staged.`,
        theme: name || null,
      });
    }
  }
  return out;
}

type PassCtx = {
  opts: { mode: StageMode; log: DiscoveryLog };
  summary: VsacDiscoverySummary;
  now: () => number;
  timeUp: () => boolean;
  logOnce: (key: string, entry: Parameters<DiscoveryLog>[0]) => Promise<void>;
  /** Set once VSAC refuses the catalog search itself (not a flake) — stop issuing searches this pass. */
  searchBroken: { kind: VsacErrorKind; message: string } | null;
};

function isEligible(r: DiscoveryRequestRow, now: () => number): boolean {
  const type = String(r.request_type ?? "create").toLowerCase();
  if (type !== "create") return false;
  if (gradeableSeeds(normalizeSeeds(r)).length === 0) return false;
  const attempts = Number(r.vsac_discovery_attempts ?? 0);
  if (attempts >= MAX_DISCOVERY_ATTEMPTS) return false;
  // A request whose VSAC calls flaked sits out a cooling-off period, so one
  // flaky value set can't keep winning the queue head and starve the rest.
  const tr = transientState(r.vsac_discovery_result);
  if (tr && now() - tr.at < transientCooldownMs(tr.count)) return false;
  const last = r.vsac_discovery_at ? new Date(r.vsac_discovery_at).getTime() : 0;
  return !last || now() - last >= cooldownMs(attempts);
}

export async function runVsacDiscoveryPass(
  client: MinimalUmlsClient,
  gateway: VsacGateway | null | undefined,
  opts: {
    mode: StageMode;
    log: DiscoveryLog;
    now?: () => number;
    batchSize?: number;
    deadlineMs?: number;
  },
): Promise<VsacDiscoverySummary> {
  const summary: VsacDiscoverySummary = {
    scanned: 0,
    attempted: 0,
    staged: 0,
    previewed: 0,
    noMatch: 0,
    alreadyInLibrary: 0,
    reconciledResolved: 0,
    reconciledWithdrawn: 0,
    errors: 0,
    stopped: null,
    apiRequests: 0,
  };
  const now = opts.now ?? (() => Date.now());
  const startedAt = now();
  const deadlineMs = opts.deadlineMs ?? DISCOVERY_DEADLINE_MS;
  const timeUp = () => now() - startedAt >= deadlineMs;

  // Housekeeping first, and regardless of mode / credentials: it touches no
  // VSAC API and no value set, only closes the loop on drafts already staged.
  try {
    const rec = await reconcileStagedRequests(client, opts.log, now);
    summary.reconciledResolved = rec.resolved;
    summary.reconciledWithdrawn = rec.withdrawn;
  } catch (e) {
    summary.errors += 1;
    console.warn("[auto-term] vsac staged-request reconcile failed", e);
  }

  if (opts.mode === "off") return { ...summary, skipped: "mode-off" };
  if (!gateway) return { ...summary, skipped: "no-gateway" };

  const finish = (): VsacDiscoverySummary => {
    summary.apiRequests = gateway.stats().requests;
    return summary;
  };

  const logOnce = async (key: string, entry: Parameters<DiscoveryLog>[0]) => {
    const last = lastErrorLoggedAt.get(key) ?? 0;
    if (now() - last < ERROR_RELOG_MS) return;
    lastErrorLoggedAt.set(key, now());
    await opts.log(entry);
  };
  const ctx: PassCtx = { opts, summary, now, timeUp, logOnce, searchBroken: null };

  try {
    const { data, error } = await client
      .from("terminology_requests")
      .select(REQUEST_COLUMNS)
      .eq("status", "pending")
      .is("linked_vsac_oid", null);
    if (error || !Array.isArray(data)) {
      summary.errors += 1;
      await logOnce("select", {
        action: "vsac_error",
        message: `${timeLabel()} — VSAC discovery could not read the request queue (${error?.message ?? "no data"}). If this persists, the 20261127120000 migration has probably not been applied.`,
      });
      return finish();
    }

    const rows = (data as DiscoveryRequestRow[]).filter((r) => isEligible(r, now));
    summary.scanned = rows.length;

    rows.sort(
      (a, b) =>
        priorityRank(a.priority) - priorityRank(b.priority) ||
        Number(b.occurrence_count ?? 1) - Number(a.occurrence_count ?? 1) ||
        String(a.requested_at ?? "").localeCompare(String(b.requested_at ?? "")),
    );

    for (const row of rows.slice(0, opts.batchSize ?? DISCOVERY_BATCH_SIZE)) {
      let stop: StopReason | null = null;
      if (timeUp()) {
        stop = "deadline";
      } else {
        summary.attempted += 1;
        try {
          stop = await processRequest(client, gateway, row, ctx);
        } catch (e) {
          summary.errors += 1;
          console.warn("[auto-term] vsac discovery failed for request", row.id, e);
        }
      }
      if (stop) {
        summary.stopped = stop;
        await logOnce(`stop:${stop}`, {
          action: "vsac_error",
          message: `${timeLabel()} — VSAC discovery paused for this cycle: ${describeStop(stop)}. Requests not yet given a verdict were left untouched and will be retried next cycle.`,
        });
        break;
      }
    }
  } catch (e) {
    summary.errors += 1;
    console.warn("[auto-term] vsac discovery pass crashed", e);
  }
  return finish();
}

function describeStop(kind: StopReason): string {
  switch (kind) {
    case "deadline":
      return `the ${DISCOVERY_DEADLINE_MS / 1000}s time budget for VSAC discovery is spent`;
    case "auth":
      return "VSAC rejected the UMLS API key (401/403) — check UMLS_API_KEY and that the key's UMLS licence covers VSAC";
    case "rate_limited":
      return "VSAC rate limit reached (HTTP 429)";
    case "budget_exhausted":
      return "this cycle's VSAC request budget is spent";
    default:
      return "VSAC calls were halted after repeated failures";
  }
}

/** OIDs a steward has already deleted as the staged answer to THIS request (consumer + name). */
async function stewardRejectedOids(
  client: MinimalUmlsClient,
  row: DiscoveryRequestRow,
): Promise<Set<string>> {
  const out = new Set<string>();
  const { data, error } = await client
    .from("terminology_requests")
    .select("vsac_discovery_result")
    .eq("requesting_consumer", row.requesting_consumer)
    .eq("requested_name", row.requested_name)
    .not("vsac_discovery_result", "is", null);
  if (error || !Array.isArray(data)) return out;
  for (const r of data as Array<{ vsac_discovery_result: Record<string, unknown> | null }>) {
    const res = r.vsac_discovery_result;
    if (res && res.outcome === "withdrawn" && typeof res.chosen_oid === "string") {
      out.add(res.chosen_oid);
    }
  }
  return out;
}

type LibraryHit = { id: string; name: string; status: string; oid: string };

async function libraryRowsByOid(
  client: MinimalUmlsClient,
  oids: string[],
): Promise<Map<string, LibraryHit>> {
  const out = new Map<string, LibraryHit>();
  if (oids.length === 0) return out;
  const { data, error } = await client
    .from("custom_value_sets")
    .select("id, name, status, oid")
    .in("oid", oids);
  if (error || !Array.isArray(data)) return out; // stage() re-checks before any insert
  for (const r of data as LibraryHit[]) if (r.oid && !out.has(r.oid)) out.set(r.oid, r);
  return out;
}

/** Plain-language account of what happened to each candidate, built from the real outcomes. */
function describeOutcomes(considered: Considered[]): string {
  if (considered.length === 0) return "no active candidate value set was found in VSAC";
  const rejected = considered.filter((c) => c.outcome === "rejected").length;
  const errored = considered.filter((c) => c.outcome === "error");
  const parts = [`${considered.length} candidate(s) checked`];
  if (rejected) parts.push(`${rejected} did not pass grading`);
  if (errored.length) {
    const kinds = [...new Set(errored.map((c) => c.reason.split(":")[0]))].join(", ");
    parts.push(`${errored.length} could not be verified (${kinds})`);
  }
  return parts.join(", ");
}

/** Returns a stop reason when the whole pass must halt; otherwise null. */
async function processRequest(
  client: MinimalUmlsClient,
  gateway: VsacGateway,
  row: DiscoveryRequestRow,
  ctx: PassCtx,
): Promise<StopReason | null> {
  const { opts, summary, now } = ctx;
  const requestedName = String(row.requested_name ?? "").trim();
  const seeds = normalizeSeeds(row);
  const terms = deriveSearchTerms(row);
  const termTokens = [...new Set(terms.flatMap(significantTokens))];
  const considered: Considered[] = [];
  const attempts = Number(row.vsac_discovery_attempts ?? 0);
  let sawTransient = false;
  let stopReason: StopReason | null = null;

  /**
   * VSAC flaked while we worked this request. That says nothing about whether a
   * match exists, so it is NOT a verdict and costs no attempt — but the request
   * is parked for a while so it cannot keep re-winning the head of the queue.
   */
  const markTransient = async () => {
    summary.errors += 1;
    const count = (transientState(row.vsac_discovery_result)?.count ?? 0) + 1;
    const nowIso = new Date(now()).toISOString();
    await client
      .from("terminology_requests")
      .update({
        vsac_discovery_result: {
          at: nowIso,
          outcome: "transient_error",
          transient_count: count,
          mode: opts.mode,
          search_terms: terms,
          considered,
          retry_after_minutes: Math.round(transientCooldownMs(count) / 60_000),
        },
        updated_at: nowIso,
      })
      .eq("id", row.id)
      .eq("status", "pending");
    await ctx.logOnce(`transient:${row.id}`, {
      action: "vsac_error",
      message: `${timeLabel()} — VSAC was unreachable or erroring while working on '${requestedName}'. No verdict was recorded and no attempt was used; this request will be retried in about ${Math.round(transientCooldownMs(count) / 60_000)} min.`,
      theme: requestedName,
    });
  };

  /* ---- 1. candidates: the ones filed with the request, else a catalog search ---- */
  const usable = (c: VsacCandidate) =>
    c.status === "active" && !!c.publisher && isValidVsacOid(c.oid);
  let candidates = candidatesFromKnown(row.known_vsac_candidates).filter(usable);
  let searched = false;
  if (candidates.length === 0) {
    // VSAC has already refused the search this pass: don't hammer it, don't penalise the request.
    if (ctx.searchBroken) return null;
    searched = true;
    const byOid = new Map<string, VsacCandidate>();
    for (const term of terms) {
      if (ctx.timeUp()) return "deadline";
      try {
        for (const c of await gateway.search(term, SEARCH_RESULT_COUNT)) byOid.set(c.oid, c);
      } catch (e) {
        const kind = e instanceof VsacError ? e.kind : "transient";
        if (STOP_KINDS.has(kind)) {
          if (kind === "circuit_open" && sawTransient) await markTransient();
          return kind;
        }
        if (kind === "transient") {
          sawTransient = true;
          break;
        }
        // VSAC refused the search request itself (bad_request / malformed / …):
        // that will repeat for every request, so say so once and stop searching.
        ctx.searchBroken = { kind, message: (e as Error)?.message ?? "search rejected" };
        summary.errors += 1;
        const nowIso = new Date(now()).toISOString();
        await client
          .from("terminology_requests")
          .update({
            vsac_discovery_at: nowIso,
            vsac_discovery_attempts: attempts + 1,
            vsac_discovery_result: {
              at: nowIso,
              outcome: "search_error",
              error_kind: kind,
              search_terms: terms,
              mode: opts.mode,
            },
            updated_at: nowIso,
          })
          .eq("id", row.id)
          .eq("status", "pending");
        await ctx.logOnce(`search:${kind}`, {
          action: "vsac_error",
          message: `${timeLabel()} — VSAC refused the catalog search (${ctx.searchBroken.message}). Searches are paused for this cycle; requests that already carry known VSAC candidates are unaffected. If this persists the search modifier this client uses may be unsupported by VSAC — see docs/auto-terminologist-vsac-retrieval-design.md.`,
        });
        return null;
      }
    }
    candidates = [...byOid.values()].filter(usable);
    if (candidates.length === 0 && sawTransient) {
      await markTransient();
      return null;
    }
  }

  /* ---- 2. drop what a steward already rejected, and what the library already holds ---- */
  const rejectedOids = await stewardRejectedOids(client, row);
  const inLibrary = await libraryRowsByOid(
    client,
    candidates.map((c) => c.oid),
  );
  const libraryHits: LibraryHit[] = [];
  candidates = candidates.filter((c) => {
    if (rejectedOids.has(c.oid)) {
      considered.push({
        oid: c.oid,
        name: c.title ?? c.name,
        publisher: c.publisher,
        outcome: "rejected",
        reason:
          "a steward previously deleted this exact value set as the answer to this request — not proposed again",
      });
      return false;
    }
    const hit = inLibrary.get(c.oid);
    if (hit) {
      libraryHits.push(hit);
      considered.push({
        oid: c.oid,
        name: c.title ?? c.name,
        publisher: c.publisher,
        outcome: "rejected",
        reason: `already in the library as "${hit.name}" (${hit.status})`,
      });
      return false;
    }
    return true;
  });

  /* ---- 3. retrieve and grade the most promising — ALL of them, then choose ---- */
  const ranked = candidates
    .map((c) => ({ c, s: nameScore(termTokens, `${c.name ?? ""} ${c.title ?? ""}`) }))
    .sort((a, b) => b.s - a.s || a.c.oid.localeCompare(b.c.oid))
    .slice(0, MAX_RETRIEVALS_PER_REQUEST);

  const accepted: Array<{ retrieval: VsacRetrieval; grade: Grade; total: number; oid: string }> =
    [];
  for (const { c } of ranked) {
    if (ctx.timeUp()) {
      stopReason = "deadline";
      break;
    }
    let retrieval: VsacRetrieval;
    try {
      retrieval = await gateway.retrieve(c.oid);
    } catch (e) {
      const kind = e instanceof VsacError ? e.kind : "transient";
      if (STOP_KINDS.has(kind)) {
        stopReason = kind;
        break;
      }
      considered.push({
        oid: c.oid,
        name: c.title ?? c.name,
        publisher: c.publisher,
        outcome: "error",
        reason: `${kind}: ${(e as Error)?.message ?? "retrieval failed"}`,
      });
      // not_found / too_large / incomplete / malformed / bad_request are verdicts on THIS
      // candidate; only a transient failure says nothing about whether it would match.
      if (kind === "transient") sawTransient = true;
      continue;
    }
    const grade = gradeRetrieval({ seeds, retrieval, termTokens });
    considered.push({
      oid: c.oid,
      name: retrieval.title ?? retrieval.name,
      publisher: retrieval.publisher,
      total: retrieval.total,
      outcome: grade.accepted ? "accepted" : "rejected",
      reason: grade.reason,
      coverage: grade.coverage,
      name_score: grade.nameScore,
    });
    if (grade.accepted) {
      accepted.push({ retrieval, grade, total: retrieval.total, oid: c.oid });
    }
  }

  /* ---- 4. decide ---- */
  const nowIso = new Date(now()).toISOString();
  const resultBase = {
    at: nowIso,
    search_terms: terms,
    source_of_candidates: searched ? "catalog_search" : "known_vsac_candidates",
    considered,
    api_requests_used: gateway.stats().requests,
  };

  if (accepted.length === 0) {
    // A circuit that opened because THIS request's candidates kept failing is this request's
    // problem to cool off; any other halt (auth, rate limit, budget, time) is not.
    if (sawTransient) {
      await markTransient();
      return stopReason;
    }
    if (stopReason) return stopReason; // halted before a verdict — leave it for next cycle
    if (candidates.length === 0 && libraryHits.length > 0) {
      await parkAlreadyInLibrary(
        client,
        row,
        libraryHits[0],
        libraryHits[0].oid,
        resultBase,
        opts,
        summary,
        nowIso,
      );
      return null;
    }
    summary.noMatch += 1;
    await client
      .from("terminology_requests")
      .update({
        vsac_discovery_at: nowIso,
        vsac_discovery_attempts: attempts + 1,
        vsac_discovery_result: { ...resultBase, outcome: "no_match", mode: opts.mode },
        updated_at: nowIso,
      })
      .eq("id", row.id)
      .eq("status", "pending");
    await opts.log({
      action: "vsac_no_match",
      message: `${timeLabel()} — VSAC discovery for '${requestedName}' staged nothing: ${describeOutcomes(considered)} (attempt ${attempts + 1}/${MAX_DISCOVERY_ATTEMPTS}). The request continues through the normal UMLS/authoring path.`,
      theme: requestedName,
    });
    return null;
  }

  const best = rankAccepted(accepted)[0];
  await stage(
    client,
    row,
    best.retrieval,
    best.grade,
    { ...resultBase },
    opts,
    summary,
    nowIso,
    attempts,
  );
  return stopReason;
}

/** Notes on the request that the OID already exists in the library, and stops retrying. */
async function parkAlreadyInLibrary(
  client: MinimalUmlsClient,
  row: DiscoveryRequestRow,
  dup: { id: string; name: string; status: string },
  oid: string,
  resultBase: Record<string, unknown>,
  opts: { log: DiscoveryLog },
  summary: VsacDiscoverySummary,
  nowIso: string,
): Promise<void> {
  const requestedName = String(row.requested_name ?? "").trim();
  summary.alreadyInLibrary += 1;
  await client
    .from("terminology_requests")
    .update({
      vsac_discovery_at: nowIso,
      vsac_discovery_attempts: MAX_DISCOVERY_ATTEMPTS,
      vsac_discovery_result: {
        ...resultBase,
        outcome: "already_in_library",
        chosen_oid: oid,
        existing_value_set_id: dup.id,
        existing_status: dup.status,
      },
      quality_gate_notes: `VSAC value set ${oid} already exists in the library as "${dup.name}" (${dup.status}) — review/publish that one instead of staging a duplicate.`,
      updated_at: nowIso,
    })
    .eq("id", row.id)
    .eq("status", "pending");
  await opts.log({
    action: "vsac_already_in_library",
    message: `${timeLabel()} — VSAC value set ${oid} would cover '${requestedName}' but the library already has it as "${dup.name}" (${dup.status}) — noted on the request; nothing staged.`,
    theme: requestedName,
    value_set_id: dup.id,
  });
}

async function stage(
  client: MinimalUmlsClient,
  row: DiscoveryRequestRow,
  retrieval: VsacRetrieval,
  grade: Grade,
  resultBase: Record<string, unknown>,
  opts: { mode: StageMode; log: DiscoveryLog },
  summary: VsacDiscoverySummary,
  nowIso: string,
  attempts: number,
): Promise<void> {
  const requestedName = String(row.requested_name ?? "").trim();
  const oid = retrieval.oid;

  // Never create a second row for an OID the library already holds.
  const { data: existing, error: existingErr } = await client
    .from("custom_value_sets")
    .select("id, name, status")
    .eq("oid", oid)
    .limit(1);
  if (existingErr) {
    summary.errors += 1;
    return; // can't prove there's no duplicate → don't write anything
  }
  const dup = (existing as Array<{ id: string; name: string; status: string }> | null)?.[0];
  if (dup) {
    await parkAlreadyInLibrary(client, row, dup, oid, resultBase, opts, summary, nowIso);
    return;
  }

  // 'preview' mode, or a draft insert that failed, stages a preview instead.
  let previewReason: string | null = opts.mode === "preview" ? "preview mode" : null;
  if (opts.mode === "draft") {
    const provenance = buildStagedProvenance(retrieval, {
      mode: "draft",
      requestId: row.id,
      grade,
    });
    const draft = buildAutoStagedDraft(retrieval, provenance, nowIso);
    const { data: inserted, error: insErr } = await client
      .from("custom_value_sets")
      .insert(draft)
      .select("id")
      .single();
    const valueSetId = (inserted as { id?: string } | null)?.id;
    if (insErr || !valueSetId) {
      previewReason = `draft insert failed (${insErr?.message ?? "no id returned"})`;
    } else {
      summary.staged += 1;
      const { data: upd, error: updErr } = await client
        .from("terminology_requests")
        .update({
          status: "vsac_staged",
          value_set_id: valueSetId,
          vsac_discovery_at: nowIso,
          vsac_discovery_attempts: attempts,
          vsac_discovery_result: {
            ...resultBase,
            outcome: "staged",
            mode: "draft",
            chosen_oid: oid,
            value_set_id: valueSetId,
          },
          quality_gate_notes: null,
          updated_at: nowIso,
        })
        .eq("id", row.id)
        .eq("status", "pending")
        .select("id");
      if (updErr || (Array.isArray(upd) && upd.length === 0)) {
        summary.errors += 1;
        console.warn(
          "[auto-term] request",
          row.id,
          "left 'pending' while its VSAC draft was staged; draft",
          valueSetId,
          "is orphaned but inert",
        );
      }
      const msg = `${timeLabel()} — Retrieved VSAC value set '${draft.name}' (OID ${oid}, version ${retrieval.provenance.vsac_version ?? "not reported"}, ${retrieval.codes.length} codes, ${retrieval.publisher ?? "publisher not reported"}) covering ${grade.seedMatched}/${grade.seedTotal} seed code(s) for '${requestedName}' — staged as DRAFT with full provenance. Awaiting steward review; NOT published.`;
      await opts.log({
        action: "vsac_auto_staged",
        message: msg,
        theme: requestedName,
        value_set_id: valueSetId,
        codes_count: retrieval.codes.length,
        bus: true,
      });
      return;
    }
  }

  // Preview path (preview mode or fallback): human "Import Now" still applies.
  const provenance = buildStagedProvenance(retrieval, {
    mode: "preview",
    requestId: row.id,
    grade,
  });
  summary.previewed += 1;
  await client
    .from("terminology_requests")
    .update({
      status: "ready_to_import",
      vsac_expansion_preview: toExpansionResult(retrieval, provenance),
      vsac_discovery_at: nowIso,
      vsac_discovery_attempts: attempts,
      vsac_discovery_result: {
        ...resultBase,
        outcome: "previewed",
        mode: "preview",
        reason: previewReason,
        chosen_oid: oid,
      },
      quality_gate_notes: null,
      updated_at: nowIso,
    })
    .eq("id", row.id)
    .eq("status", "pending");
  await opts.log({
    action: "vsac_auto_previewed",
    message: `${timeLabel()} — Retrieved VSAC value set '${retrieval.title ?? retrieval.name ?? oid}' (OID ${oid}, ${retrieval.codes.length} codes) covering ${grade.seedMatched}/${grade.seedTotal} seed code(s) for '${requestedName}' — staged as a preview (${previewReason}); awaiting one-click human import.`,
    theme: requestedName,
    codes_count: retrieval.codes.length,
  });
}
