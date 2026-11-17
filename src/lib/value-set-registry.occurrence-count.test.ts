import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Tests for requestTerminologyUpdate()'s occurrence_count tracking
 * (src/lib/value-set-registry.ts): a real "how many times has this exact
 * gap actually been hit" counter, distinct from seed_codes.length, which
 * only grows when a genuinely new code shows up.
 *
 * requestTerminologyUpdate() always uses the singleton `supabase` client
 * (unlike recommendDefinitionType(), which takes an injectable client), so
 * this mocks "@/integrations/supabase/client" the same way
 * useAutoTerminologist.test.ts does for the same reason, then dynamically
 * imports the module under test so the mock is in place before
 * value-set-registry.ts's own top-level `import { supabase } from ...`
 * resolves.
 */

const fromMock = vi.fn();

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (...args: unknown[]) => fromMock(...args),
    // recommendDefinitionType() (called internally, with no client param so
    // it defaults to this mocked `supabase`) reaches for
    // functions.invoke() for every UMLS/VSAC lookup it attempts. Omitting
    // it here means those calls throw, which callUmlsProxy() in
    // value-set-registry.ts already catches and degrades to null/extensional
    // — exactly the "never blocks filing" behavior that module documents,
    // and irrelevant to what these tests check (the occurrence_count
    // bookkeeping, not the recommendation content).
  },
}));

const { requestTerminologyUpdate } = await import("./value-set-registry");

type SeedCode = { code: string; display?: string };
type ExistingRow = { id: string; seed_codes: SeedCode[]; occurrence_count: number | null } | null;

/**
 * Builds a fake `supabase.from()` covering exactly what requestTerminologyUpdate()
 * and the recommendDefinitionType() it calls internally touch:
 *  - custom_value_sets: only ever read (possible-existing-match check) —
 *    always empty here since that's not what's under test.
 *  - terminology_requests: insert() (conflicting or not, per `conflict`),
 *    the merge path's select().eq().eq().eq().maybeSingle() read (returning
 *    `existingRow`), and update().eq() (recorded into `updateCalls`).
 */
function makeFromMock(opts: {
  conflict: boolean;
  existingRow: ExistingRow;
  insertCalls: Array<Record<string, unknown>>;
  updateCalls: Array<Record<string, unknown>>;
}) {
  return vi.fn((table: string) => {
    if (table === "custom_value_sets") {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => Promise.resolve({ data: [], error: null })),
        })),
      };
    }
    if (table === "terminology_requests") {
      return {
        insert: vi.fn((payload: Record<string, unknown>) => {
          opts.insertCalls.push(payload);
          if (opts.conflict) {
            return Promise.resolve({
              error: { code: "23505", message: "duplicate key value" },
            });
          }
          return Promise.resolve({ error: null });
        }),
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                maybeSingle: vi.fn(() => Promise.resolve({ data: opts.existingRow })),
              })),
            })),
          })),
        })),
        update: vi.fn((payload: Record<string, unknown>) => {
          opts.updateCalls.push(payload);
          return { eq: vi.fn(() => Promise.resolve({ error: null })) };
        }),
      };
    }
    throw new Error(`unexpected table in test: ${table}`);
  });
}

const baseReq = {
  requesting_consumer: "Safety Alerts Engine",
  requested_name: 'Drug-Allergy coverage for "Penicillin"',
  justification: "test",
};

describe("requestTerminologyUpdate — occurrence_count", () => {
  beforeEach(() => {
    fromMock.mockReset();
  });

  it("files a fresh pending request with occurrence_count: 1", async () => {
    const insertCalls: Array<Record<string, unknown>> = [];
    const updateCalls: Array<Record<string, unknown>> = [];
    fromMock.mockImplementation(
      makeFromMock({ conflict: false, existingRow: null, insertCalls, updateCalls }),
    );

    await requestTerminologyUpdate({
      ...baseReq,
      seed_codes: [{ code: "7980", display: "Penicillin" }],
    });

    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0]).toMatchObject({ occurrence_count: 1 });
    expect(updateCalls).toHaveLength(0); // no merge path on a fresh insert
  });

  it("increments occurrence_count on a duplicate-pending merge that adds a genuinely new seed code", async () => {
    const insertCalls: Array<Record<string, unknown>> = [];
    const updateCalls: Array<Record<string, unknown>> = [];
    fromMock.mockImplementation(
      makeFromMock({
        conflict: true,
        existingRow: {
          id: "req-1",
          seed_codes: [{ code: "7980", display: "Penicillin" }],
          occurrence_count: 3,
        },
        insertCalls,
        updateCalls,
      }),
    );

    await requestTerminologyUpdate({
      ...baseReq,
      seed_codes: [{ code: "833536", display: "Amoxicillin" }], // new code
    });

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]).toMatchObject({ occurrence_count: 4 });
    // merge still folds in the new code, same as before this change
    expect(updateCalls[0].seed_codes).toEqual([
      { code: "7980", display: "Penicillin" },
      { code: "833536", display: "Amoxicillin" },
    ]);
  });

  it("still increments occurrence_count on a duplicate-pending merge whose seed code was already present (no new codes)", async () => {
    const insertCalls: Array<Record<string, unknown>> = [];
    const updateCalls: Array<Record<string, unknown>> = [];
    fromMock.mockImplementation(
      makeFromMock({
        conflict: true,
        existingRow: {
          id: "req-1",
          seed_codes: [{ code: "7980", display: "Penicillin" }],
          occurrence_count: 3,
        },
        insertCalls,
        updateCalls,
      }),
    );

    // Same code re-triggering the same gap (e.g. a different patient's MRN
    // hitting the identical allergy code) — seed_codes.length doesn't grow,
    // but this is still one more real-world occurrence of the gap.
    await requestTerminologyUpdate({
      ...baseReq,
      seed_codes: [{ code: "7980", display: "Penicillin" }],
    });

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]).toMatchObject({ occurrence_count: 4 });
    // no new code, so seed_codes is deliberately omitted from the update
    expect(updateCalls[0].seed_codes).toBeUndefined();
  });

  it("treats a pre-migration null occurrence_count as 1 before incrementing (defensive, never NaN)", async () => {
    const insertCalls: Array<Record<string, unknown>> = [];
    const updateCalls: Array<Record<string, unknown>> = [];
    fromMock.mockImplementation(
      makeFromMock({
        conflict: true,
        existingRow: {
          id: "req-1",
          seed_codes: [{ code: "7980", display: "Penicillin" }],
          occurrence_count: null,
        },
        insertCalls,
        updateCalls,
      }),
    );

    await requestTerminologyUpdate({
      ...baseReq,
      seed_codes: [{ code: "7980", display: "Penicillin" }],
    });

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]).toMatchObject({ occurrence_count: 2 });
  });

  it("does nothing when the duplicate-pending row was resolved/processed between the insert attempt and the re-read", async () => {
    const insertCalls: Array<Record<string, unknown>> = [];
    const updateCalls: Array<Record<string, unknown>> = [];
    fromMock.mockImplementation(
      makeFromMock({ conflict: true, existingRow: null, insertCalls, updateCalls }),
    );

    await requestTerminologyUpdate({
      ...baseReq,
      seed_codes: [{ code: "7980", display: "Penicillin" }],
    });

    expect(updateCalls).toHaveLength(0);
  });
});
