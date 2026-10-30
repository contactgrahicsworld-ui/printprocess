export const ORDER_STATUSES = ["RECEIVED", "UNDER_REVIEW", "APPROVED", "PRINTING", "READY", "DELIVERED", "CANCELLED"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Mirrors public.order_transition_allowed() in the SQL migrations. */
export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  RECEIVED: ["UNDER_REVIEW", "APPROVED", "CANCELLED"],
  UNDER_REVIEW: ["APPROVED", "CANCELLED"],
  APPROVED: ["UNDER_REVIEW", "PRINTING", "CANCELLED"],
  PRINTING: ["APPROVED", "READY", "CANCELLED"],
  READY: ["PRINTING", "DELIVERED"],
  DELIVERED: [],
  CANCELLED: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  RECEIVED: "Received / Mil gaya",
  UNDER_REVIEW: "Under review / Jaanch ho rahi hai",
  APPROVED: "Approved / Manzoor",
  PRINTING: "Printing / Chhap raha hai",
  READY: "Ready for pickup / Taiyaar",
  DELIVERED: "Delivered / De diya",
  CANCELLED: "Cancelled / Radd",
};

/** Order statuses in which print settings can still be edited by staff. */
export const EDITABLE_STATUSES: readonly OrderStatus[] = ["RECEIVED", "UNDER_REVIEW", "APPROVED"];

// ---------------------------------------------------------------- print jobs (CONTRACT.md)
export const JOB_STATUSES = [
  "QUEUED", "CLAIMED", "DOWNLOADED", "SUBMITTED", "SPOOLED", "PRINTING", "COMPLETED_SPOOLER", "VERIFIED",
  "FAILED", "PRINTER_OFFLINE", "PAPER_OUT", "ERROR", "CANCELLED",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const AGENT_STATUSES = [
  "DOWNLOADED", "SUBMITTED", "SPOOLED", "PRINTING", "COMPLETED_SPOOLER", "FAILED", "PRINTER_OFFLINE", "PAPER_OUT", "ERROR",
] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

const PROGRESS_RANK: Partial<Record<JobStatus, number>> = {
  QUEUED: 0, CLAIMED: 1, DOWNLOADED: 2, SUBMITTED: 3, SPOOLED: 4, PRINTING: 5, COMPLETED_SPOOLER: 6, VERIFIED: 7,
};
export const FAILURE_STATUSES: readonly JobStatus[] = ["FAILED", "PRINTER_OFFLINE", "PAPER_OUT", "ERROR"];
export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ["VERIFIED", ...FAILURE_STATUSES, "CANCELLED"];
export const ACTIVE_JOB_STATUSES: readonly JobStatus[] = ["QUEUED", "CLAIMED", "DOWNLOADED", "SUBMITTED", "SPOOLED", "PRINTING", "COMPLETED_SPOOLER"];

/**
 * Monotonic-safe application of an agent-reported status (CONTRACT.md):
 * forward progress only; failures allowed from CLAIMED..PRINTING; terminal states never change.
 * Returns the new status, or null when the current status must be kept.
 */
export function applyAgentStatus(current: JobStatus, reported: AgentStatus): JobStatus | null {
  if (TERMINAL_JOB_STATUSES.includes(current)) return null;
  const cur = PROGRESS_RANK[current];
  if (cur === undefined) return null;
  if (FAILURE_STATUSES.includes(reported)) {
    return cur >= 1 && cur <= 5 ? reported : null;
  }
  const next = PROGRESS_RANK[reported];
  if (next === undefined) return null;
  if (current === "QUEUED") return null; // must be claimed first
  return next > cur ? reported : null;
}

export const JOB_STATUS_LABEL: Record<JobStatus, string> = {
  QUEUED: "Queued (waiting for agent)",
  CLAIMED: "Claimed by agent",
  DOWNLOADED: "File downloaded by agent",
  SUBMITTED: "Submitted to Windows spooler",
  SPOOLED: "In spooler queue",
  PRINTING: "Spooler: printing",
  COMPLETED_SPOOLER: "Spooler finished — NOT yet verified",
  VERIFIED: "Verified printed by staff",
  FAILED: "Failed",
  PRINTER_OFFLINE: "Printer offline",
  PAPER_OUT: "Paper out",
  ERROR: "Printer error",
  CANCELLED: "Cancelled",
};
