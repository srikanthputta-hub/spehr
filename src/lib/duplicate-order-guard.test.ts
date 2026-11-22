import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Minimal chainable Supabase query-builder fake. Every method returns the
 * same object so `.select().eq().gte().order().limit()` chains however
 * findRecentDuplicateOrder() happens to call them, and `await`-ing it
 * resolves to the configured `{ data, error }` via `then`.
 */
type QueryBuilder = {
  __calls: Array<{ method: string; args: unknown[] }>;
  select: (...args: unknown[]) => QueryBuilder;
  eq: (...args: unknown[]) => QueryBuilder;
  gte: (...args: unknown[]) => QueryBuilder;
  order: (...args: unknown[]) => QueryBuilder;
  limit: (...args: unknown[]) => QueryBuilder;
  then: (resolve: (v: { data: unknown; error: unknown }) => void) => void;
};

function makeQueryBuilder(result: { data: unknown; error: unknown }): QueryBuilder {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const builder = { __calls: calls } as QueryBuilder;
  for (const method of ["select", "eq", "gte", "order", "limit"] as const) {
    builder[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return builder;
    };
  }
  builder.then = (resolve) => resolve(result);
  return builder;
}

const fromMock = vi.fn();

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (...args: unknown[]) => fromMock(...args),
  },
}));

const { findRecentDuplicateOrder, confirmDuplicateOrder } = await import("./duplicate-order-guard");

describe("findRecentDuplicateOrder", () => {
  beforeEach(() => {
    fromMock.mockReset();
  });

  it("returns isDuplicate: false when mrn is empty (never queries)", async () => {
    const result = await findRecentDuplicateOrder({
      mrn: "",
      table: "medication_orders",
      matchColumns: { drug_name: "Amoxicillin" },
    });
    expect(result).toEqual({ isDuplicate: false });
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("returns isDuplicate: false when no recent matching row exists", async () => {
    fromMock.mockReturnValue(makeQueryBuilder({ data: [], error: null }));
    const result = await findRecentDuplicateOrder({
      mrn: "MRN-100001",
      table: "radiology_orders",
      matchColumns: { exam_type: "Chest X-ray" },
    });
    expect(result).toEqual({ isDuplicate: false });
  });

  it("returns isDuplicate: true with an age in seconds when a recent match exists", async () => {
    const createdAt = new Date(Date.now() - 125_000).toISOString(); // ~125s ago
    fromMock.mockReturnValue(
      makeQueryBuilder({ data: [{ id: "abc", created_at: createdAt }], error: null }),
    );
    const result = await findRecentDuplicateOrder({
      mrn: "MRN-100001",
      table: "medication_orders",
      matchColumns: { drug_name: "Amoxicillin", dose: "500mg", route: "PO", frequency: "Daily" },
    });
    expect(result.isDuplicate).toBe(true);
    expect(result.ageSeconds).toBeGreaterThanOrEqual(120);
    expect(result.ageSeconds).toBeLessThanOrEqual(130);
  });

  it("skips empty/null match-column values rather than filtering on them", async () => {
    const builder = makeQueryBuilder({ data: [], error: null });
    fromMock.mockReturnValue(builder);
    await findRecentDuplicateOrder({
      mrn: "MRN-100001",
      table: "lab_orders",
      matchColumns: { test_type: "CBC", requested_by: null, clinical_condition: "" },
    });
    const eqCalls = builder.__calls.filter((c: { method: string }) => c.method === "eq");
    // patient_mrn + test_type only — requested_by/clinical_condition were empty.
    expect(eqCalls).toEqual([
      { method: "eq", args: ["patient_mrn", "MRN-100001"] },
      { method: "eq", args: ["test_type", "CBC"] },
    ]);
  });

  it("never throws — a query error resolves to isDuplicate: false", async () => {
    fromMock.mockReturnValue(makeQueryBuilder({ data: null, error: { message: "network error" } }));
    await expect(
      findRecentDuplicateOrder({
        mrn: "MRN-100001",
        table: "medication_orders",
        matchColumns: { drug_name: "Amoxicillin" },
      }),
    ).resolves.toEqual({ isDuplicate: false });
  });

  it("never throws — a thrown query rejects into isDuplicate: false", async () => {
    fromMock.mockImplementation(() => {
      throw new Error("boom");
    });
    await expect(
      findRecentDuplicateOrder({
        mrn: "MRN-100001",
        table: "medication_orders",
        matchColumns: { drug_name: "Amoxicillin" },
      }),
    ).resolves.toEqual({ isDuplicate: false });
  });
});

describe("confirmDuplicateOrder", () => {
  // This suite runs under vitest's "node" environment (no DOM), so `window`
  // isn't defined at all until stubbed — vi.stubGlobal gives the module a
  // `window.confirm` to call without pulling in jsdom for the whole project.
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks for confirmation with a human-readable age and returns the user's answer", () => {
    const confirmFn = vi.fn().mockReturnValue(true);
    vi.stubGlobal("window", { confirm: confirmFn });
    const result = confirmDuplicateOrder(45);
    expect(result).toBe(true);
    expect(confirmFn).toHaveBeenCalledWith(expect.stringContaining("45 seconds ago"));
  });

  it("formats ages of 90s+ in minutes, not seconds", () => {
    const confirmFn = vi.fn().mockReturnValue(false);
    vi.stubGlobal("window", { confirm: confirmFn });
    const result = confirmDuplicateOrder(150); // 2.5 min -> rounds to 3 min
    expect(result).toBe(false);
    expect(confirmFn).toHaveBeenCalledWith(expect.stringContaining("3 minutes ago"));
  });
});
