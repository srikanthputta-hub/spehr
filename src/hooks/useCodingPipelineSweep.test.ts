import { describe, expect, it, vi, beforeEach } from "vitest";

const rpcMock = vi.fn();

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
  },
}));

vi.mock("@/lib/coding-pipeline", () => ({
  runSixStreamPipeline: vi.fn(),
}));

vi.mock("@/hooks/useAutomationEnabled", () => ({
  getAutomationEnabled: vi.fn(),
  useAutomationEnabled: vi.fn(),
}));

const { claimLease, heartbeatLease, releaseLeaseBestEffort } =
  await import("./useCodingPipelineSweep");

describe("claimLease", () => {
  beforeEach(() => {
    rpcMock.mockReset();
  });

  it("returns true when the RPC returns a non-empty data array (lease claimed)", async () => {
    rpcMock.mockResolvedValueOnce({ data: [{ engine: "coding_pipeline_sweep" }], error: null });

    const result = await claimLease();

    expect(result).toBe(true);
    expect(rpcMock).toHaveBeenCalledWith(
      "claim_automation_lease",
      expect.objectContaining({ _engine: "coding_pipeline_sweep" }),
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
      expect.objectContaining({ _engine: "coding_pipeline_sweep" }),
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
      expect.objectContaining({ _engine: "coding_pipeline_sweep", _lease_ms: -1000 }),
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
