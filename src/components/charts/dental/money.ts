/**
 * A treatment's money, as the plan, its card and the desk read it: what it
 * costs this patient, whether it is billed, how much of it is paid, and
 * whether it waits to be billed.
 *
 * A treatment is billed once, at its whole price — a bridge its fee once per
 * tooth it spans — and the patient pays it off over the visits, in parts, on
 * that one invoice. Waiting to be billed means started or done since the
 * clinic began billing from the chart, not free, and not yet on an invoice
 * that still stands. The desk's list and the builder's "From the chart"
 * (billing-server.ts) apply the same rule in SQL: change one, change both.
 */

import { isToothSite, type Mark } from "@/lib/charts/dental/state";
import type { StepRecord } from "@/lib/charts/dental/protocols";
import type { Billed } from "@/lib/charts/dental/billing-server";
import type { PriceRow } from "@/lib/charts/dental/pricing";

export type Money = {
  fee: number | null;
  /** Teeth of a bridge; 1 otherwise. */
  units: number;
  /** fee × units, or null when unpriced. */
  amount: number | null;
  billedQty: number;
  billed: boolean;
  invoices: { id: string; number: string; status: string }[];
  /** What its invoice lines charged, tax included — 0 until billed. */
  charged: number;
  /** Of that, what the patient has paid so far. */
  paid: number;
  /** charged − paid: what is left to pay on it. */
  left: number;
  /** Started or done, since billing from the chart began, and not on an invoice yet. */
  toBill: boolean;
  /** The units still to bill — every unit, or 0 when nothing waits. */
  dueUnits: number;
  /** fee × dueUnits, or null when unpriced. */
  due: number | null;
};

export function moneyOf(
  m: Mark,
  ctx: { marks: Mark[]; steps: StepRecord[]; prices: PriceRow[]; billing: Billed[]; billingSince: string | null; tz: string }
): Money {
  const mates = m.groupId ? ctx.marks.filter((x) => x.groupId === m.groupId && !x.voidedAt) : [];
  const archParent = mates.some((x) => !isToothSite(x.site));
  const units = mates.length > 1 && !archParent ? mates.filter((x) => isToothSite(x.site)).length : 1;
  const b = ctx.billing.find((x) => x.markId === m.id);
  const billedQty = b?.qty ?? 0;
  const charged = b?.charged ?? 0;
  const paid = Math.min(b?.paid ?? 0, charged);
  const started = m.status === "done" || !!m.startedAt;
  const since = ctx.billingSince ? Date.parse(ctx.billingSince) : 0;
  const when = Date.parse(m.doneAt ?? m.startedAt ?? m.createdAt);
  // A fee of 0 is the doctor saying "no charge": nothing waits to be billed.
  const toBill = m.kind === "procedure" && m.status !== "existing" && !m.voidedAt && m.fee !== 0 && started && when >= since && billedQty === 0;
  const dueUnits = toBill ? units : 0;
  return {
    fee: m.fee,
    units,
    amount: m.fee == null ? null : m.fee * units,
    billedQty,
    billed: billedQty > 0,
    invoices: b?.invoices ?? [],
    charged,
    paid,
    left: Math.round((charged - paid) * 100) / 100,
    toBill,
    dueUnits,
    due: m.fee == null ? null : m.fee * dueUnits,
  };
}
