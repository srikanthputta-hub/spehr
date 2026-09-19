import { describe, expect, it, vi, beforeEach } from "vitest";

const rpcMock = vi.fn();

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
  },
}));

const { codeShapeMatches, claimLease, heartbeatLease, releaseLeaseBestEffort } = await import(
  "./useAutoTerminologist"
);

describe("codeShapeMatches", () => {
  it("accepts a valid SNOMED CT code (6-18 digits)", () => {
    expect(codeShapeMatches("SNOMED CT", "22298006")).toBe(true);
  });

  it("rejects a SNOMED CT code that is too short", () => {
    expect(codeShapeMatches("SNOMED CT", "123")).toBe(false);
  });

  it("accepts a valid ICD-10 code", () => {
    expect(codeShapeMatches("ICD-10", "I10")).toBe(true);
    expect(codeShapeMatches("ICD-10", "E11.9")).toBe(true);
  });

  it("rejects a malformed ICD-10 code", () => {
    expect(codeShapeMatches("ICD-10", "10I")).toBe(false);
  });

  it("accepts a valid RxNorm code (digits only)", () => {
    expect(codeShapeMatches("RxNorm", "313782")).toBe(true);
  });

  it("rejects a non-numeric RxNorm code", () => {
    expect(codeShapeMatches("RxNorm", "ABC123")).toBe(false);
  });

  it("accepts a valid LOINC code (digits-hyphen-digit)", () => {
    expect(codeShapeMatches("LOINC", "4548-4")).toBe(true);
  });

  it("rejects a LOINC code missing the check digit", () => {
    expect(codeShapeMatches("LOINC", "4548")).toBe(false);
  });

  it("rejects an empty code regardless of vocabulary", () => {
    expect(codeShapeMatches("SNOMED CT", "")).toBe(false);
    expect(codeShapeMatches("SNOMED CT", "   ")).toBe(false);
  });

  it("falls back to true for an unrecognized vocabulary", () => {
    expect(codeShapeMatches("Some Other Vocab", "anything")).toBe(true);
  });
});

describe("claimLease", () => {
  beforeEach(() => {
    rpcMock.mockReset();
  });

  it("returns true when the RPC returns a non-empty data array (lease claimed)", async () => {
    rpcMock.mockResolvedValueOnce({ data: [{ engine: "auto_terminologist" }], error: null });

    const result = await claimLease();

    expect(result).toBe(true);
    expect(rpcMock).toHaveBeenCalledWith(
      "claim_automation_lease",
      expect.objectContaining({ _engine: "auto_terminologist" })
    );
  });

  it("returns false when the RPC returns an empty data array (lease held elsewhere / cadence not elapsed)", async () => {
    rpcMock.mockResolvedValueOnce({ data: [], error: null });

    const result = await claimLease();

    expect(result).toBe(false);
  });

  it("returns false, not a throw, when the RPC errors (e.g. migration not applied yet)", async () => {
    rpcMock.mockResolvedValueOnce({
      data: null,
      error: { message: "function claim_automation_lease does not exist" },
    });

    await expect(claimLease()).resolves.toBe(false);
  });

  it("returns false, not a throw, when the RPC call itself rejects", async () => {
    rpcMock.mockRejectedValueOnce(new Error("network error"));

    await expect(claimLease()).resolves.toBe(false);
  });
});

describe("heartbeatLease", () => {
  beforeEach(() => {
    rpcMock.mockReset();
  });

  it("invokes the heartbeat RPC and resolves without throwing on success", async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: null });

    await expect(heartbeatLease()).resolves.toBeUndefined();
    expect(rpcMock).toHaveBeenCalledWith(
      "heartbeat_automation_lease",
      expect.objectContaining({ _engine: "auto_terminologist" })
    );
  });

  it("does not throw when the RPC errors", async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: "boom" } });

    await expect(heartbeatLease()).resolves.toBeUndefined();
  });
});

describe("releaseLeaseBestEffort", () => {
  beforeEach(() => {
    rpcMock.mockReset();
  });

  it("actually invokes supabase.rpc() (fire-and-forget, not a no-op void call)", () => {
    rpcMock.mockReturnValue(Promise.resolve({ data: null, error: null }));

    releaseLeaseBestEffort();

    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith(
      "heartbeat_automation_lease",
      expect.objectContaining({ _engine: "auto_terminologist", _lease_ms: -1000 })
    );
  });

  it("does not throw even if the underlying rpc call rejects asynchronously", async () => {
    rpcMock.mockReturnValue(Promise.reject(new Error("network error")));

    expect(() => releaseLeaseBestEffort()).not.toThrow();
    // let the fire-and-forget .then/.catch settle so the rejection doesn't
    // surface as an unhandled rejection in a later test.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
