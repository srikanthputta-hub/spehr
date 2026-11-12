import { describe, expect, it, vi } from "vitest";
import { recommendDefinitionType, suggestedRootConceptForStorage } from "./value-set-registry";

/**
 * Tests for the 4 capabilities layered onto recommendDefinitionType():
 *   1. possible-existing-coverage check
 *   2. RxNorm product/dose-form -> ingredient normalization
 *   3. inclusion/exclusion (VSAC Purpose) prose + binding-strength table
 *   4. conservative "grouping" recommendation
 *
 * All UMLS/RxNav traffic and the published-value-set lookup are faked via
 * the injectable `client` param (functions.invoke + from) — no network, no
 * real Supabase project needed.
 */

type InvokeHandler = (action: string, params: Record<string, unknown>) => unknown;

function makeClient(opts: { invoke: InvokeHandler; publishedSets?: PublishedRow[] }) {
  const publishedSets = opts.publishedSets ?? [];
  return {
    functions: {
      invoke: vi.fn(
        async (
          _name: string,
          args: { body: { action: string; params: Record<string, unknown> } },
        ) => {
          const result = await opts.invoke(args.body.action, args.body.params);
          if (result instanceof Error) return { data: null, error: result };
          return { data: result, error: null };
        },
      ),
    },
    from: vi.fn((table: string) => ({
      select: vi.fn(() => ({
        eq: vi.fn((col: string, val: string) => {
          if (table === "custom_value_sets" && col === "status" && val === "published") {
            return Promise.resolve({ data: publishedSets, error: null });
          }
          return Promise.resolve({ data: [], error: null });
        }),
      })),
    })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

type PublishedRow = { id: string; name: string; oid: string | null; codes: unknown };

describe("recommendDefinitionType — capability 2: RxNorm ingredient normalization", () => {
  it("normalizes a product-level RxNorm candidate to its ingredient and keeps the original code for traceability", async () => {
    const client = makeClient({
      invoke: (action, params) => {
        if (action === "rxnormDetail" && params.rxcui === "861007") {
          return { properties: { tty: "SCD", name: "Amoxicillin 500 MG Oral Capsule" } };
        }
        if (action === "rxnormRelated" && params.rxcui === "861007" && params.tty === "IN") {
          return {
            relatedGroup: {
              conceptGroup: [
                { tty: "IN", conceptProperties: [{ rxcui: "723", name: "Amoxicillin" }] },
              ],
            },
          };
        }
        return null;
      },
    });

    const rec = await recommendDefinitionType(
      {
        vocabulary: "RxNorm",
        candidates: [{ code: "861007", display: "amoxicillin 500 MG Oral Capsule" }],
      },
      client,
    );

    expect(rec.recommendedType).toBe("extensional"); // RxNorm has no governed hierarchy in UMLS
    expect(rec.seedCodes).toEqual([
      { code: "861007", display: "amoxicillin 500 MG Oral Capsule", vocabulary: "RxNorm" },
    ]);
    expect(rec.reasoning).toContain("Normalized from product-level RxNorm 861007");
    expect(rec.reasoning).toContain("ingredient-level RxNorm 723 (Amoxicillin)");
    expect(rec.inclusionCriteria).toContain("ingredient (TTY=IN) level");
    expect(rec.exclusionCriteria).toContain("product-/dose-form-level RxNorm codes");
  });

  it("leaves an already-ingredient-level RxNorm candidate untouched (no normalization note)", async () => {
    const client = makeClient({
      invoke: (action, params) => {
        if (action === "rxnormDetail" && params.rxcui === "723") {
          return { properties: { tty: "IN", name: "Amoxicillin" } };
        }
        throw new Error(`unexpected call: ${action}`);
      },
    });

    const rec = await recommendDefinitionType(
      { vocabulary: "RxNorm", candidates: [{ code: "723", display: "Amoxicillin" }] },
      client,
    );

    expect(rec.reasoning).not.toContain("Normalized from");
    expect(rec.inclusionCriteria).not.toContain("ingredient (TTY=IN) level");
  });

  it("falls back to the original candidate (no crash) when RxNav calls fail", async () => {
    const client = makeClient({
      invoke: () => {
        throw new Error("network down");
      },
    });

    const rec = await recommendDefinitionType(
      { vocabulary: "RxNorm", candidates: [{ code: "861007", display: "some product" }] },
      client,
    );

    expect(rec.recommendedType).toBe("extensional");
    expect(rec.seedCodes[0]).toEqual({
      code: "861007",
      display: "some product",
      vocabulary: "RxNorm",
    });
  });

  it("leaves non-RxNorm vocabularies untouched (never calls rxnormDetail/rxnormRelated)", async () => {
    const invoke = vi.fn((_action: string, _params: Record<string, unknown>) => null);
    const client = makeClient({ invoke });
    await recommendDefinitionType(
      { vocabulary: "SNOMED CT", candidates: [{ code: "22298006", display: "MI" }] },
      client,
    );
    for (const call of invoke.mock.calls) {
      expect(call[0]).not.toBe("rxnormDetail");
      expect(call[0]).not.toBe("rxnormRelated");
    }
  });
});

describe("recommendDefinitionType — capability 1: possible existing coverage", () => {
  it("flags a strong code-overlap match against a published value set", async () => {
    const client = makeClient({
      invoke: () => null,
      publishedSets: [
        {
          id: "vs-1",
          name: "Some Existing Value Set",
          oid: "2.16.840.1.113883.3.555",
          codes: [{ code: "A1" }, { code: "A2" }, { code: "A3" }, { code: "A4" }, { code: "A5" }],
        },
      ],
    });

    const rec = await recommendDefinitionType(
      {
        vocabulary: "SNOMED CT",
        candidates: [
          { code: "A1", display: "c1" },
          { code: "A2", display: "c2" },
          { code: "A3", display: "c3" },
          { code: "A4", display: "c4" },
        ],
        requestedName: "Totally Different Name",
      },
      client,
    );

    expect(rec.possibleExistingMatch).not.toBeNull();
    expect(rec.possibleExistingMatch?.value_set_id).toBe("vs-1");
    expect(rec.possibleExistingMatch?.match_reason).toContain("4/4");
  });

  it("flags a strong fuzzy name match even with no code overlap", async () => {
    const client = makeClient({
      invoke: () => null,
      publishedSets: [
        { id: "vs-2", name: "Sulfonamide Allergy Clinical Findings", oid: "2.16.1", codes: [] },
      ],
    });

    const rec = await recommendDefinitionType(
      {
        vocabulary: "SNOMED CT",
        candidates: [],
        requestedName: 'sulfonamide allergy clinical findings"',
      },
      client,
    );

    expect(rec.possibleExistingMatch?.value_set_id).toBe("vs-2");
  });

  it("never blocks filing when no match is found", async () => {
    const client = makeClient({ invoke: () => null, publishedSets: [] });
    const rec = await recommendDefinitionType(
      { vocabulary: "SNOMED CT", candidates: [], requestedName: "Brand New Thing" },
      client,
    );
    expect(rec.possibleExistingMatch).toBeNull();
    expect(rec.recommendedType).toBe("extensional");
  });

  it("degrades gracefully (null match) when the published-sets lookup throws", async () => {
    const client = {
      functions: { invoke: vi.fn(async () => ({ data: null, error: null })) },
      from: vi.fn(() => {
        throw new Error("db unreachable");
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const rec = await recommendDefinitionType(
      { vocabulary: "SNOMED CT", candidates: [], requestedName: "Anything" },
      client,
    );
    expect(rec.possibleExistingMatch).toBeNull();
  });
});

describe("recommendDefinitionType — capability 3: VSAC Purpose fields + binding strength", () => {
  const cases: Array<{
    label: string;
    context: { clinicalApplication?: string; requestingConsumer?: string };
    expected: "required" | "extensible" | "preferred" | "example";
  }> = [
    {
      label: "Safety Alerts Engine",
      context: { requestingConsumer: "Safety Alerts Engine", clinicalApplication: "CDS" },
      expected: "required",
    },
    {
      label: "Auto Doc (CDS)",
      context: { requestingConsumer: "Auto Doc", clinicalApplication: "CDS" },
      expected: "preferred",
    },
    {
      label: "Auto Admin (Billing)",
      context: { requestingConsumer: "Auto Admin", clinicalApplication: "Billing" },
      expected: "extensible",
    },
    { label: "unclassified", context: {}, expected: "example" },
  ];

  for (const c of cases) {
    it(`maps ${c.label} -> ${c.expected}`, async () => {
      const client = makeClient({ invoke: () => null });
      const rec = await recommendDefinitionType(
        { vocabulary: "SNOMED CT", candidates: [], context: c.context },
        client,
      );
      expect(rec.recommendedBindingStrength).toBe(c.expected);
    });
  }

  it("Auto Doc's own CDS application doesn't get swept into Safety Alert's required binding", async () => {
    // Regression check for the consumer-before-application precedence rule.
    const client = makeClient({ invoke: () => null });
    const rec = await recommendDefinitionType(
      {
        vocabulary: "SNOMED CT",
        candidates: [],
        context: { requestingConsumer: "Auto Doc", clinicalApplication: "CDS" },
      },
      client,
    );
    expect(rec.recommendedBindingStrength).toBe("preferred");
  });

  it("derives Data Element Scope from vocabulary (RxNorm -> medication category)", async () => {
    const client = makeClient({
      invoke: (action, params) =>
        action === "rxnormDetail" ? { properties: { tty: "IN", name: "x" } } : null,
    });
    const rec = await recommendDefinitionType(
      {
        vocabulary: "RxNorm",
        candidates: [{ code: "723", display: "Amoxicillin" }],
        requestedName: "Antibiotics",
      },
      client,
    );
    expect(rec.dataElementScope).toBe("Medication, Administered or Medication, Order");
  });

  it("derives Data Element Scope from an allergy-shaped request name", async () => {
    const client = makeClient({ invoke: () => null });
    const rec = await recommendDefinitionType(
      { vocabulary: "SNOMED CT", candidates: [], requestedName: "Penicillin Allergy Findings" },
      client,
    );
    expect(rec.dataElementScope).toBe("Allergy, Intolerance, or Problem List");
  });

  it("defaults Data Element Scope to Diagnosis, Active when nothing more specific fits", async () => {
    const client = makeClient({ invoke: () => null });
    const rec = await recommendDefinitionType(
      { vocabulary: "SNOMED CT", candidates: [], requestedName: "Something Unclassified" },
      client,
    );
    expect(rec.dataElementScope).toBe("Diagnosis, Active");
  });

  it("leaves inclusionCriteria/exclusionCriteria blank only for grouping, filled otherwise", async () => {
    const client = makeClient({ invoke: () => null });
    const rec = await recommendDefinitionType(
      { vocabulary: "SNOMED CT", candidates: [], requestedName: "X" },
      client,
    );
    expect(rec.recommendedType).toBe("extensional");
    expect(rec.inclusionCriteria.length).toBeGreaterThan(0);
    expect(rec.exclusionCriteria.length).toBeGreaterThan(0);
    expect(rec.clinicalFocus.length).toBeGreaterThan(0);
  });
});

describe("recommendDefinitionType — capability 4: conservative grouping recommendation", () => {
  it("recommends grouping when the shared parent's children strongly match >=2 published value sets", async () => {
    const client = makeClient({
      invoke: (action, params) => {
        if (action === "hierarchyExpand" && params.operator === "parentOf") {
          return { codes: [{ code: "P1", name: "Parent Concept" }], count: 1, truncated: false };
        }
        if (action === "hierarchyExpand" && params.operator === "childOf" && params.code === "P1") {
          return {
            codes: [
              { code: "C1", name: "Child One Value Set" },
              { code: "C2", name: "Child Two Value Set" },
            ],
            count: 2,
            truncated: false,
          };
        }
        return null;
      },
      publishedSets: [
        { id: "vs-c1", name: "Child One Value Set", oid: "2.16.1", codes: [] },
        { id: "vs-c2", name: "Child Two Value Set", oid: "2.16.2", codes: [] },
      ],
    });

    const rec = await recommendDefinitionType(
      {
        vocabulary: "SNOMED CT",
        candidates: [
          { code: "A1", display: "a" },
          { code: "A2", display: "b" },
        ],
        requestedName: "Comprehensive Grouping",
      },
      client,
    );

    expect(rec.recommendedType).toBe("grouping");
    if (rec.recommendedType === "grouping") {
      expect(rec.componentValueSets.map((c) => c.value_set_id).sort()).toEqual(["vs-c1", "vs-c2"]);
      expect(rec.inclusionCriteria).toBe("");
      expect(rec.exclusionCriteria).toBe("");
      expect(rec.clinicalFocus.length).toBeGreaterThan(0);
      expect(rec.dataElementScope.length).toBeGreaterThan(0);
    }
    expect(rec.reasoning).toContain("Parent Concept");

    // suggestedRootConceptForStorage should carry componentValueSets
    // alongside the root code/display (documented jsonb-reuse shape).
    const stored = suggestedRootConceptForStorage(rec);
    expect(stored?.componentValueSets).toHaveLength(2);
    expect(stored?.code).toBe("P1");
  });

  it("falls through to the normal intensional/extensional logic when <2 children match", async () => {
    const client = makeClient({
      invoke: (action, params) => {
        if (action === "hierarchyExpand" && params.operator === "parentOf") {
          return { codes: [{ code: "P1", name: "Parent Concept" }], count: 1, truncated: false };
        }
        if (action === "hierarchyExpand" && params.operator === "childOf") {
          return {
            codes: [{ code: "C1", name: "Child One Value Set" }],
            count: 1,
            truncated: false,
          };
        }
        if (action === "hierarchyExpand" && params.operator === "descendantOrSelfOf") {
          return {
            codes: [
              { code: "P1", name: "Parent Concept" },
              { code: "A1", name: "a" },
              { code: "A2", name: "b" },
            ],
            count: 3,
            truncated: false,
          };
        }
        return null;
      },
      publishedSets: [{ id: "vs-c1", name: "Child One Value Set", oid: "2.16.1", codes: [] }],
    });

    const rec = await recommendDefinitionType(
      {
        vocabulary: "SNOMED CT",
        candidates: [
          { code: "A1", display: "a" },
          { code: "A2", display: "b" },
        ],
      },
      client,
    );

    expect(rec.recommendedType).toBe("intensional");
  });

  it("never recommends grouping for a single-candidate request (no shared-parent path at all)", async () => {
    const client = makeClient({
      invoke: (action, params) => {
        if (action === "hierarchyExpand" && params.operator === "descendantOrSelfOf") {
          return {
            codes: [
              { code: "A1", name: "a" },
              { code: "A2", name: "b" },
            ],
            count: 2,
            truncated: false,
          };
        }
        return null;
      },
      publishedSets: [
        { id: "vs-c1", name: "Child One Value Set", oid: "2.16.1", codes: [] },
        { id: "vs-c2", name: "Child Two Value Set", oid: "2.16.2", codes: [] },
      ],
    });
    const rec = await recommendDefinitionType(
      { vocabulary: "SNOMED CT", candidates: [{ code: "A1", display: "a" }] },
      client,
    );
    expect(rec.recommendedType).not.toBe("grouping");
  });
});

describe("recommendDefinitionType — Gap 1: external VSAC-catalog candidates", () => {
  it("surfaces active, steward-published vsacSearch candidates and mentions them in reasoning", async () => {
    const client = makeClient({
      invoke: (action, params) => {
        if (action === "vsacSearch") {
          expect(params.query).toBe("Penicillins");
          return {
            candidates: [
              {
                oid: "2.16.840.1.113883.3.464.1003.196.12.1001",
                name: "Penicillins",
                title: "Penicillins",
                publisher: "National Committee for Quality Assurance (NCQA)",
                status: "active",
              },
            ],
          };
        }
        return null;
      },
    });

    const rec = await recommendDefinitionType(
      {
        vocabulary: "SNOMED CT",
        candidates: [],
        requestedName: "Drug-Allergy coverage for Penicillins",
      },
      client,
    );

    expect(rec.knownVsacCandidates).toHaveLength(1);
    expect(rec.knownVsacCandidates?.[0]).toEqual({
      oid: "2.16.840.1.113883.3.464.1003.196.12.1001",
      name: "Penicillins",
      title: "Penicillins",
      publisher: "National Committee for Quality Assurance (NCQA)",
    });
    expect(rec.reasoning).toContain(
      "actively-published VSAC value set(s) from recognized steward(s)",
    );
    expect(rec.reasoning).toContain("NCQA");
  });

  it("filters out inactive and unpublished-by-no-steward candidates", async () => {
    const client = makeClient({
      invoke: (action) => {
        if (action === "vsacSearch") {
          return {
            candidates: [
              {
                oid: "1.1",
                name: "Retired One",
                title: null,
                publisher: "NCQA",
                status: "retired",
              },
              { oid: "1.2", name: "No Steward", title: null, publisher: null, status: "active" },
              {
                oid: "1.3",
                name: "No Steward Blank",
                title: null,
                publisher: "",
                status: "active",
              },
            ],
          };
        }
        return null;
      },
    });

    const rec = await recommendDefinitionType(
      { vocabulary: "SNOMED CT", candidates: [], requestedName: "Something" },
      client,
    );

    expect(rec.knownVsacCandidates).toEqual([]);
    expect(rec.reasoning).not.toContain("actively-published VSAC value set(s)");
  });

  it("never blocks filing when vsacSearch fails", async () => {
    const client = makeClient({
      invoke: (action) => {
        if (action === "vsacSearch") throw new Error("network down");
        return null;
      },
    });

    const rec = await recommendDefinitionType(
      { vocabulary: "SNOMED CT", candidates: [], requestedName: "Anything" },
      client,
    );

    expect(rec.knownVsacCandidates).toEqual([]);
    expect(rec.recommendedType).toBe("extensional");
  });
});

describe("buildVsacImportInsert — shared VSAC import payload (Gap 2)", () => {
  it("builds the same insert shape ValueSetLibrary's Import-from-VSAC dialog has always used", async () => {
    const { buildVsacImportInsert } = await import("./value-set-registry");
    const insert = buildVsacImportInsert(
      {
        oid: "2.16.1",
        name: "Test VS",
        title: "Test Value Set",
        total: 2,
        type: "extensional",
        codes: [
          { code: "A1", display: "a", vocabulary: "SNOMED CT" },
          { code: "A2", display: "b", vocabulary: "SNOMED CT" },
        ],
        publisher: "NCQA",
      },
      "My Imported Value Set",
    );

    expect(insert.name).toBe("My Imported Value Set");
    expect(insert.oid).toBe("2.16.1");
    expect(insert.vocabulary).toBe("SNOMED CT");
    expect(insert.status).toBe("draft");
    expect(insert.codes).toHaveLength(2);
    expect(insert.fhir_url).toBe("http://spehr.live/fhir/ValueSet/my-imported-value-set");
    expect(insert.change_history[0].change).toBe("Imported from VSAC");
  });

  it("falls back to a VSAC-OID-based name when no name is given", async () => {
    const { buildVsacImportInsert } = await import("./value-set-registry");
    const insert = buildVsacImportInsert(
      {
        oid: "2.16.2",
        name: null,
        title: null,
        total: 0,
        type: "extensional",
        codes: [],
        publisher: null,
      },
      "   ",
    );
    expect(insert.name).toBe("VSAC 2.16.2");
  });

  it("records the VSAC publisher as steward", async () => {
    const { buildVsacImportInsert } = await import("./value-set-registry");
    const insert = buildVsacImportInsert(
      {
        oid: "2.16.3",
        name: "Diabetes",
        title: "Diabetes",
        total: 1,
        type: "extensional",
        codes: [{ code: "D1", display: "d", vocabulary: "SNOMED CT" }],
        publisher: "NCQA",
      },
      "Diabetes",
    );
    expect(insert.steward).toBe("NCQA");
  });

  it("leaves steward null when VSAC reports no publisher", async () => {
    const { buildVsacImportInsert } = await import("./value-set-registry");
    const insert = buildVsacImportInsert(
      {
        oid: "2.16.4",
        name: "No Publisher",
        title: null,
        total: 0,
        type: "extensional",
        codes: [],
        publisher: null,
      },
      "No Publisher",
    );
    expect(insert.steward).toBeNull();
  });
});

describe("recommendDefinitionType — never throws", () => {
  it("degrades to extensional when every UMLS call fails", async () => {
    const client = makeClient({
      invoke: () => {
        throw new Error("boom");
      },
    });
    const rec = await recommendDefinitionType(
      { vocabulary: "SNOMED CT", candidates: [{ display: "some free text with no code" }] },
      client,
    );
    expect(rec.recommendedType).toBe("extensional");
    expect(rec.seedCodes).toEqual([]);
  });
});
