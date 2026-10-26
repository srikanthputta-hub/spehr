import { describe, expect, it, vi, beforeEach } from "vitest";

const rpcMock = vi.fn();

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
    from: vi.fn(),
    channel: vi.fn(),
    removeChannel: vi.fn(),
  },
}));

vi.mock("@/hooks/useAutomationEnabled", () => ({
  getAutomationEnabled: vi.fn(),
  useAutomationEnabled: vi.fn(),
}));

vi.mock("@/lib/async-timeout", () => ({
  fetchWithTimeout: vi.fn(),
}));

const { claimLease } = await import("./useAutomationWatchdog");

describe("claimLease", () => {
  beforeEach(() => {
    rpcMock.mockReset();
  });

  it("returns true when the RPC returns a non-empty data array for the automation_watchdog engine", async () => {
    rpcMock.mockResolvedValueOnce({ data: [{ engine: "automation_watchdog" }], error: null });

    const result = await claimLease("automation_watchdog", 60_000);

    expect(result).toBe(true);
    expect(rpcMock).toHaveBeenCalledWith(
      "claim_automation_lease",
      expect.objectContaining({ _engine: "automation_watchdog", _min_interval_ms: 60_000 }),
    );
  });

  it("returns true when the RPC returns a non-empty data array for the automation_watchdog_ghost engine", async () => {
    rpcMock.mockResolvedValueOnce({ data: [{ engine: "automation_watchdog_ghost" }], error: null });

    const result = await claimLease("automation_watchdog_ghost", 600_000);

    expect(result).toBe(true);
    expect(rpcMock).toHaveBeenCalledWith(
      "claim_automation_lease",
      expect.objectContaining({ _engine: "automation_watchdog_ghost", _min_interval_ms: 600_000 }),
    );
  });

  it("returns false when the RPC returns an empty data array (lease held elsewhere / cadence not elapsed)", async () => {
    rpcMock.mockResolvedValueOnce({ data: [], error: null });

    const result = await claimLease("automation_watchdog", 60_000);

    expect(result).toBe(false);
  });

  it("returns false, not a throw, when the RPC errors (e.g. migration not applied yet)", async () => {
    rpcMock.mockResolvedValueOnce({
      data: null,
      error: { message: "function claim_automation_lease does not exist" },
    });

    await expect(claimLease("automation_watchdog_ghost", 600_000)).resolves.toBe(false);
  });

  it("returns false, not a throw, when the RPC call itself rejects", async () => {
    rpcMock.mockRejectedValueOnce(new Error("network error"));

    await expect(claimLease("automation_watchdog", 60_000)).resolves.toBe(false);
  });
});
