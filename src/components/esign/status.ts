import type { StatusKey } from "@/components/ui/badge";

/**
 * One mapping from document state to chip colour, shared by the workspace list,
 * the patient tab and the appointment panel. Three copies of this drifted apart
 * on invoices; documents get one.
 */
export const DOC_STATUS_BADGE: Record<string, StatusKey> = {
  draft: "neutral",
  sent: "scheduled",
  partially_signed: "pending",
  completed: "confirmed",
  declined: "cancelled",
  expired: "no_show",
  voided: "cancelled",
};

export const SIGNER_STATUS_BADGE: Record<string, StatusKey> = {
  pending: "neutral",
  viewed: "scheduled",
  signed: "confirmed",
  declined: "cancelled",
};
