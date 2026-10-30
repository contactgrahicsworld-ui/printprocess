import { describe, expect, it } from "vitest";
import { applyAgentStatus, canTransition, ORDER_STATUSES, ORDER_TRANSITIONS, AGENT_STATUSES, type JobStatus } from "@/lib/orders/status";

describe("order status transitions", () => {
  it("allows the happy path", () => {
    const path = ["RECEIVED", "UNDER_REVIEW", "APPROVED", "PRINTING", "READY", "DELIVERED"] as const;
    for (let i = 0; i < path.length - 1; i++) expect(canTransition(path[i]!, path[i + 1]!)).toBe(true);
  });
  it("terminal states cannot move", () => {
    for (const to of ORDER_STATUSES) {
      expect(canTransition("DELIVERED", to)).toBe(false);
      expect(canTransition("CANCELLED", to)).toBe(false);
    }
  });
  it("forbids skipping (RECEIVED→PRINTING/READY/DELIVERED) and backwards jumps", () => {
    expect(canTransition("RECEIVED", "PRINTING")).toBe(false);
    expect(canTransition("RECEIVED", "READY")).toBe(false);
    expect(canTransition("RECEIVED", "DELIVERED")).toBe(false);
    expect(canTransition("APPROVED", "READY")).toBe(false);
    expect(canTransition("READY", "CANCELLED")).toBe(false);
    expect(canTransition("PRINTING", "RECEIVED")).toBe(false);
  });
  it("no self transitions in the table", () => {
    for (const s of ORDER_STATUSES) expect(ORDER_TRANSITIONS[s]).not.toContain(s);
  });
});

describe("agent job status (monotonic-safe)", () => {
  it("moves forward along the CONTRACT chain", () => {
    expect(applyAgentStatus("CLAIMED", "DOWNLOADED")).toBe("DOWNLOADED");
    expect(applyAgentStatus("DOWNLOADED", "SUBMITTED")).toBe("SUBMITTED");
    expect(applyAgentStatus("SUBMITTED", "SPOOLED")).toBe("SPOOLED");
    expect(applyAgentStatus("SPOOLED", "PRINTING")).toBe("PRINTING");
    expect(applyAgentStatus("PRINTING", "COMPLETED_SPOOLER")).toBe("COMPLETED_SPOOLER");
    expect(applyAgentStatus("CLAIMED", "COMPLETED_SPOOLER")).toBe("COMPLETED_SPOOLER"); // skipping forward is fine
  });
  it("never regresses (late/out-of-order events)", () => {
    expect(applyAgentStatus("PRINTING", "SPOOLED")).toBeNull();
    expect(applyAgentStatus("COMPLETED_SPOOLER", "PRINTING")).toBeNull();
    expect(applyAgentStatus("SUBMITTED", "SUBMITTED")).toBeNull();
  });
  it("failures only from CLAIMED..PRINTING", () => {
    for (const s of ["CLAIMED", "DOWNLOADED", "SUBMITTED", "SPOOLED", "PRINTING"] as JobStatus[]) {
      expect(applyAgentStatus(s, "PAPER_OUT")).toBe("PAPER_OUT");
    }
    expect(applyAgentStatus("COMPLETED_SPOOLER", "ERROR")).toBeNull();
    expect(applyAgentStatus("QUEUED", "FAILED")).toBeNull();
  });
  it("terminal states are frozen; agent can never reach VERIFIED", () => {
    for (const t of ["VERIFIED", "FAILED", "PRINTER_OFFLINE", "PAPER_OUT", "ERROR", "CANCELLED"] as JobStatus[]) {
      for (const a of AGENT_STATUSES) expect(applyAgentStatus(t, a)).toBeNull();
    }
    expect(AGENT_STATUSES).not.toContain("VERIFIED");
  });
  it("QUEUED jobs must be claimed first", () => {
    expect(applyAgentStatus("QUEUED", "DOWNLOADED")).toBeNull();
  });
});
