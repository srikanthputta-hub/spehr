import { describe, expect, it, vi } from "vitest";
import {
  processPendingTerminologyRequests,
  runUnusedValueSetDeprecationPass,
} from "./auto-terminologist-cycle";

/**
 * Tests for the Auto Terminologist cycle's `request_type: "deprecate"`
 * path — previously zero coverage anywhere in the suite, for a real
 * reason: `processPendingTerminologyRequests`'s deprecation branch (gate
 * -> status flip -> activity log) was correct but UNREACHABLE. Every
 * INSERT into `terminology_requests` across the app (auto-doc.server.ts,
 * admit-patient.ts, auto-code.ts, requestTerminologyUpdate()) hardcoded
 * `request_type: "create"`, so no code path could ever produce a
 * `request_type: "deprecate"` row for this branch to process.
 *
 * `runUnusedValueSetDeprecationPass` is the real producer added alongside
 * this test: it files a `request_type: "deprecate"` row against a
 * published value set with zero real consumers (mirrors
 * ValueSetLibrary.tsx's delete-guard definition of "in use"). Group B
 * below tests that producer in isolation; Group C wires producer ->
 * consumer together to prove the previously-dead branch now actually
 * fires end-to-end.
 *
 * Both functions take an injectable client (no module-level singleton),
 * so these fake it directly the same way value-set-registry.test.ts
 * does — no network, no real Supabase project.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

function makeClient(opts: {
  pendingRequests?: Row[];
  valueSets?: Record<string, Row>;
  consumerCounts?: Record<
    string,
    Partial<
      Record<"value_set_dependencies" | "cross_reactivity_rules" | "drug_interaction_rules", number>
    >
  >;
  existingDeprecateTargets?: Set<string>;
}) {
  const calls = {
    customValueSetUpdates: [] as Row[],
    terminologyRequestUpdates: [] as Row[],
    terminologyRequestInserts: [] as Row[],
    activityLogInserts: [] as Row[],
    busLogInserts: [] as Row[],
  };

  const countFor = (table: string, valueSetId: string) =>
    opts.consumerCounts?.[valueSetId]?.[
      table as "value_set_dependencies" | "cross_reactivity_rules" | "drug_interaction_rules"
    ] ?? 0;

  const client = {
    from: vi.fn((table: string) => {
      if (table === "terminology_requests") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn((col: string, val: string) => {
              if (col === "status" && val === "pending") {
                return Promise.resolve({ data: opts.pendingRequests ?? [], error: null });
              }
              if (col === "target_value_set_id") {
                const targetId = val;
                return {
                  eq: vi.fn(() => ({
                    limit: vi.fn(() =>
                      Promise.resolve({
                        data: opts.existingDeprecateTargets?.has(targetId)
                          ? [{ id: "existing-request" }]
                          : [],
                        error: null,
                      }),
                    ),
                  })),
                };
              }
              return Promise.resolve({ data: [], error: null });
            }),
          })),
          update: vi.fn((payload: Row) => {
            calls.terminologyRequestUpdates.push(payload);
            return { eq: vi.fn(() => Promise.resolve({ error: null })) };
          }),
          insert: vi.fn((payload: Row) => {
            calls.terminologyRequestInserts.push(payload);
            return Promise.resolve({ error: null });
          }),
        };
      }
      if (table === "custom_value_sets") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn((_col: string, val: string) => ({
              maybeSingle: vi.fn(() =>
                Promise.resolve({ data: opts.valueSets?.[val] ?? null, error: null }),
              ),
            })),
          })),
          update: vi.fn((payload: Row) => {
            calls.customValueSetUpdates.push(payload);
            return { eq: vi.fn(() => Promise.resolve({ error: null })) };
          }),
        };
      }
      if (
        table === "value_set_dependencies" ||
        table === "cross_reactivity_rules" ||
        table === "drug_interaction_rules"
      ) {
        return {
          select: vi.fn(() => ({
            eq: vi.fn((_col: string, valueSetId: string) =>
              Promise.resolve({ count: countFor(table, valueSetId), error: null }),
            ),
            or: vi.fn((filter: string) => {
              const valueSetId = /\.eq\.([^,]+)/.exec(filter)?.[1] ?? "";
              return Promise.resolve({ count: countFor(table, valueSetId), error: null });
            }),
          })),
        };
      }
      if (table === "auto_terminologist_log") {
        return {
          insert: vi.fn((payload: Row) => {
            calls.activityLogInserts.push(payload);
            return Promise.resolve({ error: null });
          }),
        };
      }
      if (table === "terminology_activity_log") {
        return {
          insert: vi.fn((payload: Row) => {
            calls.busLogInserts.push(payload);
            return Promise.resolve({ error: null });
          }),
        };
      }
      throw new Error(`unexpected table in test: ${table}`);
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  return { client, calls };
}

const baseDeprecateRequest = {
  id: "req-1",
  requesting_consumer: "Auto Terminologist · Unused Value-Set Detector",
  requested_name: "Legacy Sepsis Bundle Codes",
  justification: "Looks unused.",
  priority: "low",
  vocabulary: null,
  seed_codes: [],
  request_type: "deprecate",
  requested_at: new Date().toISOString(),
  recommended_type: null,
};

describe("processPendingTerminologyRequests — deprecation branch", () => {
  it("gates a deprecate request with no target_value_set_id", async () => {
    const { client, calls } = makeClient({
      pendingRequests: [{ ...baseDeprecateRequest, target_value_set_id: null }],
    });

    const result = await processPendingTerminologyRequests(client);

    expect(result.gated).toBe(1);
    expect(result.deprecationSuggested).toBe(0);
    expect(calls.customValueSetUpdates).toHaveLength(0);
    expect(calls.terminologyRequestUpdates).toHaveLength(1);
    expect(calls.terminologyRequestUpdates[0].quality_gate_notes).toBe(
      "Deprecation request missing target_value_set_id",
    );
  });

  it("gates a deprecate request whose target value set no longer exists", async () => {
    const { client, calls } = makeClient({
      pendingRequests: [{ ...baseDeprecateRequest, target_value_set_id: "vs-missing" }],
      valueSets: {},
    });

    const result = await processPendingTerminologyRequests(client);

    expect(result.gated).toBe(1);
    expect(calls.terminologyRequestUpdates[0].quality_gate_notes).toBe(
      "Target value set not found",
    );
  });

  it("rejects a deprecate request targeting a draft (drafts should be deleted directly)", async () => {
    const { client, calls } = makeClient({
      pendingRequests: [{ ...baseDeprecateRequest, target_value_set_id: "vs-draft" }],
      valueSets: {
        "vs-draft": {
          id: "vs-draft",
          name: "Unfinished Draft VS",
          status: "draft",
          change_history: [],
        },
      },
    });

    const result = await processPendingTerminologyRequests(client);

    expect(result.rejected).toBe(1);
    expect(result.deprecationSuggested).toBe(0);
    expect(calls.customValueSetUpdates).toHaveLength(0);
    expect(calls.terminologyRequestUpdates[0].status).toBe("rejected");
  });

  it("flips a published target to deprecation-suggested and resolves the request", async () => {
    const { client, calls } = makeClient({
      pendingRequests: [
        {
          ...baseDeprecateRequest,
          target_value_set_id: "vs-1",
          justification: "Zero registered consumers for 4 months.",
        },
      ],
      valueSets: {
        "vs-1": {
          id: "vs-1",
          name: "Legacy Sepsis Bundle Codes",
          status: "published",
          change_history: [],
        },
      },
    });

    const result = await processPendingTerminologyRequests(client);

    expect(result.deprecationSuggested).toBe(1);
    expect(result.gated).toBe(0);
    expect(result.rejected).toBe(0);

    expect(calls.customValueSetUpdates).toHaveLength(1);
    expect(calls.customValueSetUpdates[0].status).toBe("deprecation-suggested");
    expect(calls.customValueSetUpdates[0].change_history).toHaveLength(1);
    expect(calls.customValueSetUpdates[0].change_history[0].change).toContain(
      "Deprecation suggested",
    );
    expect(calls.customValueSetUpdates[0].change_history[0].change).toContain(
      "Zero registered consumers for 4 months.",
    );

    expect(calls.terminologyRequestUpdates).toHaveLength(1);
    expect(calls.terminologyRequestUpdates[0].status).toBe("drafted");
    expect(calls.terminologyRequestUpdates[0].value_set_id).toBe("vs-1");

    expect(calls.activityLogInserts.some((l) => l.action === "deprecation-suggested")).toBe(true);
    expect(calls.busLogInserts.some((l) => l.action === "deprecation-suggested")).toBe(true);
  });

  it("flips a review-status target to deprecation-suggested too", async () => {
    const { client, calls } = makeClient({
      pendingRequests: [{ ...baseDeprecateRequest, target_value_set_id: "vs-review" }],
      valueSets: {
        "vs-review": {
          id: "vs-review",
          name: "In-Review VS",
          status: "review",
          change_history: null,
        },
      },
    });

    const result = await processPendingTerminologyRequests(client);

    expect(result.deprecationSuggested).toBe(1);
    expect(calls.customValueSetUpdates[0].status).toBe("deprecation-suggested");
  });

  it("no-ops (rejects) a target that's already deprecation-suggested or retired", async () => {
    const { client, calls } = makeClient({
      pendingRequests: [{ ...baseDeprecateRequest, target_value_set_id: "vs-retired" }],
      valueSets: {
        "vs-retired": {
          id: "vs-retired",
          name: "Retired VS",
          status: "retired",
          change_history: [],
        },
      },
    });

    const result = await processPendingTerminologyRequests(client);

    expect(result.rejected).toBe(1);
    expect(calls.customValueSetUpdates).toHaveLength(0);
  });
});

describe("runUnusedValueSetDeprecationPass", () => {
  const OLD_PUBLISHED_AT = new Date(Date.now() - 200 * 24 * 60 * 60_000).toISOString();
  const RECENT_PUBLISHED_AT = new Date(Date.now() - 10 * 24 * 60 * 60_000).toISOString();

  it("files a deprecate request for a long-published value set with zero consumers", async () => {
    const { client, calls } = makeClient({
      consumerCounts: {
        "vs-unused": {
          value_set_dependencies: 0,
          cross_reactivity_rules: 0,
          drug_interaction_rules: 0,
        },
      },
    });

    const result = await runUnusedValueSetDeprecationPass(client, [
      {
        id: "vs-unused",
        name: "Orphaned Value Set",
        codes: [],
        published_at: OLD_PUBLISHED_AT,
        change_history: [],
      },
    ]);

    expect(result.checked).toBe(1);
    expect(result.deprecationsFiled).toBe(1);
    expect(calls.terminologyRequestInserts).toHaveLength(1);
    const inserted = calls.terminologyRequestInserts[0];
    expect(inserted.request_type).toBe("deprecate");
    expect(inserted.target_value_set_id).toBe("vs-unused");
    expect(inserted.status).toBe("pending");
    expect(inserted.requesting_consumer).toContain("Auto Terminologist");
  });

  it("does not flag a value set that still has a real consumer", async () => {
    const { client, calls } = makeClient({
      consumerCounts: { "vs-used": { value_set_dependencies: 1 } },
    });

    const result = await runUnusedValueSetDeprecationPass(client, [
      {
        id: "vs-used",
        name: "Active Value Set",
        codes: [],
        published_at: OLD_PUBLISHED_AT,
        change_history: [],
      },
    ]);

    expect(result.deprecationsFiled).toBe(0);
    expect(calls.terminologyRequestInserts).toHaveLength(0);
  });

  it("does not flag a value set published too recently to judge", async () => {
    const { client, calls } = makeClient({
      consumerCounts: {
        "vs-new": {
          value_set_dependencies: 0,
          cross_reactivity_rules: 0,
          drug_interaction_rules: 0,
        },
      },
    });

    const result = await runUnusedValueSetDeprecationPass(client, [
      {
        id: "vs-new",
        name: "Brand New Value Set",
        codes: [],
        published_at: RECENT_PUBLISHED_AT,
        change_history: [],
      },
    ]);

    expect(result.checked).toBe(0);
    expect(result.deprecationsFiled).toBe(0);
    expect(calls.terminologyRequestInserts).toHaveLength(0);
  });

  it("does not re-file a deprecate request for a value set already flagged", async () => {
    const { client, calls } = makeClient({
      consumerCounts: {
        "vs-already-flagged": {
          value_set_dependencies: 0,
          cross_reactivity_rules: 0,
          drug_interaction_rules: 0,
        },
      },
      existingDeprecateTargets: new Set(["vs-already-flagged"]),
    });

    const result = await runUnusedValueSetDeprecationPass(client, [
      {
        id: "vs-already-flagged",
        name: "Already Flagged Value Set",
        codes: [],
        published_at: OLD_PUBLISHED_AT,
        change_history: [],
      },
    ]);

    expect(result.deprecationsFiled).toBe(0);
    expect(calls.terminologyRequestInserts).toHaveLength(0);
  });

  it("has no published_at to compare against — skips rather than guessing", async () => {
    const { client, calls } = makeClient({});

    const result = await runUnusedValueSetDeprecationPass(client, [
      {
        id: "vs-no-date",
        name: "No Published Date",
        codes: [],
        published_at: null,
        change_history: [],
      },
    ]);

    expect(result.checked).toBe(0);
    expect(calls.terminologyRequestInserts).toHaveLength(0);
  });
});

describe("end-to-end: the producer's output actually reaches the previously-dead branch", () => {
  it("runUnusedValueSetDeprecationPass's filed row, fed back through processPendingTerminologyRequests, flips the value set to deprecation-suggested", async () => {
    const OLD_PUBLISHED_AT = new Date(Date.now() - 200 * 24 * 60 * 60_000).toISOString();
    const targetId = "vs-superseded";

    const { client: producerClient, calls: producerCalls } = makeClient({
      consumerCounts: {
        [targetId]: {
          value_set_dependencies: 0,
          cross_reactivity_rules: 0,
          drug_interaction_rules: 0,
        },
      },
    });

    const producerResult = await runUnusedValueSetDeprecationPass(producerClient, [
      {
        id: targetId,
        name: "Superseded Drug Class List",
        codes: [],
        published_at: OLD_PUBLISHED_AT,
        change_history: [],
      },
    ]);
    expect(producerResult.deprecationsFiled).toBe(1);
    const filedRequest = producerCalls.terminologyRequestInserts[0];
    expect(filedRequest.request_type).toBe("deprecate");

    // Simulate the next cycle: the filed row is now a real pending
    // terminology_requests row, exactly as it would appear in the DB.
    const { client: consumerClient, calls: consumerCalls } = makeClient({
      pendingRequests: [{ id: "filed-req-1", ...filedRequest }],
      valueSets: {
        [targetId]: {
          id: targetId,
          name: "Superseded Drug Class List",
          status: "published",
          change_history: [],
        },
      },
    });

    const cycleResult = await processPendingTerminologyRequests(consumerClient);

    expect(cycleResult.deprecationSuggested).toBe(1);
    expect(consumerCalls.customValueSetUpdates[0].status).toBe("deprecation-suggested");
    expect(consumerCalls.terminologyRequestUpdates[0].status).toBe("drafted");
  });
});
