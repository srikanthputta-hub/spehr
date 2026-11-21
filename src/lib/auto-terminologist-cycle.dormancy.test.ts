import { describe, expect, it, vi } from "vitest";
import { runValueSetDormancyPass } from "./auto-terminologist-cycle";

/**
 * Tests for runValueSetDormancyPass() — the real automated deprecation
 * producer (auto-terminologist-cycle.ts): detects published value sets
 * with zero registered value_set_dependencies consumers, sustained over a
 * real governance grace period (mirrors the staleness pass's 6-month
 * cadence), and files a `request_type: 'deprecate'` terminology_requests
 * row for each one via requestTerminologyUpdate() — never a hand-rolled
 * insert, and never a direct custom_value_sets write.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const SIX_MONTHS_MS = 183 * DAY_MS;

type DepRow = { value_set_id: string | null };

function makeClient(opts: {
  depRows: DepRow[];
  openDeprecateRequests?: Set<string>; // target_value_set_ids that already have an open request
  insertCalls: Array<Record<string, unknown>>;
}) {
  const open = opts.openDeprecateRequests ?? new Set<string>();
  return {
    functions: {
      invoke: vi.fn(async () => {
        throw new Error("functions.invoke should never be called by the dormancy pass");
      }),
    },
    from: vi.fn((table: string) => {
      if (table === "value_set_dependencies") {
        return {
          select: vi.fn(() => ({
            not: vi.fn(() => Promise.resolve({ data: opts.depRows, error: null })),
          })),
        };
      }
      if (table === "terminology_requests") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn((_col: string, targetId: string) => ({
                neq: vi.fn(() => ({
                  limit: vi.fn(() => ({
                    maybeSingle: vi.fn(() =>
                      Promise.resolve({
                        data: open.has(targetId) ? { id: `existing-for-${targetId}` } : null,
                        error: null,
                      }),
                    ),
                  })),
                })),
              })),
            })),
          })),
          insert: vi.fn((payload: Record<string, unknown>) => {
            opts.insertCalls.push(payload);
            return Promise.resolve({ error: null });
          }),
        };
      }
      throw new Error(`unexpected table in test: ${table}`);
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("runValueSetDormancyPass", () => {
  it("flags a published value set with zero consumers and a sustained (>6mo) publish age", async () => {
    const insertCalls: Array<Record<string, unknown>> = [];
    const client = makeClient({ depRows: [], insertCalls });
    const publishedVs = [
      {
        id: "vs-dormant",
        name: "Legacy Billing Codes",
        codes: [],
        published_at: new Date(Date.now() - (SIX_MONTHS_MS + 10 * DAY_MS)).toISOString(),
        change_history: null,
      },
    ];

    const result = await runValueSetDormancyPass(client, publishedVs);

    expect(result.dormancyFlagged).toBe(1);
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0]).toMatchObject({
      request_type: "deprecate",
      target_value_set_id: "vs-dormant",
      status: "pending",
      requesting_consumer: "Auto Terminologist · Dormancy Sweep",
    });
    expect(String(insertCalls[0].justification)).toContain("zero registered consumers");
  });

  it("does not flag a published value set that has a registered consumer dependency", async () => {
    const insertCalls: Array<Record<string, unknown>> = [];
    const client = makeClient({ depRows: [{ value_set_id: "vs-in-use" }], insertCalls });
    const publishedVs = [
      {
        id: "vs-in-use",
        name: "Active Drug Class",
        codes: [],
        published_at: new Date(Date.now() - (SIX_MONTHS_MS + 10 * DAY_MS)).toISOString(),
        change_history: null,
      },
    ];

    const result = await runValueSetDormancyPass(client, publishedVs);

    expect(result.dormancyFlagged).toBe(0);
    expect(insertCalls).toHaveLength(0);
  });

  it("does not flag a value set published too recently, even with zero consumers (not a single-cycle blip)", async () => {
    const insertCalls: Array<Record<string, unknown>> = [];
    const client = makeClient({ depRows: [], insertCalls });
    const publishedVs = [
      {
        id: "vs-new",
        name: "Brand New Value Set",
        codes: [],
        published_at: new Date(Date.now() - 10 * DAY_MS).toISOString(),
        change_history: null,
      },
    ];

    const result = await runValueSetDormancyPass(client, publishedVs);

    expect(result.dormancyFlagged).toBe(0);
    expect(insertCalls).toHaveLength(0);
  });

  it("skips a value set with no published_at at all (nothing to measure a sustained period against)", async () => {
    const insertCalls: Array<Record<string, unknown>> = [];
    const client = makeClient({ depRows: [], insertCalls });
    const publishedVs = [
      {
        id: "vs-no-published-at",
        name: "Weird Row",
        codes: [],
        published_at: null,
        change_history: null,
      },
    ];

    const result = await runValueSetDormancyPass(client, publishedVs);

    expect(result.dormancyFlagged).toBe(0);
    expect(insertCalls).toHaveLength(0);
  });

  it("does not re-file when an open deprecate request already targets the same value set", async () => {
    const insertCalls: Array<Record<string, unknown>> = [];
    const client = makeClient({
      depRows: [],
      openDeprecateRequests: new Set(["vs-already-flagged"]),
      insertCalls,
    });
    const publishedVs = [
      {
        id: "vs-already-flagged",
        name: "Already Flagged",
        codes: [],
        published_at: new Date(Date.now() - (SIX_MONTHS_MS + 10 * DAY_MS)).toISOString(),
        change_history: null,
      },
    ];

    await runValueSetDormancyPass(client, publishedVs);

    expect(insertCalls).toHaveLength(0);
  });

  it("checks every published value set given, even when the dependency table is empty", async () => {
    const insertCalls: Array<Record<string, unknown>> = [];
    const client = makeClient({ depRows: [], insertCalls });
    const publishedVs = [
      {
        id: "vs-1",
        name: "One",
        codes: [],
        published_at: new Date(Date.now() - (SIX_MONTHS_MS + DAY_MS)).toISOString(),
        change_history: null,
      },
      {
        id: "vs-2",
        name: "Two",
        codes: [],
        published_at: new Date(Date.now() - (SIX_MONTHS_MS + DAY_MS)).toISOString(),
        change_history: null,
      },
    ];

    const result = await runValueSetDormancyPass(client, publishedVs);

    expect(result.checked).toBe(2);
    expect(result.dormancyFlagged).toBe(2);
    expect(insertCalls).toHaveLength(2);
  });
});
