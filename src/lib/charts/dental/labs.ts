/**
 * Dental labs, and the work a treatment sends to one (0082).
 *
 * Yamen, 2026-10-17: "a place for dental lab when its needed for the
 * treatment … some clinics have the dental lab inside of there clinic and
 * some of them work with multiple independent labs". A clinic keeps its labs
 * — its own, in-house, and any number outside — each with what it charges.
 * Work sent to one is a lab case on the treatment: which lab, what it costs,
 * when it went and is due back, whether it came back. Its cost is the
 * treatment's lab cost, and comes into the doctor's share by the doctor's
 * deal (earnings.ts).
 *
 * Shared by the server and the chart, so it imports nothing of either.
 */

/** Treatments that are made at a lab: they ask for one once the impression is taken. Any other can still have lab work added. */
export const LAB_TREATMENTS = new Set([
  "crown",
  "bridge",
  "veneer",
  "hollywood_smile",
  "inlay",
  "onlay",
  "implant_crown",
  "implant_denture",
  "denture_complete",
  "denture_partial",
  "denture_repair",
  "retainer",
  "aligners",
  "post_core",
]);

/** The step after which the work goes to the lab: the impression is what it is made from. */
export const LAB_AFTER_STEP: Record<string, string> = {
  crown: "prep",
  bridge: "prep",
  veneer: "prep",
  hollywood_smile: "prep",
  inlay: "prep",
  onlay: "prep",
  implant_crown: "impression",
  implant_denture: "impression",
  denture_complete: "final",
  denture_partial: "final",
};

export type LabRow = { id: string; name: string; phone: string; inHouse: boolean; note: string; active: boolean };
export type LabPrice = { labId: string; chartKey: string; variant: string | null; cost: number };
export type LabCaseStatus = "sent" | "received" | "cancelled";
export type LabCase = {
  id: string;
  markId: string;
  labId: string;
  cost: number;
  status: LabCaseStatus;
  /** Calendar dates, as the clinic writes them: "2026-10-17". */
  sentOn: string;
  dueOn: string | null;
  receivedAt: string | null;
  shade: string;
  note: string;
  /** Paid for: the lab's bill was recorded as an expense. Its cost is settled then. */
  paid: boolean;
  createdAt: string;
};

const day = (v: unknown): string | null => {
  if (v == null) return null;
  if (typeof v === "string") return v.slice(0, 10);
  // node-pg hands a `date` back as a Date at the server's local midnight.
  const d = v as Date;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const iso = (v: unknown): string | null => (v == null ? null : new Date(v as string).toISOString());

export function toLab(r: Record<string, unknown>): LabRow {
  return {
    id: r.id as string,
    name: r.name as string,
    phone: (r.phone as string) ?? "",
    inHouse: !!r.in_house,
    note: (r.note as string) ?? "",
    active: r.active !== false,
  };
}

export function toLabCase(r: Record<string, unknown>): LabCase {
  return {
    id: r.id as string,
    markId: r.mark_id as string,
    labId: r.lab_id as string,
    cost: Number(r.cost),
    status: (r.status as LabCaseStatus) ?? "sent",
    sentOn: day(r.sent_on)!,
    dueOn: day(r.due_on),
    receivedAt: iso(r.received_at),
    shade: (r.shade as string) ?? "",
    note: (r.note as string) ?? "",
    paid: !!r.expense_id,
    createdAt: iso(r.created_at)!,
  };
}

/** What a lab charges for a treatment: its kind's price, else the treatment's. Null when it has neither. */
export function labPriceFor(list: LabPrice[], labId: string, treatmentKey: string, variant: string | null): number | null {
  const hit =
    (variant ? list.find((p) => p.labId === labId && p.chartKey === treatmentKey && p.variant === variant) : undefined) ??
    list.find((p) => p.labId === labId && p.chartKey === treatmentKey && p.variant === null);
  return hit ? hit.cost : null;
}

/** Back later than promised, and still out. */
export function isOverdue(c: LabCase, today: string): boolean {
  return c.status === "sent" && !!c.dueOn && c.dueOn < today;
}
