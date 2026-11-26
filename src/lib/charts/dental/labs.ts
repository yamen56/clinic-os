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
 *
 * A bridge goes to the lab more than once (a dentist, 2026-11-25): for its
 * framework, for the porcelain, to be finished, with a try-in between. That is
 * one order at one price with several trips, not several orders; a remake is
 * the second order. What the lab needs to make it — which teeth, which carry
 * it and which are replaced, the material, the implants — is read from the
 * chart and kept on the order as it was sent.
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
  "implant_bridge",
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
  bridge: "impression",
  implant_bridge: "impression",
  veneer: "prep",
  hollywood_smile: "prep",
  inlay: "prep",
  onlay: "prep",
  implant_crown: "impression",
  implant_denture: "impression",
  denture_complete: "final",
  denture_partial: "final",
};

/** What the lab is to send back. */
export const LAB_STAGES = ["framework", "bisque", "jig", "teeth", "finish"] as const;
export type LabStage = (typeof LAB_STAGES)[number];

/**
 * The trips a treatment makes to the lab: after which of its steps it goes,
 * and what it may come back as. Work that is not here goes once, and comes
 * back finished.
 */
export const LAB_TRIPS: Record<string, { after: string; offers: LabStage[] }[]> = {
  bridge: [
    { after: "impression", offers: ["framework", "bisque", "finish"] },
    { after: "framework", offers: ["bisque", "finish"] },
    { after: "tryin", offers: ["finish"] },
  ],
  implant_bridge: [
    { after: "impression", offers: ["framework", "bisque", "finish"] },
    { after: "framework", offers: ["bisque", "finish"] },
    { after: "tryin", offers: ["finish"] },
  ],
  implant_denture: [
    { after: "impression", offers: ["jig", "framework", "teeth", "finish"] },
    { after: "jig", offers: ["framework", "teeth", "finish"] },
    { after: "framework", offers: ["teeth", "finish"] },
    { after: "tryin", offers: ["finish"] },
  ],
};

/** The step something back from the lab is tried in at: where the next trip leaves from. */
const TRIED_AT: Partial<Record<LabStage, string>> = { framework: "framework", bisque: "tryin", jig: "jig", teeth: "tryin" };

/** What a trip of this treatment may ask for. */
export function stagesFor(treatmentKey: string, after?: string): LabStage[] {
  const trips = LAB_TRIPS[treatmentKey];
  if (!trips) return ["finish"];
  return (after ? trips.find((x) => x.after === after) : trips[0])?.offers ?? ["finish"];
}

export function isLabStage(v: unknown): v is LabStage {
  return (LAB_STAGES as readonly string[]).includes(v as string);
}

/** Treatments a lab prices by the tooth: a bridge of three costs three of them. */
export const PER_TOOTH = new Set(["bridge", "implant_bridge"]);

/** One trip: what was asked for, and when it went, was due and came back. */
export type LabTrip = { stage: LabStage; sentOn: string; dueOn: string | null; receivedAt: string | null };

/** What the lab was told to make, as the chart had it when it was sent. */
export type LabSpec = {
  teeth?: { site: string; role: "abutment" | "pontic"; implant?: boolean }[];
  material?: string | null;
  implants?: { site: string; system?: string; diameter?: number | null; length?: number | null }[];
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
  /** What is being made now, or came back last. */
  stage: LabStage;
  /** Teeth it was priced for, when the lab prices by the tooth. */
  units: number | null;
  spec: LabSpec;
  /** The trips before this one, oldest first. */
  trips: LabTrip[];
  /**
   * The order as the lab opens it — a PDF behind a signed link (lab-order.ts),
   * minted by the server each time the case is read. Absent on a case drawn
   * before the server answered.
   */
  orderUrl?: string;
};

/** A short reference for the order, for the lab to quote back: from the case's id. */
export function orderRef(id: string): string {
  return id.replace(/-/g, "").slice(0, 6).toUpperCase();
}

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
    stage: isLabStage(r.stage) ? r.stage : "finish",
    units: r.units == null ? null : Number(r.units),
    spec: (r.spec as LabSpec) ?? {},
    trips: Array.isArray(r.trips) ? (r.trips as LabTrip[]) : [],
  };
}

/** Every trip of an order, the one it is on last. */
export function tripsOf(c: LabCase): LabTrip[] {
  return [...c.trips, { stage: c.stage, sentOn: c.sentOn, dueOn: c.dueOn, receivedAt: c.status === "received" ? c.receivedAt : null }];
}

/**
 * Where each trip stands among the treatment's steps: the first leaves after
 * the impression, the next from where what came back was tried in. Something
 * sent back finished and returned again stays where the last one was.
 */
export function tripAnchors(treatmentKey: string, trips: LabTrip[]): string[] {
  const plan = LAB_TRIPS[treatmentKey] ?? [];
  const keys = new Set(plan.map((p) => p.after));
  const out: string[] = [];
  for (let i = 0; i < trips.length; i++) {
    const tried = i === 0 ? plan[0]?.after : TRIED_AT[trips[i - 1].stage];
    out.push(tried && keys.has(tried) ? tried : (out[i - 1] ?? plan[0]?.after ?? ""));
  }
  return out;
}

/** The step the next trip would leave from, once this one is back; null when it came back finished. */
export function nextAnchor(treatmentKey: string, c: LabCase): string | null {
  if (c.status !== "received" || c.stage === "finish") return null;
  const tried = TRIED_AT[c.stage];
  return tried && (LAB_TRIPS[treatmentKey] ?? []).some((p) => p.after === tried) ? tried : null;
}

/** What an order starts at: the lab's price, once per tooth where it prices by the tooth. */
export function labCostFor(list: LabPrice[], labId: string, treatmentKey: string, variant: string | null, units: number): number | null {
  const price = labPriceFor(list, labId, treatmentKey, variant);
  if (price == null) return null;
  return Math.round(price * (PER_TOOTH.has(treatmentKey) ? Math.max(1, units) : 1) * 100) / 100;
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
