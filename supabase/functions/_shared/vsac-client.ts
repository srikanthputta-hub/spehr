/**
 * VSAC FHIR Terminology Service client — SHARED, read-only.
 * --------------------------------------------------------------
 * The one place spehr talks to NLM's Value Set Authority Center
 * (`https://cts.nlm.nih.gov/fhir`) for the Auto Terminologist's autonomous
 * discovery/retrieval pass. Used server-side only (the `auto-terminologist-
 * cycle` edge function builds it from the `UMLS_API_KEY` secret and injects
 * it into the shared cycle); the browser never holds the key and never
 * constructs this client.
 *
 * Why a new client when `umls-proxy` already has `vsacExpand`/`vsacSearch`:
 * those were written for a human clicking "Import from VSAC" one OID at a
 * time and have four gaps that matter once a machine runs unattended:
 *   1. No paging — a single un-paged `$expand`, so a large value set can be
 *      silently TRUNCATED and still look like a normal result.
 *   2. No provenance — no value set version, no expansion timestamp, no
 *      retrieval time, no content hash.
 *   3. No rate-limit or error handling — a 429 or a 5xx is treated like
 *      "not found", and nothing backs off.
 *   4. No request budget or circuit breaker — nothing bounds how hard a
 *      scheduled job can hit NLM.
 *
 * Everything this client returns is copied VERBATIM from what VSAC sent.
 * It never infers, defaults, or fills in a field: a value VSAC didn't send is
 * `null`. It also refuses to return an expansion it cannot prove is
 * complete (see `VsacRetrieval.complete`) — a truncated value set that looks
 * whole is worse than no value set.
 *
 * Auth: HTTP Basic, username `apikey`, password = the UMLS API key (the
 * pattern NLM documents for the VSAC FHIR service). The key travels only in
 * the Authorization header — never in a URL — and error messages are built
 * from status codes, never from request URLs or response bodies, so a key
 * can't leak through a thrown error.
 *
 * NLM usage terms this client is built around (see docs/auto-terminologist-
 * vsac-retrieval-design.md): ≤ 20 requests/second per IP (this client
 * self-limits to roughly a tenth of that), cache for 12–24h rather than
 * re-fetching, and a UMLS licence is required (the key's owner is the
 * licensee — one key per person).
 *
 * VERIFIED 2026-11-27 against the live capability statement
 * (`/fhir/metadata`, public, read in Chrome): server `vsac-fhir` 2.26.19,
 * FHIR 4.0.1, security scheme "Basic" (VSAC/UMLS account); ValueSet supports
 * read / vread / search-type; ValueSet search parameters include `name`,
 * `title`, `status`, `publisher`, `version`, `code`, `codesystem`, `keyword`,
 * `identifier`, `reference`, `usage`, `date`, `url`, `_lastUpdated`;
 * ValueSet operations are `expand` and `validate-code` only. The
 * `TerminologyCapabilities` lists 112 code systems — the five URIs in
 * `VSAC_SYSTEM_TO_VOCAB` are all present, unchanged. No rate-limit headers
 * accompany a normal response, so this client does not depend on any.
 *
 * STILL UNVERIFIED (needs an authenticated call; none was made): whether
 * `$expand` honours `offset`/`count`, whether it reports `expansion.total`,
 * and whether the `name:contains` search modifier is accepted — the
 * capability statement advertises no `expansion` block and does not host the
 * `$expand` OperationDefinition. The client is therefore defensive: it
 * detects a server that ignores paging parameters (no new codes on a later
 * page) and one that rejects them (a 400, then an un-paged retry), and it
 * REQUIRES a reported `total` as the only proof of completeness (a short page
 * proves nothing — a server that silently caps its page size looks identical
 * to one that is finished). In every uncertain case it throws `incomplete`
 * rather than returning a possibly-truncated set. Worst case (no total, or
 * paging unsupported AND an expansion larger than one response) is a refusal
 * to stage — never a partial value set.
 *
 * No framework or Deno-global dependency: `fetch`, `crypto.subtle`,
 * `AbortController` and `setTimeout` only, so this loads under Deno (the
 * edge function), Vite (the cycle is re-exported to the browser) and Node
 * (vitest).
 */

export const VSAC_FHIR_BASE = "https://cts.nlm.nih.gov/fhir";

/** The attribution statement NLM's API terms ask applications to carry
 * (https://documentation.uts.nlm.nih.gov/terms-of-service.html), stored with
 * every retrieval. Text only — the terms forbid using NLM's name or logo in
 * conjunction with an application, and this never does. */
export const VSAC_ATTRIBUTION =
  "This product uses publicly available data from the U.S. National Library of Medicine (NLM). " +
  "NLM is not responsible for the product and does not endorse or recommend this or any other product.";

// Same FHIR code-system URI → display-vocabulary labels `umls-proxy`'s
// `vsacExpand` uses, so a value set retrieved here lands in
// `custom_value_sets` with the exact vocabulary labels a human "Import from
// VSAC" produces. A URI not listed is kept as the raw URI (and surfaced in
// provenance `code_systems`), never guessed at.
export const VSAC_SYSTEM_TO_VOCAB: Record<string, string> = {
  "http://snomed.info/sct": "SNOMED CT",
  "http://hl7.org/fhir/sid/icd-10-cm": "ICD-10-CM",
  "http://loinc.org": "LOINC",
  "http://www.nlm.nih.gov/research/umls/rxnorm": "RxNorm",
  "http://www.ama-assn.org/go/cpt": "CPT",
};

/* ------------------------------------------------------------------ */
/*  Types                                                               */
/* ------------------------------------------------------------------ */

export type VsacErrorKind =
  /** 401/403 — key missing/invalid, or the UMLS licence doesn't cover VSAC. Not retried. */
  | "auth"
  /** 404 — no such OID. Permanent for that OID. */
  | "not_found"
  /** 429 and the server's Retry-After exceeded what this client will wait. */
  | "rate_limited"
  /** Network error, timeout, 5xx — retried with backoff, then surfaced. */
  | "transient"
  /** Other 4xx — our request was wrong. Not retried. */
  | "bad_request"
  /** 2xx but the body wasn't the FHIR shape we need. */
  | "malformed"
  /** The expansion could not be PROVEN complete (paging unsupported/stalled,
   * or no total to check against). Never returned as if it were whole. */
  | "incomplete"
  /** The per-instance request budget is spent. */
  | "budget_exhausted"
  /** An earlier fatal error opened the breaker; no further requests are made. */
  | "circuit_open"
  /** The expansion exceeds the configured size ceiling. */
  | "too_large";

export class VsacError extends Error {
  readonly kind: VsacErrorKind;
  readonly status?: number;
  readonly retryAfterMs?: number;
  constructor(
    kind: VsacErrorKind,
    message: string,
    extra: { status?: number; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = "VsacError";
    this.kind = kind;
    this.status = extra.status;
    this.retryAfterMs = extra.retryAfterMs;
  }
}

/** One hit from a catalog keyword search. */
export type VsacCandidate = {
  oid: string;
  name: string | null;
  title: string | null;
  publisher: string | null;
  status: string | null;
  version: string | null;
};

export type VsacCode = {
  code: string;
  display: string;
  /** FHIR code-system URI exactly as VSAC sent it. */
  system: string;
  /** Display label (`VSAC_SYSTEM_TO_VOCAB`), or the raw URI when unmapped. */
  vocabulary: string;
  /** True when VSAC flagged the concept inactive in this expansion. */
  inactive: boolean;
};

/**
 * What the client OBSERVED about a retrieval. Every field is VSAC's own value
 * or `null`; the two fields the client computes itself are `retrieved_at`
 * (our clock) and `content_sha256` (a hash of the codes received).
 *
 * The auto-stage pass extends this with match/stage context before storing it
 * in `custom_value_sets.provenance` (see `VsacProvenance`).
 */
export type VsacObservedProvenance = {
  source: "VSAC";
  api: "NLM VSAC FHIR Terminology Service";
  oid: string;
  /** The ValueSet's own `version`, verbatim. */
  vsac_version: string | null;
  vsac_status: string | null;
  vsac_publisher: string | null;
  /** The ValueSet's `date` (last change), verbatim. */
  vsac_date: string | null;
  vsac_last_updated: string | null;
  vsac_version_id: string | null;
  /** `expansion.timestamp`, verbatim — when VSAC generated this expansion. */
  expansion_timestamp: string | null;
  expansion_identifier: string | null;
  /** `expansion.parameter[]`, verbatim — e.g. which code-system releases the
   * expansion was generated against. */
  expansion_parameters: unknown[] | null;
  /** `expansion.total` as VSAC reported it. */
  total_reported: number | null;
  codes_retrieved: number;
  inactive_count: number;
  /** Abstract (non-selectable) entries left out of `codes`. */
  abstract_excluded: number;
  /** Distinct code systems seen, with a count each — surfaces any system the
   * label map doesn't know. */
  code_systems: Array<{ system: string; vocabulary: string; count: number }>;
  completeness: "verified";
  pages: number;
  /** SHA-256 over the sorted `system|code` list — a stable fingerprint of the
   * CONTENT (independent of order/display text) for later drift detection. */
  content_sha256: string;
  /** Our clock, ISO-8601, at the moment the expansion finished downloading. */
  retrieved_at: string;
  /** The un-paged canonical URL (no key, no paging params). */
  source_url: string;
  attribution: string;
};

/**
 * What gets stored in `custom_value_sets.provenance` /
 * `terminology_requests.vsac_expansion_preview.provenance`: everything the
 * client observed, plus — when the Auto Terminologist staged it — who staged
 * it, why this value set was chosen for which request, and in what mode.
 * `staged_by` is also what the database guard keys on (see the migration
 * `20261127120000_vsac_auto_retrieval_provenance.sql`).
 */
export type VsacProvenance = VsacObservedProvenance & {
  staged_by?: "auto-terminologist";
  stage_mode?: "draft" | "preview";
  request_id?: string | null;
  match?: {
    basis: "seed_overlap";
    seed_total: number;
    seed_matched: number;
    coverage: number;
    name_score: number;
    matched_codes: Array<{ code: string; vocabulary: string }>;
  };
};

export type VsacRetrieval = {
  oid: string;
  name: string | null;
  title: string | null;
  publisher: string | null;
  status: string | null;
  type: "grouping" | "intensional" | "extensional";
  total: number;
  codes: VsacCode[];
  provenance: VsacObservedProvenance;
};

/**
 * The surface the cycle depends on. Tests inject a fake; the edge function
 * injects `createVsacClient(...)`; the browser injects nothing (so the
 * discovery pass reports itself skipped there).
 */
export interface VsacGateway {
  search(query: string, count: number): Promise<VsacCandidate[]>;
  retrieve(oid: string): Promise<VsacRetrieval>;
  stats(): VsacClientStats;
}

export type VsacClientStats = {
  requests: number;
  budget: number;
  retries: number;
  /** The fatal condition that opened the breaker, or null while healthy. */
  circuit: VsacErrorKind | null;
};

export type VsacClientOptions = {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Minimum gap between requests. NLM's ceiling is 20 req/s per IP; the
   * default (150 ms, ≈ 6.7 req/s) leaves wide headroom for other callers
   * sharing the edge function's egress IP. */
  minIntervalMs?: number;
  /** Retries per request for 429/5xx/network errors (not counting the first try). */
  maxRetries?: number;
  /** Longest Retry-After this client will sit through; a longer one surfaces
   * as `rate_limited` so the cycle can stop and try next tick. */
  maxRetryAfterMs?: number;
  requestTimeoutMs?: number;
  /** Backoff jitter source (0..1). Injectable so tests are deterministic. */
  random?: () => number;
  /** Hard cap on HTTP requests made by this instance (one cycle's worth). */
  requestBudget?: number;
  /** `count` sent with paged `$expand` requests. */
  pageSize?: number;
  maxPages?: number;
  /** Refuse (as `too_large`) any expansion larger than this. */
  maxCodes?: number;
};

/* ------------------------------------------------------------------ */
/*  Small pure helpers (exported for tests)                             */
/* ------------------------------------------------------------------ */

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Parses a `Retry-After` header: delta-seconds or an HTTP-date. null when absent/unparseable. */
export function parseRetryAfterMs(header: string | null | undefined, nowMs: number): number | null {
  if (!header) return null;
  const t = header.trim();
  if (/^\d+$/.test(t)) return Math.min(Number(t) * 1000, 24 * 3600 * 1000);
  const when = Date.parse(t);
  if (Number.isNaN(when)) return null;
  return Math.max(0, when - nowMs);
}

/** Hex SHA-256 of a string. */
export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Stable fingerprint of a value set's CONTENT: sorted `system|code` lines. */
export async function contentHash(codes: Array<{ system: string; code: string }>): Promise<string> {
  const lines = codes.map((c) => `${c.system}|${c.code}`).sort();
  return sha256Hex(lines.join("\n"));
}

type RawContains = {
  system?: unknown;
  code?: unknown;
  display?: unknown;
  abstract?: unknown;
  inactive?: unknown;
  contains?: unknown;
};

/** Flattens a (possibly hierarchical) `expansion.contains`, depth-capped. */
export function flattenContains(contains: unknown, depth = 0): RawContains[] {
  if (!Array.isArray(contains) || depth > 12) return [];
  const out: RawContains[] = [];
  for (const entry of contains as RawContains[]) {
    if (!entry || typeof entry !== "object") continue;
    out.push(entry);
    if (entry.contains) out.push(...flattenContains(entry.contains, depth + 1));
  }
  return out;
}

export function vocabularyLabel(system: string): string {
  return VSAC_SYSTEM_TO_VOCAB[system] ?? system;
}

/* ------------------------------------------------------------------ */
/*  The client                                                          */
/* ------------------------------------------------------------------ */

export function createVsacClient(options: VsacClientOptions): VsacGateway {
  return new VsacClient(options);
}

class VsacClient implements VsacGateway {
  private readonly base: string;
  private readonly authHeader: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly maxRetryAfterMs: number;
  private readonly requestTimeoutMs: number;
  private readonly budget: number;
  private readonly pageSize: number;
  private readonly maxPages: number;
  private readonly maxCodes: number;

  private requests = 0;
  private retries = 0;
  private lastRequestAt = 0;
  private circuit: VsacErrorKind | null = null;
  private consecutiveTransient = 0;
  /** Flipped off the first time VSAC rejects paging parameters. */
  private pagingSupported = true;

  constructor(o: VsacClientOptions) {
    if (!o.apiKey) throw new VsacError("auth", "UMLS API key is not configured");
    this.base = (o.baseUrl ?? VSAC_FHIR_BASE).replace(/\/+$/, "");
    try {
      this.authHeader = `Basic ${btoa(`apikey:${o.apiKey}`)}`;
    } catch {
      throw new VsacError("auth", "UMLS API key contains characters that cannot be Base64-encoded");
    }
    this.fetchImpl = o.fetchImpl ?? ((input, init) => fetch(input, init));
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = o.now ?? (() => Date.now());
    this.random = o.random ?? Math.random;
    this.minIntervalMs = o.minIntervalMs ?? 150;
    this.maxRetries = o.maxRetries ?? 2;
    this.maxRetryAfterMs = o.maxRetryAfterMs ?? 15_000;
    this.requestTimeoutMs = o.requestTimeoutMs ?? 20_000;
    this.budget = o.requestBudget ?? 40;
    this.pageSize = o.pageSize ?? 1000;
    this.maxPages = o.maxPages ?? 25;
    this.maxCodes = o.maxCodes ?? 10_000;
  }

  stats(): VsacClientStats {
    return {
      requests: this.requests,
      budget: this.budget,
      retries: this.retries,
      circuit: this.circuit,
    };
  }

  /* ---------------- transport ---------------- */

  private async throttle(): Promise<void> {
    const wait = this.lastRequestAt + this.minIntervalMs - this.now();
    if (wait > 0) await this.sleep(wait);
    this.lastRequestAt = this.now();
  }

  /**
   * One logical HTTP GET with throttling, the request budget, bounded retry
   * for 429/5xx/network failures, Retry-After handling, and the breaker.
   * Returns the parsed JSON object; throws a classified `VsacError` otherwise.
   * The abort timer stays armed until the BODY has been read, so a response
   * that sends headers and then stalls cannot hang the whole cycle.
   */
  private async getJson(url: string): Promise<Record<string, unknown>> {
    for (let attempt = 0; ; attempt++) {
      if (this.circuit) {
        throw new VsacError("circuit_open", `VSAC calls halted for this cycle (${this.circuit})`);
      }
      if (this.requests >= this.budget) {
        throw new VsacError("budget_exhausted", `VSAC request budget (${this.budget}) spent`);
      }
      await this.throttle();
      this.requests++;

      let res: Response | null = null;
      let networkFailure = false;
      let badBody = false;
      let parsed: unknown;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), this.requestTimeoutMs);
      try {
        res = await this.fetchImpl(url, {
          method: "GET",
          headers: { Accept: "application/json", Authorization: this.authHeader },
          signal: ctl.signal,
        });
        if (res.ok) {
          try {
            parsed = await res.json();
          } catch {
            // Aborted mid-body = a stall (transient); anything else = not JSON.
            if (ctl.signal.aborted) networkFailure = true;
            else badBody = true;
          }
        }
      } catch {
        // Deliberately drops the underlying error text — it can contain the URL.
        networkFailure = true;
      } finally {
        clearTimeout(timer);
      }

      if (res && res.ok && !networkFailure) {
        if (badBody || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new VsacError("malformed", "VSAC returned a non-JSON or non-object body");
        }
        this.consecutiveTransient = 0;
        return parsed as Record<string, unknown>;
      }

      const status = res?.status;

      if (res && (status === 401 || status === 403)) {
        this.circuit = "auth";
        throw new VsacError(
          "auth",
          `VSAC rejected the UMLS key (HTTP ${status}) — the key is invalid or its UMLS licence does not cover VSAC`,
          { status },
        );
      }
      if (res && status === 404) {
        throw new VsacError("not_found", "VSAC has no such resource (HTTP 404)", { status });
      }
      if (res && status === 429) {
        const ra = parseRetryAfterMs(res.headers?.get?.("retry-after"), this.now());
        const waitMs = ra ?? Math.min(2000 * 2 ** attempt, this.maxRetryAfterMs);
        if (waitMs > this.maxRetryAfterMs || attempt >= this.maxRetries) {
          this.circuit = "rate_limited";
          throw new VsacError("rate_limited", "VSAC rate limit hit (HTTP 429)", {
            status,
            retryAfterMs: waitMs,
          });
        }
        this.retries++;
        await this.sleep(waitMs);
        continue;
      }
      if (res && status !== undefined && status >= 400 && status < 500 && status !== 408) {
        throw new VsacError("bad_request", `VSAC rejected the request (HTTP ${status})`, {
          status,
        });
      }

      // Network failure, timeout, 408, or 5xx → transient.
      this.consecutiveTransient++;
      if (attempt >= this.maxRetries) {
        if (this.consecutiveTransient >= 3) this.circuit = "transient";
        throw new VsacError(
          "transient",
          networkFailure
            ? "VSAC unreachable (network error or timeout)"
            : `VSAC server error (HTTP ${status})`,
          { status },
        );
      }
      this.retries++;
      await this.sleep(Math.min(500 * 2 ** attempt, 4000) + Math.floor(this.random() * 250));
    }
  }

  /* ---------------- search ---------------- */

  async search(query: string, count: number): Promise<VsacCandidate[]> {
    const q = query.trim();
    if (!q) return [];
    const n = Math.max(1, Math.min(50, Math.floor(count) || 10));
    const qs = new URLSearchParams({ "name:contains": q, _count: String(n) });
    const bundle = await this.getJson(`${this.base}/ValueSet?${qs}`);
    const entries = Array.isArray(bundle.entry)
      ? (bundle.entry as Array<{ resource?: unknown }>)
      : [];
    const out: VsacCandidate[] = [];
    const seen = new Set<string>();
    for (const e of entries) {
      const r = e?.resource as Record<string, unknown> | undefined;
      const oid = str(r?.id);
      if (!r || !oid || seen.has(oid)) continue;
      seen.add(oid);
      out.push({
        oid,
        name: str(r.name),
        title: str(r.title),
        publisher: str(r.publisher),
        status: str(r.status),
        version: str(r.version),
      });
    }
    return out;
  }

  /* ---------------- retrieve ---------------- */

  async retrieve(oid: string): Promise<VsacRetrieval> {
    const id = oid.trim();
    if (!id) throw new VsacError("bad_request", "Missing OID");
    const vsUrl = `${this.base}/ValueSet/${encodeURIComponent(id)}`;

    // 1. The definition: existence, status, version, publisher, authoring type.
    const def = await this.getJson(vsUrl);
    const compose = def.compose as { include?: unknown } | undefined;
    const includes = Array.isArray(compose?.include)
      ? (compose!.include as Array<Record<string, unknown>>)
      : [];
    const hasGrouping = includes.some((i) => Array.isArray(i?.valueSet) && i.valueSet.length > 0);
    const hasFilter = includes.some((i) => Array.isArray(i?.filter) && i.filter.length > 0);
    const type: VsacRetrieval["type"] = hasGrouping
      ? "grouping"
      : hasFilter
        ? "intensional"
        : "extensional";

    // 2. The expansion, paged, with completeness proven or the call refused.
    const exp = await this.expandAll(vsUrl);

    const codes = exp.codes;
    const inactiveCount = codes.filter((c) => c.inactive).length;
    const bySystem = new Map<string, number>();
    for (const c of codes) bySystem.set(c.system, (bySystem.get(c.system) ?? 0) + 1);

    const meta = (exp.resource.meta ?? def.meta) as Record<string, unknown> | undefined;
    const pick = <T>(f: (r: Record<string, unknown>) => T | null): T | null =>
      f(exp.resource) ?? f(def);

    const provenance: VsacObservedProvenance = {
      source: "VSAC",
      api: "NLM VSAC FHIR Terminology Service",
      oid: id,
      vsac_version: pick((r) => str(r.version)),
      vsac_status: pick((r) => str(r.status)),
      vsac_publisher: pick((r) => str(r.publisher)),
      vsac_date: pick((r) => str(r.date)),
      vsac_last_updated: str(meta?.lastUpdated),
      vsac_version_id: str(meta?.versionId),
      expansion_timestamp: exp.timestamp,
      expansion_identifier: exp.identifier,
      expansion_parameters: exp.parameters,
      total_reported: exp.total,
      codes_retrieved: codes.length,
      inactive_count: inactiveCount,
      abstract_excluded: exp.abstractExcluded,
      code_systems: [...bySystem.entries()].map(([system, count]) => ({
        system,
        vocabulary: vocabularyLabel(system),
        count,
      })),
      completeness: "verified",
      pages: exp.pages,
      content_sha256: await contentHash(codes),
      retrieved_at: new Date(this.now()).toISOString(),
      source_url: `${vsUrl}/$expand`,
      attribution: VSAC_ATTRIBUTION,
    };

    return {
      oid: id,
      name: pick((r) => str(r.name)),
      title: pick((r) => str(r.title)),
      publisher: provenance.vsac_publisher,
      status: provenance.vsac_status,
      type,
      total: codes.length,
      codes,
      provenance,
    };
  }

  private async expandAll(vsUrl: string): Promise<{
    resource: Record<string, unknown>;
    codes: VsacCode[];
    total: number | null;
    timestamp: string | null;
    identifier: string | null;
    parameters: unknown[] | null;
    abstractExcluded: number;
    pages: number;
  }> {
    const expandUrl = `${vsUrl}/$expand`;
    const kept = new Map<string, VsacCode>();
    // Every distinct entry (abstract ones too) — what `expansion.total` counts.
    const distinct = new Set<string>();
    let abstractExcluded = 0;
    let first: Record<string, unknown> | null = null;
    let total: number | null = null;
    let timestamp: string | null = null;
    let identifier: string | null = null;
    let parameters: unknown[] | null = null;
    let pages = 0;
    let offset = 0;
    let pagingOn = this.pagingSupported;
    let proven = false;

    while (pages < this.maxPages) {
      const url = pagingOn ? `${expandUrl}?offset=${offset}&count=${this.pageSize}` : expandUrl;
      let body: Record<string, unknown>;
      try {
        body = await this.getJson(url);
      } catch (e) {
        // First paged request rejected → the server doesn't take paging
        // parameters. Remember that and retry once un-paged.
        if (e instanceof VsacError && e.kind === "bad_request" && pagingOn && pages === 0) {
          pagingOn = false;
          this.pagingSupported = false;
          continue;
        }
        throw e;
      }
      pages++;
      if (!first) first = body;

      const expansion = body.expansion as Record<string, unknown> | undefined;
      if (!expansion || typeof expansion !== "object") {
        throw new VsacError("malformed", "VSAC $expand response has no expansion");
      }
      total = num(expansion.total) ?? total;
      timestamp = timestamp ?? str(expansion.timestamp);
      identifier = identifier ?? str(expansion.identifier);
      if (!parameters && Array.isArray(expansion.parameter)) parameters = expansion.parameter;

      if (total !== null && total > this.maxCodes) {
        throw new VsacError(
          "too_large",
          `Expansion reports ${total} codes, above the ${this.maxCodes}-code ceiling`,
        );
      }

      const entries = flattenContains(expansion.contains);
      let progress = 0;
      for (const e of entries) {
        const code = str(e.code);
        if (!code) continue;
        const system = str(e.system) ?? "";
        const key = `${system}|${code}`;
        if (!distinct.has(key)) {
          distinct.add(key);
          progress++;
        }
        if (e.abstract === true) {
          if (!kept.has(key)) abstractExcluded++;
          continue;
        }
        if (!kept.has(key)) {
          kept.set(key, {
            code,
            display: typeof e.display === "string" ? e.display : "",
            system,
            vocabulary: vocabularyLabel(system),
            inactive: e.inactive === true,
          });
        }
      }

      if (distinct.size > this.maxCodes) {
        throw new VsacError("too_large", `Expansion exceeds the ${this.maxCodes}-code ceiling`);
      }

      // Completeness: with a reported total, every distinct entry must be in hand.
      if (total !== null && distinct.size >= total) {
        proven = true;
        break;
      }
      if (!pagingOn) break; // un-paged and still short of total/unknown → unprovable
      if (progress === 0) break; // server ignored `offset` (or nothing left) → stop
      // NOTE: a short page is deliberately NOT treated as "the end". A server
      // that ignores `count` and serves its own smaller default page looks
      // exactly like a complete one when it sends no `total`, so without a
      // reported total nothing can be proven and the expansion is refused.
      offset += entries.length;
    }

    if (!proven) {
      const got = distinct.size;
      throw new VsacError(
        "incomplete",
        total !== null
          ? `Incomplete expansion: received ${got} of ${total} codes (paging unsupported or stalled)`
          : "Cannot verify the expansion is complete (VSAC reported no total)",
      );
    }

    return {
      resource: first ?? {},
      codes: [...kept.values()],
      total,
      timestamp,
      identifier,
      parameters,
      abstractExcluded,
      pages,
    };
  }
}
