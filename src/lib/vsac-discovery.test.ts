/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from "vitest";
import {
  DISCOVERY_COOLDOWN_BASE_MS,
  MAX_DISCOVERY_ATTEMPTS,
  TRANSIENT_COOLDOWN_MAX_MS,
  buildAutoStagedDraft,
  buildStagedProvenance,
  cooldownMs,
  deriveSearchTerms,
  gradeRetrieval,
  gradeableSeeds,
  normalizeCode,
  nameScore,
  parseStageMode,
  rankAccepted,
  reconcileStagedRequests,
  runVsacDiscoveryPass,
  significantTokens,
  transientCooldownMs,
  vocabFamily,
  type Grade,
  type StageMode,
} from "../../supabase/functions/_shared/vsac-discovery";
import {
  VsacError,
  type VsacCandidate,
  type VsacGateway,
  type VsacRetrieval,
} from "../../supabase/functions/_shared/vsac-client";
import { buildVsacImportInsert } from "../../supabase/functions/_shared/value-set-registry";
import { runAutoTerminologistCycle } from "./auto-terminologist-cycle";

/**
 * Tests for the autonomous VSAC discovery pass. The DB is a tiny in-memory
 * fake that records every write, so the PUBLISH-GATE INVARIANT can be asserted
 * on each scenario: the only thing this pass may ever write to
 * `custom_value_sets` is the insert of an inert draft.
 */

const OID1 = "2.16.840.1.113883.3.464.1003.101.12.1001";
const OID2 = "2.16.840.1.113883.3.464.1003.101.12.1002";
const OID3 = "2.16.840.1.113883.3.464.1003.101.12.1003";

/* ---------------- fakes ---------------- */

type Row = Record<string, any>;
type Write = { table: string; op: "insert" | "update"; payload: any; eq: Array<[string, unknown]> };

function makeDb(
  initial: Record<string, Row[]> = {},
  opts: { failCustomValueSetInsert?: boolean } = {},
) {
  const tables: Record<string, Row[]> = {};
  for (const [k, v] of Object.entries(initial)) tables[k] = v.map((r) => ({ ...r }));
  const writes: Write[] = [];
  let seq = 0;

  class Q {
    private filters: Array<(r: Row) => boolean> = [];
    private eqs: Array<[string, unknown]> = [];
    private op: "select" | "insert" | "update" = "select";
    private payload: any;
    private wantsRows = false;
    private isSingle = false;
    private isMaybe = false;
    constructor(private table: string) {}
    select() {
      this.wantsRows = true;
      return this;
    }
    insert(p: any) {
      this.op = "insert";
      this.payload = p;
      return this;
    }
    update(p: any) {
      this.op = "update";
      this.payload = p;
      return this;
    }
    eq(c: string, v: unknown) {
      this.eqs.push([c, v]);
      this.filters.push((r) => r[c] === v);
      return this;
    }
    neq(c: string, v: unknown) {
      this.filters.push((r) => r[c] !== v);
      return this;
    }
    is(c: string, v: unknown) {
      this.filters.push((r) => (v === null ? r[c] == null : r[c] === v));
      return this;
    }
    in(c: string, arr: unknown[]) {
      this.filters.push((r) => arr.includes(r[c]));
      return this;
    }
    not(c: string, _o: string, v: unknown) {
      this.filters.push((r) => (v === null ? r[c] != null : r[c] !== v));
      return this;
    }
    or() {
      return this;
    }
    order() {
      return this;
    }
    limit() {
      return this;
    }
    single() {
      this.isSingle = true;
      return this;
    }
    maybeSingle() {
      this.isMaybe = true;
      return this;
    }
    then(res: any, rej: any) {
      return Promise.resolve(this.run()).then(res, rej);
    }
    private run(): { data: any; error: any } {
      const rows = (tables[this.table] ??= []);
      if (this.op === "insert") {
        writes.push({ table: this.table, op: "insert", payload: this.payload, eq: [] });
        if (opts.failCustomValueSetInsert && this.table === "custom_value_sets") {
          return { data: null, error: { message: "unique violation" } };
        }
        const row = {
          id: `${this.table === "custom_value_sets" ? "vs" : "row"}-${++seq}`,
          ...this.payload,
        };
        rows.push(row);
        return { data: this.wantsRows ? (this.isSingle ? row : [row]) : null, error: null };
      }
      const matched = rows.filter((r) => this.filters.every((f) => f(r)));
      if (this.op === "update") {
        writes.push({ table: this.table, op: "update", payload: this.payload, eq: this.eqs });
        for (const r of matched) Object.assign(r, this.payload);
        return { data: this.wantsRows ? matched.map((r) => ({ id: r.id })) : null, error: null };
      }
      if (this.isSingle || this.isMaybe) return { data: matched[0] ?? null, error: null };
      return { data: matched, error: null };
    }
  }

  return {
    from: (t: string) => new Q(t),
    functions: { invoke: vi.fn(async () => ({ data: null, error: null })) },
    tables,
    writes,
  } as any;
}

function request(over: Row = {}): Row {
  return {
    id: "req-1",
    requesting_consumer: "Auto Terminologist · Proactive Sweep",
    requested_name: 'Condition coverage for "Hypertension"',
    priority: "normal",
    status: "pending",
    vocabulary: "SNOMED CT",
    seed_codes: [{ code: "38341003", display: "Hypertensive disorder" }],
    request_type: "create",
    known_vsac_candidates: [
      {
        oid: OID1,
        name: "EssentialHypertension",
        title: "Essential Hypertension",
        publisher: "NCQA",
      },
    ],
    occurrence_count: 1,
    requested_at: "2026-11-20T00:00:00Z",
    vsac_discovery_at: null,
    vsac_discovery_attempts: 0,
    linked_vsac_oid: null,
    ...over,
  };
}

function retrieval(
  over: Partial<VsacRetrieval> & { codeList?: Array<[string, string]> } = {},
): VsacRetrieval {
  const codeList = over.codeList ?? [
    ["38341003", "SNOMED CT"],
    ["59621000", "SNOMED CT"],
  ];
  const oid = over.oid ?? OID1;
  return {
    oid,
    name: "EssentialHypertension",
    title: "Essential Hypertension",
    publisher: "NCQA",
    status: "active",
    type: "extensional",
    total: codeList.length,
    codes: codeList.map(([code, vocabulary]) => ({
      code,
      display: `d-${code}`,
      system: vocabulary === "SNOMED CT" ? "http://snomed.info/sct" : "http://example.org/x",
      vocabulary,
      inactive: false,
    })),
    provenance: {
      source: "VSAC",
      api: "NLM VSAC FHIR Terminology Service",
      oid,
      vsac_version: "20240601",
      vsac_status: "active",
      vsac_publisher: "NCQA",
      vsac_date: "2024-06-01",
      vsac_last_updated: null,
      vsac_version_id: null,
      expansion_timestamp: "2024-06-03T10:00:00Z",
      expansion_identifier: null,
      expansion_parameters: null,
      total_reported: codeList.length,
      codes_retrieved: codeList.length,
      inactive_count: 0,
      abstract_excluded: 0,
      code_systems: [],
      completeness: "verified",
      pages: 1,
      content_sha256: "ab".repeat(32),
      retrieved_at: "2026-11-27T12:00:00.000Z",
      source_url: `https://cts.nlm.nih.gov/fhir/ValueSet/${oid}/$expand`,
      attribution:
        "This product uses publicly available data from the U.S. National Library of Medicine (NLM)",
    },
    ...over,
  } as VsacRetrieval;
}

function gateway(opts: {
  search?: (q: string) => VsacCandidate[] | Promise<VsacCandidate[]>;
  retrieve: (oid: string) => VsacRetrieval | Promise<VsacRetrieval>;
}) {
  let requests = 0;
  const gw = {
    search: vi.fn(async (q: string) => {
      requests++;
      return opts.search ? opts.search(q) : [];
    }),
    retrieve: vi.fn(async (oid: string) => {
      requests++;
      return opts.retrieve(oid);
    }),
    stats: () => ({ requests, budget: 40, retries: 0, circuit: null }),
  };
  return gw as typeof gw & VsacGateway;
}

// `lastErrorLoggedAt` in the module throttles repeat error logs; give every
// test its own clock far enough apart that it never suppresses an assertion.
let clock = Date.parse("2026-11-27T12:00:00Z");
function freshNow() {
  clock += 48 * 60 * 60_000;
  const t = clock;
  return () => t;
}

function run(
  db: any,
  gw: VsacGateway | null,
  mode: StageMode = "draft",
  extra: { batchSize?: number } = {},
) {
  const logs: any[] = [];
  const now = freshNow();
  return {
    logs,
    now,
    promise: runVsacDiscoveryPass(db, gw, {
      mode,
      log: async (e) => void logs.push(e),
      now,
      ...extra,
    }),
  };
}

/** The publish gate: the pass may only ever INSERT inert, auto-stamped drafts. */
function expectGateIntact(db: any) {
  for (const w of db.writes.filter((x: Write) => x.table === "custom_value_sets")) {
    expect(w.op).toBe("insert");
    expect(w.payload.status).toBe("draft");
    expect(w.payload.provenance?.staged_by).toBe("auto-terminologist");
  }
  for (const w of db.writes.filter((x: Write) => x.table === "terminology_requests")) {
    expect(["pending", "vsac_staged", "ready_to_import", "resolved", undefined]).toContain(
      w.payload.status,
    );
  }
}

/* ---------------- pure helpers ---------------- */

describe("vocabulary + code normalisation", () => {
  it("collapses spellings to a family and keeps ICD-10-PCS apart from ICD-10-CM", () => {
    expect(vocabFamily("SNOMED CT")).toBe("snomed");
    expect(vocabFamily("SNOMEDCT_US")).toBe("snomed");
    expect(vocabFamily("ICD-10")).toBe("icd10");
    expect(vocabFamily("ICD-10-CM")).toBe("icd10");
    expect(vocabFamily("ICD-10-PCS")).toBe("icd10pcs");
    expect(vocabFamily("RxNorm")).toBe("rxnorm");
    expect(vocabFamily("LNC")).toBe("loinc");
    expect(vocabFamily("")).toBe("");
  });

  it("ignores the dot and case in ICD-10 codes only", () => {
    expect(normalizeCode("icd10", "e11.9")).toBe("E119");
    expect(normalizeCode("icd10", "E119")).toBe("E119");
    expect(normalizeCode("snomed", " 38341003 ")).toBe("38341003");
    expect(normalizeCode("loinc", "718-7")).toBe("718-7");
  });
});

describe("deriveSearchTerms", () => {
  it("extracts the quoted clinical term from sweep-style request names", () => {
    expect(
      deriveSearchTerms({
        requested_name: 'Condition coverage for "Hypertension"',
        seed_codes: [],
        vocabulary: null,
      }),
    ).toEqual(["Hypertension"]);
    expect(
      deriveSearchTerms({
        requested_name: 'Allergy-class coverage for "Penicillin"',
        seed_codes: [],
        vocabulary: null,
      }),
    ).toEqual(["Penicillin"]);
  });

  it("adds the first seed's own display as a second angle, without duplicating", () => {
    expect(
      deriveSearchTerms({
        requested_name: 'Condition coverage for "Hypertension"',
        seed_codes: [{ code: "1", display: "Hypertensive disorder" }],
        vocabulary: "SNOMED CT",
      }),
    ).toEqual(["Hypertension", "Hypertensive disorder"]);
    expect(
      deriveSearchTerms({
        requested_name: "Hypertension",
        seed_codes: [{ code: "1", display: "hypertension" }],
        vocabulary: null,
      }),
    ).toEqual(["Hypertension"]);
  });

  it("falls back to the boilerplate-stripped name", () => {
    expect(
      deriveSearchTerms({
        requested_name: "Missing coverage for Sepsis bundle",
        seed_codes: [],
        vocabulary: null,
      }),
    ).toEqual(["Sepsis bundle"]);
  });
});

describe("name relevance", () => {
  it("tokenises camelCase, drops stopwords, stems plurals", () => {
    expect(significantTokens("EssentialHypertension")).toEqual(["essential", "hypertension"]);
    expect(significantTokens("Drug-Allergy coverage for Penicillins")).toEqual(["penicillin"]);
  });

  it("scores the fraction of request tokens present", () => {
    const t = significantTokens("Hypertensive disorder");
    expect(nameScore(t, "Hypertensive disorder, essential")).toBe(1);
    expect(nameScore(t, "Essential hypertension")).toBe(0);
    expect(nameScore([], "anything")).toBe(0);
  });
});

describe("gradeRetrieval", () => {
  const seeds = [{ code: "38341003", display: "x", vocabulary: "SNOMED CT" }];
  const tokens = significantTokens("Hypertension");

  it("accepts a relevant, active set containing the seed code", () => {
    const g = gradeRetrieval({ seeds, retrieval: retrieval(), termTokens: tokens });
    expect(g).toMatchObject({ accepted: true, coverage: 1, seedMatched: 1, seedTotal: 1 });
    expect(g.matched).toEqual([{ code: "38341003", vocabulary: "SNOMED CT" }]);
  });

  it("NEVER accepts on a name match alone — no seed code, no stage", () => {
    const g = gradeRetrieval({
      seeds,
      retrieval: retrieval({ codeList: [["99999999", "SNOMED CT"]] }),
      termTokens: tokens,
    });
    expect(g.accepted).toBe(false);
    expect(g.coverage).toBe(0);
  });

  it("rejects a non-active VSAC value set", () => {
    const g = gradeRetrieval({
      seeds,
      retrieval: retrieval({ status: "retired" }),
      termTokens: tokens,
    });
    expect(g.accepted).toBe(false);
    expect(g.reason).toContain("retired");
  });

  it("rejects when there is nothing gradeable (no seeds, or an unrecognised vocabulary)", () => {
    expect(gradeRetrieval({ seeds: [], retrieval: retrieval(), termTokens: tokens }).accepted).toBe(
      false,
    );
    expect(
      gradeRetrieval({
        seeds: [{ code: "1", display: "", vocabulary: "" }],
        retrieval: retrieval(),
        termTokens: tokens,
      }).accepted,
    ).toBe(false);
  });

  it("enforces the coverage floor on multi-seed requests", () => {
    const three = [
      { code: "38341003", display: "", vocabulary: "SNOMED CT" },
      { code: "1", display: "", vocabulary: "SNOMED CT" },
      { code: "2", display: "", vocabulary: "SNOMED CT" },
    ];
    expect(
      gradeRetrieval({ seeds: three, retrieval: retrieval(), termTokens: tokens }),
    ).toMatchObject({ accepted: false, seedMatched: 1, seedTotal: 3 });
    const half = [three[0], three[1]];
    expect(
      gradeRetrieval({ seeds: half, retrieval: retrieval(), termTokens: tokens }).accepted,
    ).toBe(true);
  });

  it("rejects a big set that merely happens to contain the code and shares no name", () => {
    const big: Array<[string, string]> = [["38341003", "SNOMED CT"]];
    for (let i = 0; i < 300; i++) big.push([String(1000 + i), "SNOMED CT"]);
    const r = retrieval({
      codeList: big,
      name: "EncounterInpatient",
      title: "Encounter Inpatient",
    });
    expect(gradeRetrieval({ seeds, retrieval: r, termTokens: tokens }).accepted).toBe(false);
    // …but a SMALL unrelated-name set is allowed through (steward still reviews it).
    const small = retrieval({ name: "Cardiac Conditions", title: "Cardiac Conditions" });
    expect(gradeRetrieval({ seeds, retrieval: small, termTokens: tokens }).accepted).toBe(true);
  });

  it("matches ICD-10 across dotted/undotted and CM/non-CM labels", () => {
    const icd = [{ code: "E11.9", display: "", vocabulary: "ICD-10" }];
    const r = retrieval({ codeList: [["E119", "ICD-10-CM"]] });
    expect(
      gradeRetrieval({ seeds: icd, retrieval: r, termTokens: significantTokens("diabetes") })
        .seedMatched,
    ).toBe(1);
  });

  it("does not match a code in the wrong vocabulary", () => {
    const rx = [{ code: "38341003", display: "", vocabulary: "RxNorm" }];
    expect(gradeRetrieval({ seeds: rx, retrieval: retrieval(), termTokens: tokens }).accepted).toBe(
      false,
    );
  });
});

describe("rankAccepted / cooldown / stage mode", () => {
  const g = (coverage: number, nameScore: number): Grade => ({
    accepted: true,
    reason: "",
    seedTotal: 2,
    seedMatched: 2,
    coverage,
    nameScore,
    matched: [],
  });
  it("ranks by coverage, then name, then the smaller set, then OID", () => {
    const ranked = rankAccepted([
      { grade: g(0.5, 1), total: 10, oid: "a" },
      { grade: g(1, 0), total: 10, oid: "b" },
      { grade: g(1, 1), total: 100, oid: "c" },
      { grade: g(1, 1), total: 20, oid: "d" },
    ]);
    expect(ranked.map((r) => r.oid)).toEqual(["d", "c", "b", "a"]);
  });

  it("scales the retry cooldown with the number of failed attempts", () => {
    expect(cooldownMs(0)).toBe(0);
    expect(cooldownMs(1)).toBe(DISCOVERY_COOLDOWN_BASE_MS);
    expect(cooldownMs(2)).toBe(2 * DISCOVERY_COOLDOWN_BASE_MS);
  });

  it("parses the stage mode, failing SAFE to preview on anything unknown", () => {
    // Writing drafts is an explicit opt-in: nothing configured means preview.
    expect(parseStageMode(undefined)).toBe("preview");
    expect(parseStageMode(null)).toBe("preview");
    expect(parseStageMode("")).toBe("preview");
    expect(parseStageMode(" PREVIEW ")).toBe("preview");
    expect(parseStageMode(" Draft ")).toBe("draft");
    expect(parseStageMode("off")).toBe("off");
    expect(parseStageMode("banana")).toBe("preview");
  });
});

describe("draft + provenance builders", () => {
  const grade: Grade = {
    accepted: true,
    reason: "",
    seedTotal: 1,
    seedMatched: 1,
    coverage: 1,
    nameScore: 1,
    matched: [{ code: "38341003", vocabulary: "SNOMED CT" }],
  };

  it("builds an inert draft carrying VSAC's version and full provenance, with state-neutral wording", () => {
    const r = retrieval();
    const p = buildStagedProvenance(r, { mode: "draft", requestId: "req-1", grade });
    const d = buildAutoStagedDraft(r, p, "2026-11-27T12:00:00.000Z");
    expect(d.status).toBe("draft");
    expect(d.oid).toBe(OID1);
    expect(d.name).toBe("Essential Hypertension");
    expect(d.version).toBe("20240601");
    expect(d.steward).toBe("NCQA");
    // The text outlives the draft stage: it must not claim a review state a steward may have changed.
    expect(d.description).toContain("Retrieved automatically from NLM VSAC");
    expect(d.description).not.toMatch(/not reviewed|unreviewed/i);
    expect(d.codes).toEqual([
      { code: "38341003", display: "d-38341003", system: "SNOMED CT" },
      { code: "59621000", display: "d-59621000", system: "SNOMED CT" },
    ]);
    expect(d.provenance).toMatchObject({
      source: "VSAC",
      staged_by: "auto-terminologist",
      stage_mode: "draft",
      request_id: "req-1",
      vsac_version: "20240601",
      expansion_timestamp: "2024-06-03T10:00:00Z",
      content_sha256: "ab".repeat(32),
      match: { basis: "seed_overlap", seed_matched: 1, seed_total: 1, coverage: 1 },
    });
    expect(d.change_history).toHaveLength(1);
    expect(d.change_history[0].change).toContain("awaiting steward review");
  });

  it("carries VSAC's per-code inactive flag into the draft, and only on codes that have it", () => {
    const r = retrieval();
    r.codes[1] = { ...r.codes[1], inactive: true };
    const p = buildStagedProvenance(r, { mode: "draft", requestId: "req-1", grade });
    const d = buildAutoStagedDraft(r, p, "2026-11-27T12:00:00.000Z");
    expect(d.codes[0]).toEqual({ code: "38341003", display: "d-38341003", system: "SNOMED CT" });
    expect(d.codes[1]).toEqual({
      code: "59621000",
      display: "d-59621000",
      system: "SNOMED CT",
      inactive: true,
    });
  });

  it("buildVsacImportInsert only adds version/provenance when the expansion has them", () => {
    const plain = buildVsacImportInsert(
      {
        oid: OID1,
        name: "n",
        title: "t",
        total: 1,
        type: "extensional",
        codes: [{ code: "1", display: "a", vocabulary: "SNOMED CT" }],
        publisher: "NCQA",
      },
      "T",
    );
    expect("provenance" in plain).toBe(false);
    expect("version" in plain).toBe(false);

    const r = retrieval();
    const p = buildStagedProvenance(r, { mode: "preview", requestId: "req-1", grade });
    const withProv = buildVsacImportInsert(
      {
        oid: OID1,
        name: "n",
        title: "t",
        total: 1,
        type: "extensional",
        codes: [{ code: "1", display: "a", vocabulary: "SNOMED CT" }],
        publisher: "NCQA",
        provenance: p,
      },
      "T",
    );
    expect(withProv.version).toBe("20240601");
    expect(withProv.provenance?.staged_by).toBe("auto-terminologist");
    expect(withProv.status).toBe("draft");
  });
});

/* ---------------- the pass ---------------- */

describe("runVsacDiscoveryPass", () => {
  it("is skipped (touches nothing) with no gateway or with mode=off", async () => {
    const db = makeDb({ terminology_requests: [request()] });
    const a = await run(db, null).promise;
    expect(a.skipped).toBe("no-gateway");
    const gw = gateway({ retrieve: () => retrieval() });
    const b = await run(db, gw, "off").promise;
    expect(b.skipped).toBe("mode-off");
    expect(gw.retrieve).not.toHaveBeenCalled();
    expect(db.writes).toHaveLength(0);
  });

  it("stages the best match as an inert draft with provenance and routes the request to vsac_staged", async () => {
    const db = makeDb({ terminology_requests: [request()] });
    const gw = gateway({ retrieve: () => retrieval() });
    const { promise, logs } = run(db, gw);
    const s = await promise;

    expect(s).toMatchObject({
      scanned: 1,
      attempted: 1,
      staged: 1,
      previewed: 0,
      noMatch: 0,
      stopped: null,
    });
    const vs = db.tables.custom_value_sets;
    expect(vs).toHaveLength(1);
    expect(vs[0]).toMatchObject({
      status: "draft",
      oid: OID1,
      version: "20240601",
      steward: "NCQA",
    });
    expect(vs[0].provenance).toMatchObject({
      staged_by: "auto-terminologist",
      content_sha256: "ab".repeat(32),
    });

    const req = db.tables.terminology_requests[0];
    expect(req).toMatchObject({
      status: "vsac_staged",
      value_set_id: vs[0].id,
      quality_gate_notes: null,
    });
    expect(req.vsac_discovery_result).toMatchObject({
      outcome: "staged",
      chosen_oid: OID1,
      mode: "draft",
    });
    expect(req.vsac_discovery_result.considered[0]).toMatchObject({
      oid: OID1,
      outcome: "accepted",
    });

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      action: "vsac_auto_staged",
      bus: true,
      value_set_id: vs[0].id,
    });
    expect(logs[0].message).toContain("NOT published");
    expectGateIntact(db);
  });

  it("uses a catalog search when the request has no filed candidates, and retrieves only active, attributed, well-formed OIDs", async () => {
    const db = makeDb({ terminology_requests: [request({ known_vsac_candidates: null })] });
    const mk = (oid: string, over: Partial<VsacCandidate> = {}): VsacCandidate => ({
      oid,
      name: "EssentialHypertension",
      title: "Essential Hypertension",
      publisher: "NCQA",
      status: "active",
      version: null,
      ...over,
    });
    const gw = gateway({
      search: () => [
        mk(OID1),
        mk(OID2, { status: "retired" }),
        mk(OID3, { publisher: null }),
        mk("not-an-oid"),
      ],
      retrieve: () => retrieval(),
    });
    await run(db, gw).promise;
    expect(gw.search.mock.calls.map((c) => c[0])).toEqual([
      "Hypertension",
      "Hypertensive disorder",
    ]);
    expect(gw.retrieve.mock.calls.map((c) => c[0])).toEqual([OID1]);
    expectGateIntact(db);
  });

  it("a name-only hit never stages: it records the miss, bumps the attempt counter, and leaves the request pending", async () => {
    const db = makeDb({ terminology_requests: [request()] });
    const gw = gateway({ retrieve: () => retrieval({ codeList: [["12345678", "SNOMED CT"]] }) });
    const { promise, logs } = run(db, gw);
    const s = await promise;
    expect(s).toMatchObject({ staged: 0, noMatch: 1 });
    expect(db.tables.custom_value_sets ?? []).toHaveLength(0);
    const req = db.tables.terminology_requests[0];
    expect(req).toMatchObject({ status: "pending", vsac_discovery_attempts: 1 });
    expect(req.vsac_discovery_at).toBeTruthy();
    expect(req.vsac_discovery_result).toMatchObject({ outcome: "no_match" });
    expect(logs[0].action).toBe("vsac_no_match");
    expectGateIntact(db);
  });

  it("treats an unprovable (incomplete) expansion as a rejection of that candidate, never a partial stage", async () => {
    const db = makeDb({ terminology_requests: [request()] });
    const gw = gateway({
      retrieve: () => {
        throw new VsacError("incomplete", "Incomplete expansion: received 2 of 50 codes");
      },
    });
    const s = await run(db, gw).promise;
    expect(s).toMatchObject({ staged: 0, noMatch: 1 });
    const considered = db.tables.terminology_requests[0].vsac_discovery_result.considered;
    expect(considered[0]).toMatchObject({ outcome: "error" });
    expect(considered[0].reason).toContain("incomplete");
    expect(db.tables.custom_value_sets ?? []).toHaveLength(0);
  });

  it("will not create a duplicate of an OID the library already holds; it annotates the request and stops retrying", async () => {
    const db = makeDb({
      terminology_requests: [request()],
      custom_value_sets: [
        { id: "existing", oid: OID1, name: "Hypertension (mine)", status: "published" },
      ],
    });
    const gw = gateway({ retrieve: () => retrieval() });
    const { promise, logs } = run(db, gw);
    const s = await promise;
    expect(s).toMatchObject({ staged: 0, alreadyInLibrary: 1 });
    expect(db.tables.custom_value_sets).toHaveLength(1);
    expect(db.writes.filter((w: Write) => w.table === "custom_value_sets")).toHaveLength(0);
    const req = db.tables.terminology_requests[0];
    expect(req.vsac_discovery_attempts).toBe(MAX_DISCOVERY_ATTEMPTS);
    expect(req.quality_gate_notes).toContain("already exists");
    expect(logs[0].action).toBe("vsac_already_in_library");
  });

  it("preview mode writes nothing to custom_value_sets — it stages a provenance-stamped preview for the human Import Now click", async () => {
    const db = makeDb({ terminology_requests: [request()] });
    const gw = gateway({ retrieve: () => retrieval() });
    const { promise, logs } = run(db, gw, "preview");
    const s = await promise;
    expect(s).toMatchObject({ staged: 0, previewed: 1 });
    expect(db.writes.filter((w: Write) => w.table === "custom_value_sets")).toHaveLength(0);
    const req = db.tables.terminology_requests[0];
    expect(req.status).toBe("ready_to_import");
    expect(req.vsac_expansion_preview).toMatchObject({ oid: OID1, total: 2 });
    expect(req.vsac_expansion_preview.provenance).toMatchObject({
      staged_by: "auto-terminologist",
      stage_mode: "preview",
    });
    expect(logs[0].action).toBe("vsac_auto_previewed");
    expectGateIntact(db);
  });

  it("falls back to a preview when the draft insert fails, rather than losing the find", async () => {
    const db = makeDb({ terminology_requests: [request()] }, { failCustomValueSetInsert: true });
    const gw = gateway({ retrieve: () => retrieval() });
    const { promise, logs } = run(db, gw);
    const s = await promise;
    expect(s).toMatchObject({ staged: 0, previewed: 1 });
    expect(db.tables.terminology_requests[0].status).toBe("ready_to_import");
    expect(logs[0].message).toContain("draft insert failed");
  });

  it("halts the whole pass on an auth failure without penalising the request or touching the DB", async () => {
    const db = makeDb({
      terminology_requests: [
        request({ id: "a" }),
        request({ id: "b", requested_at: "2026-11-21T00:00:00Z" }),
      ],
    });
    const gw = gateway({
      retrieve: () => {
        throw new VsacError("auth", "VSAC rejected the UMLS key (HTTP 401)");
      },
    });
    const { promise, logs } = run(db, gw);
    const s = await promise;
    expect(s.stopped).toBe("auth");
    expect(gw.retrieve).toHaveBeenCalledTimes(1); // second request never attempted
    expect(db.writes).toHaveLength(0);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ action: "vsac_error" });
    expect(logs[0].message).toContain("UMLS");
  });

  it("a rate limit pauses the pass and does not burn a retry attempt", async () => {
    const db = makeDb({ terminology_requests: [request()] });
    const gw = gateway({
      retrieve: () => {
        throw new VsacError("rate_limited", "429", { retryAfterMs: 600_000 });
      },
    });
    const s = await run(db, gw).promise;
    expect(s.stopped).toBe("rate_limited");
    expect(db.tables.terminology_requests[0].vsac_discovery_attempts).toBe(0);
    expect(db.writes).toHaveLength(0);
  });

  it("a transient VSAC failure is not evidence of 'no match': no verdict, no attempt used, request parked", async () => {
    const db = makeDb({ terminology_requests: [request()] });
    const gw = gateway({
      retrieve: () => {
        throw new VsacError("transient", "VSAC server error (HTTP 503)");
      },
    });
    const s = await run(db, gw).promise;
    expect(s).toMatchObject({ errors: 1, noMatch: 0, staged: 0, stopped: null });
    // Nothing near the library, and no verdict on the request (attempts untouched)…
    expect(db.writes.filter((w: Write) => w.table === "custom_value_sets")).toHaveLength(0);
    const upd = db.writes.filter((w: Write) => w.table === "terminology_requests");
    expect(upd).toHaveLength(1);
    expect(upd[0].payload).not.toHaveProperty("vsac_discovery_attempts");
    expect(upd[0].payload).not.toHaveProperty("vsac_discovery_at");
    // …but it is remembered, so it cannot keep winning the head of the queue.
    expect(upd[0].payload.vsac_discovery_result).toMatchObject({
      outcome: "transient_error",
      transient_count: 1,
      retry_after_minutes: 30,
    });
    expect(db.tables.terminology_requests[0].status).toBe("pending");
  });

  it("a request that just flaked sits out its cooldown (doubling, capped), then is tried again", async () => {
    expect(transientCooldownMs(0)).toBe(0);
    expect(transientCooldownMs(1)).toBe(30 * 60_000);
    expect(transientCooldownMs(2)).toBe(60 * 60_000);
    expect(transientCooldownMs(20)).toBe(TRANSIENT_COOLDOWN_MAX_MS);

    const t0 = freshNow()();
    const at = (min: number) => () => t0 + min * 60_000;
    const flaky = {
      outcome: "transient_error",
      transient_count: 1,
      at: new Date(t0).toISOString(),
    };
    const db = makeDb({
      terminology_requests: [request({ vsac_discovery_result: flaky })],
    });
    const gw = gateway({ retrieve: () => retrieval() });
    const log = async () => {};

    const early = await runVsacDiscoveryPass(db, gw, { mode: "draft", log, now: at(10) });
    expect(early).toMatchObject({ scanned: 0, attempted: 0 });
    expect(gw.retrieve).not.toHaveBeenCalled();

    const later = await runVsacDiscoveryPass(db, gw, { mode: "draft", log, now: at(31) });
    expect(later).toMatchObject({ scanned: 1, staged: 1 });
  });

  it("one flaky request does not starve the others queued behind it", async () => {
    const db = makeDb({
      terminology_requests: [
        request({
          id: "flaky",
          priority: "urgent",
          known_vsac_candidates: [
            { oid: OID2, name: "Cardiac", title: "Cardiac", publisher: "NCQA" },
          ],
        }),
        request({ id: "fine", requested_name: 'Condition coverage for "Hypertension 2"' }),
      ],
    });
    const gw = gateway({
      retrieve: (oid) => {
        if (oid === OID2) throw new VsacError("transient", "HTTP 503");
        return retrieval();
      },
    });
    const first = await run(db, gw).promise;
    // The flaky urgent request neither blocked nor stopped the healthy one behind it…
    expect(first).toMatchObject({ attempted: 2, staged: 1, errors: 1, stopped: null });
    expect(db.tables.terminology_requests.find((r: Row) => r.id === "fine").status).toBe(
      "vsac_staged",
    );
    // …and it is parked (no attempt used), so it will not win the next cycle's queue head either.
    const flaky = db.tables.terminology_requests.find((r: Row) => r.id === "flaky");
    expect(flaky.status).toBe("pending");
    expect(flaky.vsac_discovery_attempts).toBe(0);
    expect(flaky.vsac_discovery_result.outcome).toBe("transient_error");
  });

  it("a mix of one transient error and one rejection is still not a 'no match'", async () => {
    const cands = [OID1, OID2].map((oid) => ({
      oid,
      name: "EssentialHypertension",
      title: "Essential Hypertension",
      publisher: "NCQA",
    }));
    const db = makeDb({ terminology_requests: [request({ known_vsac_candidates: cands })] });
    const gw = gateway({
      retrieve: (oid) => {
        if (oid === OID1) throw new VsacError("transient", "HTTP 502");
        return retrieval({ oid, codeList: [["99999", "SNOMED CT"]] }); // lacks the seed code
      },
    });
    const logs: any[] = [];
    const s = await runVsacDiscoveryPass(db, gw, {
      mode: "draft",
      log: async (e) => void logs.push(e),
      now: freshNow(),
    });
    expect(s).toMatchObject({ noMatch: 0, staged: 0, errors: 1 });
    expect(db.tables.terminology_requests[0].vsac_discovery_attempts).toBe(0);
    expect(logs.some((l) => l.action === "vsac_no_match")).toBe(false);
  });

  it("a rejected-only outcome is a real 'no match' and says what actually happened", async () => {
    const db = makeDb({ terminology_requests: [request()] });
    const gw = gateway({
      retrieve: (oid) => retrieval({ oid, codeList: [["99999", "SNOMED CT"]] }),
    });
    const logs: any[] = [];
    const s = await runVsacDiscoveryPass(db, gw, {
      mode: "draft",
      log: async (e) => void logs.push(e),
      now: freshNow(),
    });
    expect(s.noMatch).toBe(1);
    const msg = logs.find((l) => l.action === "vsac_no_match").message as string;
    expect(msg).toContain("1 candidate(s) checked");
    expect(msg).toContain("1 did not pass grading");
    expect(msg).not.toContain("could not be verified");
    expect(db.tables.terminology_requests[0].vsac_discovery_attempts).toBe(1);
  });

  it("a failed catalog search is likewise not a verdict, and is parked too", async () => {
    const db = makeDb({ terminology_requests: [request({ known_vsac_candidates: null })] });
    const gw = gateway({
      search: () => {
        throw new VsacError("transient", "VSAC unreachable");
      },
      retrieve: () => retrieval(),
    });
    const s = await run(db, gw).promise;
    expect(s.errors).toBe(1);
    expect(gw.retrieve).not.toHaveBeenCalled();
    const upd = db.writes.filter((w: Write) => w.table === "terminology_requests");
    expect(upd).toHaveLength(1);
    expect(upd[0].payload).not.toHaveProperty("vsac_discovery_attempts");
    expect(upd[0].payload.vsac_discovery_result.outcome).toBe("transient_error");
  });

  it("a catalog search VSAC REFUSES (not a flake) costs the request an attempt, is logged once, and pauses searching", async () => {
    const db = makeDb({
      terminology_requests: [
        request({ id: "a", known_vsac_candidates: null }),
        request({
          id: "b",
          requested_name: 'Condition coverage for "Asthma"',
          known_vsac_candidates: null,
        }),
      ],
    });
    const gw = gateway({
      search: () => {
        throw new VsacError("bad_request", "VSAC rejected the search (HTTP 400)");
      },
      retrieve: () => retrieval(),
    });
    const logs: any[] = [];
    const s = await runVsacDiscoveryPass(db, gw, {
      mode: "draft",
      log: async (e) => void logs.push(e),
      now: freshNow(),
    });
    const a = db.tables.terminology_requests.find((r: Row) => r.id === "a");
    const b = db.tables.terminology_requests.find((r: Row) => r.id === "b");
    expect(a.vsac_discovery_attempts).toBe(1);
    expect(a.vsac_discovery_result.outcome).toBe("search_error");
    // The second request never even tried: VSAC refuses every search, so don't hammer it.
    expect(gw.search).toHaveBeenCalledTimes(1);
    expect(b.vsac_discovery_attempts).toBe(0);
    expect(s.errors).toBe(1);
    expect(logs.filter((l) => l.action === "vsac_error")).toHaveLength(1);
  });

  it("falls back to a catalog search when none of the filed VSAC candidates is usable", async () => {
    const db = makeDb({
      terminology_requests: [
        request({
          known_vsac_candidates: [
            { oid: OID2, name: "Retired", title: "Retired", publisher: null, status: "retired" },
          ],
        }),
      ],
    });
    const gw = gateway({
      search: () => [
        {
          oid: OID1,
          name: "EssentialHypertension",
          title: "Essential Hypertension",
          publisher: "NCQA",
          status: "active",
        } as VsacCandidate,
      ],
      retrieve: (oid) => retrieval({ oid }),
    });
    const s = await run(db, gw).promise;
    expect(gw.search).toHaveBeenCalled();
    expect(s.staged).toBe(1);
    expect(db.tables.terminology_requests[0].vsac_discovery_result.source_of_candidates).toBe(
      "catalog_search",
    );
  });

  it("stops at its own time budget, leaves unattempted requests untouched, and says why", async () => {
    let t = freshNow()();
    const db = makeDb({
      terminology_requests: [
        request({ id: "a" }),
        request({ id: "b", requested_name: 'Condition coverage for "Asthma"' }),
      ],
    });
    const gw = gateway({
      retrieve: (oid) => {
        t += 30_000; // each VSAC round trip "takes" 30s
        return retrieval({ oid });
      },
    });
    const logs: any[] = [];
    const s = await runVsacDiscoveryPass(db, gw, {
      mode: "draft",
      log: async (e) => void logs.push(e),
      now: () => t,
      deadlineMs: 20_000,
    });
    expect(s.stopped).toBe("deadline");
    expect(s.staged).toBe(1); // the first request finished…
    const b = db.tables.terminology_requests.find((r: Row) => r.id === "b");
    expect(b.status).toBe("pending"); // …the second was never started
    expect(b.vsac_discovery_attempts).toBe(0);
    expect(logs.some((l) => l.action === "vsac_error" && /time budget/.test(l.message))).toBe(true);
  });

  it("does not propose again a value set a steward already deleted for this same request", async () => {
    const cands = [OID1, OID2].map((oid) => ({
      oid,
      name: "EssentialHypertension",
      title: "Essential Hypertension",
      publisher: "NCQA",
    }));
    const db = makeDb({
      terminology_requests: [
        request({ id: "new", known_vsac_candidates: cands }),
        // an earlier incarnation of the same gap whose staged OID1 draft a steward deleted
        {
          id: "old",
          requesting_consumer: "Auto Terminologist · Proactive Sweep",
          requested_name: 'Condition coverage for "Hypertension"',
          status: "rejected",
          vsac_discovery_result: { outcome: "withdrawn", chosen_oid: OID1 },
        },
      ],
    });
    const gw = gateway({ retrieve: (oid) => retrieval({ oid }) });
    await run(db, gw).promise;
    expect(gw.retrieve).toHaveBeenCalledTimes(1);
    expect(gw.retrieve).toHaveBeenCalledWith(OID2);
    const draft = db.tables.custom_value_sets.find((r: Row) => r.provenance?.staged_by);
    expect(draft.oid).toBe(OID2);
  });

  it("a candidate whose OID is already in the library is never retrieved or re-staged", async () => {
    const db = makeDb({
      terminology_requests: [request()],
      custom_value_sets: [
        { id: "vs-existing", name: "Hypertension (curated)", status: "published", oid: OID1 },
      ],
    });
    const gw = gateway({ retrieve: (oid) => retrieval({ oid }) });
    const s = await run(db, gw).promise;
    expect(gw.retrieve).not.toHaveBeenCalled();
    expect(s).toMatchObject({ alreadyInLibrary: 1, staged: 0 });
    expect(db.tables.terminology_requests[0].vsac_discovery_result.outcome).toBe(
      "already_in_library",
    );
  });

  it("only works requests that are pending, unlinked, 'create', gradeable, under the attempt cap and past their cooldown", async () => {
    const nowFn = freshNow();
    const t = nowFn();
    const ago = (h: number) => new Date(t - h * 3_600_000).toISOString();
    const db = makeDb({
      terminology_requests: [
        request({ id: "no-seeds", seed_codes: [] }),
        request({ id: "deprecate", request_type: "deprecate" }),
        request({ id: "exhausted", vsac_discovery_attempts: 3 }),
        request({ id: "cooling", vsac_discovery_attempts: 1, vsac_discovery_at: ago(1) }),
        request({ id: "ready", vsac_discovery_attempts: 1, vsac_discovery_at: ago(25) }),
        request({ id: "linked", linked_vsac_oid: OID2 }),
        request({ id: "umls", status: "umls-suggested" }),
        request({ id: "unknown-vocab", vocabulary: "", seed_codes: [{ code: "1", display: "x" }] }),
      ],
    });
    const gw = gateway({ retrieve: () => retrieval({ codeList: [["1", "SNOMED CT"]] }) });
    const logs: any[] = [];
    const s = await runVsacDiscoveryPass(db, gw, {
      mode: "draft",
      log: async (e) => void logs.push(e),
      now: nowFn,
    });
    expect(s).toMatchObject({ scanned: 1, attempted: 1 });
    const touched = db.writes
      .filter((w: Write) => w.table === "terminology_requests")
      .map((w: Write) => w.eq.find(([c]) => c === "id")?.[1]);
    expect(touched).toEqual(["ready"]);
  });

  it("works at most one batch per cycle, urgent first, then by how often the gap recurred", async () => {
    const db = makeDb({
      terminology_requests: [
        request({ id: "low", priority: "low" }),
        request({ id: "normal-1x", priority: "normal", occurrence_count: 1 }),
        request({ id: "normal-9x", priority: "normal", occurrence_count: 9 }),
        request({ id: "urgent", priority: "urgent" }),
        request({ id: "high", priority: "high" }),
      ],
    });
    const gw = gateway({ retrieve: () => retrieval({ codeList: [["1", "SNOMED CT"]] }) });
    const s = await run(db, gw).promise;
    expect(s).toMatchObject({ scanned: 5, attempted: 3 });
    const order = db.writes
      .filter((w: Write) => w.table === "terminology_requests")
      .map((w: Write) => w.eq.find(([c]) => c === "id")?.[1]);
    expect(order).toEqual(["urgent", "high", "normal-9x"]);
  });

  it("retrieves at most three candidates per request, then picks the best of ALL of them (no first-match shortcut)", async () => {
    const cands = [OID1, OID2, OID3, "2.16.840.1.113883.3.464.1003.101.12.1004"].map((oid) => ({
      oid,
      name: "EssentialHypertension",
      title: "Essential Hypertension",
      publisher: "NCQA",
    }));
    const db = makeDb({ terminology_requests: [request({ known_vsac_candidates: cands })] });
    // The first candidate is a perfect but large match; a later one is the same but far smaller
    // (more specific). A first-match shortcut would stage the large one.
    const gw = gateway({
      retrieve: (oid) =>
        oid === OID1
          ? retrieval({
              oid,
              codeList: [
                ["38341003", "SNOMED CT"],
                ...Array.from({ length: 40 }, (_, i) => [`9${i}`, "SNOMED CT"] as [string, string]),
              ],
            })
          : retrieval({ oid }),
    });
    await run(db, gw).promise;
    expect(gw.retrieve).toHaveBeenCalledTimes(3); // capped at three, none skipped
    const draft = db.tables.custom_value_sets.find((r: Row) => r.provenance?.staged_by);
    expect(draft.oid).not.toBe(OID1);
    expect(draft.codes).toHaveLength(2);
  });

  it("when several qualify, stages the best-ranked one and records the others it considered", async () => {
    const cands = [OID1, OID2].map((oid) => ({
      oid,
      name: "Cardiac",
      title: "Cardiac",
      publisher: "NCQA",
    }));
    const db = makeDb({ terminology_requests: [request({ known_vsac_candidates: cands })] });
    const gw = gateway({
      retrieve: (oid) =>
        oid === OID1
          ? retrieval({
              oid,
              codeList: [
                ["38341003", "SNOMED CT"],
                ...Array.from(
                  { length: 50 },
                  (_, i) => [String(i), "SNOMED CT"] as [string, string],
                ),
              ],
              name: "Cardiac",
              title: "Cardiac",
            })
          : retrieval({
              oid,
              codeList: [
                ["38341003", "SNOMED CT"],
                ["2", "SNOMED CT"],
              ],
              name: "Cardiac",
              title: "Cardiac",
            }),
    });
    await run(db, gw).promise;
    expect(db.tables.custom_value_sets[0].oid).toBe(OID2); // smaller = more specific
    expect(db.tables.terminology_requests[0].vsac_discovery_result.considered).toHaveLength(2);
    expectGateIntact(db);
  });
});

/* ---------------- closing the loop on staged requests ---------------- */

describe("reconcileStagedRequests", () => {
  const staged = (over: Row = {}) =>
    request({
      id: "s1",
      status: "vsac_staged",
      value_set_id: "vs-9",
      vsac_discovery_result: { outcome: "staged", chosen_oid: OID1 },
      ...over,
    });

  it("resolves the request once a steward has PUBLISHED its draft — publishing is the only human step", async () => {
    const db = makeDb({
      terminology_requests: [staged()],
      custom_value_sets: [
        { id: "vs-9", name: "Essential Hypertension", status: "published", oid: OID1 },
      ],
    });
    const logs: any[] = [];
    const r = await reconcileStagedRequests(db, async (e) => void logs.push(e), freshNow());
    expect(r).toEqual({ resolved: 1, withdrawn: 0 });
    expect(db.tables.terminology_requests[0]).toMatchObject({
      status: "resolved",
      value_set_id: "vs-9",
    });
    expect(db.tables.terminology_requests[0].resolved_at).toBeTruthy();
    expect(logs[0]).toMatchObject({
      action: "vsac_staged_resolved",
      value_set_id: "vs-9",
      bus: true,
    });
    expect(db.writes.filter((w: Write) => w.table === "custom_value_sets")).toHaveLength(0);
  });

  it("leaves the request alone while the draft is still draft / in review", async () => {
    for (const status of ["draft", "review", "deprecation-suggested"]) {
      const db = makeDb({
        terminology_requests: [staged()],
        custom_value_sets: [{ id: "vs-9", name: "x", status }],
      });
      const r = await reconcileStagedRequests(db, async () => {}, freshNow());
      expect(r).toEqual({ resolved: 0, withdrawn: 0 });
      expect(db.writes).toHaveLength(0);
      expect(db.tables.terminology_requests[0].status).toBe("vsac_staged");
    }
  });

  it("a deleted draft whose request has since been re-filed (23505) closes in favour of the newer request instead of failing", async () => {
    const db = makeDb({
      terminology_requests: [staged()],
      custom_value_sets: [],
    });
    const realFrom = db.from;
    db.from = (t: string) => {
      const q = realFrom(t);
      if (t === "terminology_requests") {
        const update = q.update.bind(q);
        q.update = (p: any) => {
          if (p.status === "pending") {
            // re-opening would collide with the newer pending request (partial unique index)
            q.then = (res: any) =>
              Promise.resolve({ data: null, error: { code: "23505", message: "duplicate" } }).then(
                res,
              );
            return q;
          }
          return update(p);
        };
      }
      return q;
    };
    const logs: any[] = [];
    const r = await reconcileStagedRequests(db, async (e) => void logs.push(e), freshNow());
    expect(r).toEqual({ resolved: 0, withdrawn: 1 });
    const row = db.tables.terminology_requests[0];
    expect(row.status).toBe("rejected");
    // the withdrawn OID stays on record so the newer request is not offered the same set again
    expect(row.vsac_discovery_result).toMatchObject({ outcome: "withdrawn", chosen_oid: OID1 });
    expect(logs[0].message).toMatch(/newer pending request/);
  });

  it("a DELETED draft re-opens the request for a human and can never be re-staged in a loop", async () => {
    const db = makeDb({ terminology_requests: [staged()], custom_value_sets: [] });
    const logs: any[] = [];
    const r = await reconcileStagedRequests(db, async (e) => void logs.push(e), freshNow());
    expect(r).toEqual({ resolved: 0, withdrawn: 1 });
    const req = db.tables.terminology_requests[0];
    expect(req).toMatchObject({
      status: "pending",
      value_set_id: null,
      vsac_discovery_attempts: MAX_DISCOVERY_ATTEMPTS,
    });
    expect(req.quality_gate_notes).toContain("deleted by a steward");
    expect(req.vsac_discovery_result).toMatchObject({ outcome: "withdrawn", chosen_oid: OID1 });
    expect(logs[0].action).toBe("vsac_stage_withdrawn");

    // …and the discovery pass will not pick it up again.
    const gw = gateway({ retrieve: () => retrieval() });
    const s = await run(db, gw).promise;
    expect(s.scanned).toBe(0);
    expect(gw.retrieve).not.toHaveBeenCalled();
  });

  it("does nothing when the library can't be read (unreadable is not 'deleted')", async () => {
    const db = makeDb({ terminology_requests: [staged()] });
    const realFrom = db.from.bind(db);
    db.from = (t: string) => {
      const q = realFrom(t);
      if (t === "custom_value_sets") {
        const then = q.then.bind(q);
        q.then = (res: any, rej: any) =>
          then(() => res({ data: null, error: { message: "boom" } }), rej);
      }
      return q;
    };
    const r = await reconcileStagedRequests(db, async () => {}, freshNow());
    expect(r).toEqual({ resolved: 0, withdrawn: 0 });
    expect(db.writes).toHaveLength(0);
  });

  it("only touches requests that are still 'vsac_staged' (guarded update)", async () => {
    const db = makeDb({
      terminology_requests: [
        staged({ id: "a" }),
        staged({ id: "b", status: "resolved" }),
        staged({ id: "c", status: "pending" }),
      ],
      custom_value_sets: [{ id: "vs-9", name: "x", status: "published" }],
    });
    const r = await reconcileStagedRequests(db, async () => {}, freshNow());
    expect(r.resolved).toBe(1);
    expect(db.tables.terminology_requests.map((x: Row) => x.status)).toEqual([
      "resolved",
      "resolved",
      "pending",
    ]);
  });

  it("counts and logs only rows it actually changed (a request another runner already closed is skipped)", async () => {
    const db = makeDb({
      terminology_requests: [staged()],
      custom_value_sets: [{ id: "vs-9", name: "x", status: "published" }],
    });
    // Between reconcile's read of the requests and its guarded update, someone else resolves it.
    const realFrom = db.from.bind(db);
    db.from = (t: string) => {
      const q = realFrom(t);
      if (t === "custom_value_sets") {
        const then = q.then.bind(q);
        q.then = (res: any, rej: any) =>
          then((v: any) => {
            db.tables.terminology_requests[0].status = "resolved";
            return res(v);
          }, rej);
      }
      return q;
    };
    const logs: any[] = [];
    const r = await reconcileStagedRequests(db, async (e) => void logs.push(e), freshNow());
    expect(r).toEqual({ resolved: 0, withdrawn: 0 });
    expect(logs).toHaveLength(0);
  });

  it("runs inside the pass even with no gateway or mode=off (housekeeping needs no VSAC)", async () => {
    const mk = () =>
      makeDb({
        terminology_requests: [staged()],
        custom_value_sets: [{ id: "vs-9", name: "x", status: "published" }],
      });
    const a = mk();
    const sa = await run(a, null).promise;
    expect(sa).toMatchObject({ skipped: "no-gateway", reconciledResolved: 1 });
    const b = mk();
    const sb = await run(b, gateway({ retrieve: () => retrieval() }), "off").promise;
    expect(sb).toMatchObject({ skipped: "mode-off", reconciledResolved: 1 });
  });

  it("the full lifecycle: stage as draft → steward publishes → next cycle resolves the request", async () => {
    const db = makeDb({ terminology_requests: [request()] });
    const gw = gateway({ retrieve: () => retrieval() });
    await run(db, gw).promise;
    expect(db.tables.terminology_requests[0].status).toBe("vsac_staged");
    expect(db.tables.custom_value_sets[0].status).toBe("draft");

    // the human gate: ONLY a steward does this (the test plays the steward)
    db.tables.custom_value_sets[0].status = "published";

    const s2 = await run(db, gw).promise;
    expect(s2.reconciledResolved).toBe(1);
    expect(db.tables.terminology_requests[0].status).toBe("resolved");
    // the engine itself never wrote anything but the one draft insert
    expectGateIntact(db);
  });
});

/* ---------------- through the real cycle ---------------- */

describe("runAutoTerminologistCycle integration", () => {
  it("discovery runs BEFORE the demand pass: a request VSAC satisfies never reaches UMLS/self-authoring", async () => {
    const db = makeDb({ terminology_requests: [request()] });
    const gw = gateway({ retrieve: () => retrieval() });
    const summary = await runAutoTerminologistCycle(db, "test-holder", {
      vsac: gw,
      vsacStageMode: "draft",
    });

    expect(summary.ran).toBe(true);
    expect(summary.vsacDiscovery).toMatchObject({ staged: 1 });
    expect(summary.demand?.scanned).toBe(0); // already left 'pending'
    expect(db.functions.invoke).not.toHaveBeenCalled(); // no UMLS-first search was triggered
    expect(db.tables.custom_value_sets).toHaveLength(1);
    expect(db.tables.custom_value_sets[0].status).toBe("draft");
    expectGateIntact(db);

    const watchdog = db.writes.find((w: Write) => w.table === "automation_watchdog_logs")!;
    expect(watchdog.payload.engines_checked.auto_terminologist.vsac_discovery).toMatchObject({
      staged: 1,
    });
    const activity = db.writes
      .filter((w: Write) => w.table === "auto_terminologist_log")
      .map((w: Write) => w.payload.action);
    expect(activity).toContain("vsac_auto_staged");
    expect(activity).toContain("cycle_summary"); // a staged draft counts as cycle activity, not a heartbeat
    expect(
      db.writes.some(
        (w: Write) =>
          w.table === "terminology_activity_log" && w.payload.action === "vsac_auto_staged",
      ),
    ).toBe(true);
  });

  it("without a gateway (the browser tab path) the step reports itself skipped and writes nothing", async () => {
    const db = makeDb({ terminology_requests: [] });
    const summary = await runAutoTerminologistCycle(db, "tab-holder");
    expect(summary.ran).toBe(true);
    expect(summary.vsacDiscovery?.skipped).toBe("no-gateway");
    expect(db.writes.filter((w: Write) => w.table === "custom_value_sets")).toHaveLength(0);
  });
});

describe("grading: vocabulary allow-list and inactive codes", () => {
  it("only grades seeds in a vocabulary VSAC can be matched on", () => {
    const seeds = [
      { code: "38341003", display: "x", vocabulary: "SNOMED CT" },
      { code: "401.9", display: "x", vocabulary: "ICD-9-CM" }, // not a VSAC-matchable family here
      { code: "I10", display: "x", vocabulary: "ICD-10-CM" },
      { code: "123", display: "x", vocabulary: "Local Hospital Codes" },
      { code: "4850", display: "x", vocabulary: "LOINC" },
      { code: "7980", display: "x", vocabulary: "RxNorm" },
      { code: "99213", display: "x", vocabulary: "CPT" },
      { code: "5", display: "x", vocabulary: "" },
    ];
    expect(gradeableSeeds(seeds).map((s) => s.code)).toEqual([
      "38341003",
      "I10",
      "4850",
      "7980",
      "99213",
    ]);
  });

  it("an unmatchable seed does not drag coverage down (it is not counted in the denominator)", () => {
    const g = gradeRetrieval({
      seeds: [
        { code: "38341003", display: "x", vocabulary: "SNOMED CT" },
        { code: "401.9", display: "x", vocabulary: "ICD-9-CM" },
      ],
      retrieval: retrieval(),
      termTokens: ["hypertension"],
    });
    expect(g.seedTotal).toBe(1);
    expect(g.coverage).toBe(1);
    expect(g.accepted).toBe(true);
  });

  it("a code VSAC marks inactive is not coverage of the live seed code", () => {
    const r = retrieval();
    r.codes[0] = { ...r.codes[0], inactive: true }; // 38341003 retired in VSAC
    const g = gradeRetrieval({
      seeds: [{ code: "38341003", display: "x", vocabulary: "SNOMED CT" }],
      retrieval: r,
      termTokens: ["hypertension"],
    });
    expect(g.seedMatched).toBe(0);
    expect(g.accepted).toBe(false);
  });
});
