import { describe, expect, it, vi } from "vitest";
import { requestTerminologyUpdate } from "./value-set-registry";

/**
 * Tests for requestTerminologyUpdate()'s `request_type: "deprecate"` branch
 * (fileDeprecationRequest() in supabase/functions/_shared/value-set-registry.ts)
 * — the real producer behind the automated dormancy sweep
 * (runValueSetDormancyPass in auto-terminologist-cycle.ts) and the manual
 * "Deprecate" button in ValueSetLibrary.tsx, both of which now file a
 * request here instead of mutating custom_value_sets directly.
 *
 * Unlike the create-path tests in value-set-registry.occurrence-count.test.ts
 * (which must mock "@/integrations/supabase/client" because
 * requestTerminologyUpdate's frontend wrapper only takes an explicit client
 * as an optional 3rd-ish param), these pass a fake client explicitly —
 * `requestTerminologyUpdate(req, client)` — which the wrapper accepts
 * directly, same as recommendDefinitionType()'s tests do.
 */

function makeClient(opts: {
  existingOpenRow: { id: string } | null;
  insertCalls: Array<Record<string, unknown>>;
  dedupeFilterCalls: Array<{ col: string; val: unknown }>;
}) {
  return {
    functions: {
      // A deprecate request must never reach UMLS/VSAC — recommendDefinitionType
      // is entirely create-path-only. Throwing here fails any test that
      // accidentally exercises that path.
      invoke: vi.fn(async () => {
        throw new Error("functions.invoke should never be called for a deprecate request");
      }),
    },
    from: vi.fn((table: string) => {
      if (table !== "terminology_requests") {
        throw new Error(`unexpected table in test: ${table}`);
      }
      return {
        insert: vi.fn((payload: Record<string, unknown>) => {
          opts.insertCalls.push(payload);
          return Promise.resolve({ error: null });
        }),
        select: vi.fn(() => ({
          eq: vi.fn((col: string, val: unknown) => {
            opts.dedupeFilterCalls.push({ col, val });
            return {
              eq: vi.fn((col2: string, val2: unknown) => {
                opts.dedupeFilterCalls.push({ col: col2, val: val2 });
                return {
                  neq: vi.fn(() => ({
                    limit: vi.fn(() => ({
                      maybeSingle: vi.fn(() =>
                        Promise.resolve({ data: opts.existingOpenRow, error: null }),
                      ),
                    })),
                  })),
                };
              }),
            };
          }),
        })),
      };
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("requestTerminologyUpdate — request_type: 'deprecate'", () => {
  it("files a pending deprecate request against the target value set", async () => {
    const insertCalls: Array<Record<string, unknown>> = [];
    const dedupeFilterCalls: Array<{ col: string; val: unknown }> = [];
    const client = makeClient({ existingOpenRow: null, insertCalls, dedupeFilterCalls });

    await requestTerminologyUpdate(
      {
        requesting_consumer: "Auto Terminologist · Dormancy Sweep",
        requested_name: "Legacy Billing Codes",
        justification: "Published ~7 month(s) ago and still has zero registered consumers.",
        priority: "low",
        seed_codes: [],
        clinical_application: "Terminology Governance",
        request_type: "deprecate",
        target_value_set_id: "vs-123",
      },
      client,
    );

    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0]).toMatchObject({
      request_type: "deprecate",
      target_value_set_id: "vs-123",
      status: "pending",
      requesting_consumer: "Auto Terminologist · Dormancy Sweep",
      occurrence_count: 1,
    });
    // The dedupe pre-check queried by request_type + target_value_set_id.
    expect(dedupeFilterCalls).toEqual([
      { col: "request_type", val: "deprecate" },
      { col: "target_value_set_id", val: "vs-123" },
    ]);
  });

  it("skips filing when an open (not yet resolved) deprecate request already targets the same value set", async () => {
    const insertCalls: Array<Record<string, unknown>> = [];
    const dedupeFilterCalls: Array<{ col: string; val: unknown }> = [];
    const client = makeClient({
      existingOpenRow: { id: "req-already-open" },
      insertCalls,
      dedupeFilterCalls,
    });

    await requestTerminologyUpdate(
      {
        requesting_consumer: "Value Set Library · Manual Deprecation Request",
        requested_name: "Legacy Billing Codes",
        justification: "Steward-initiated deprecation request.",
        seed_codes: [],
        request_type: "deprecate",
        target_value_set_id: "vs-123",
      },
      client,
    );

    expect(insertCalls).toHaveLength(0);
  });

  it("defaults request_type to 'create' and does not take the deprecate branch when omitted", async () => {
    const insertCalls: Array<Record<string, unknown>> = [];
    const dedupeFilterCalls: Array<{ col: string; val: unknown }> = [];
    const client = makeClient({ existingOpenRow: null, insertCalls, dedupeFilterCalls });

    await requestTerminologyUpdate(
      {
        requesting_consumer: "Safety Alerts Engine",
        requested_name: 'Drug-Allergy coverage for "Penicillin"',
        justification: "test",
        seed_codes: [{ code: "7980", display: "Penicillin" }],
      },
      client,
    );

    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0]).toMatchObject({ request_type: "create" });
    // No dedupe pre-check for the create path — that's the pending-only
    // unique index's job, not an explicit query here.
    expect(dedupeFilterCalls).toHaveLength(0);
  });
});
