/** What a new branch can copy from its main clinic (lib/branches). A plain module, so the admin form can import it. */
export const BRANCH_PARTS = ["services", "hours", "documents", "automations", "branding", "invoicing"] as const;
export type BranchPart = (typeof BRANCH_PARTS)[number];
