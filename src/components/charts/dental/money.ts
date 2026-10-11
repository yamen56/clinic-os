/**
 * A treatment's money, as the plan, its card and the desk read it: what it
 * costs this patient, how much of it is billed, and whether some of it waits
 * to be billed.
 *
 * A bridge costs its fee once per tooth it spans; a price per visit costs its
 * fee once per visit its steps took. Waiting to be billed means started or
 * done since the clinic began billing from the chart, not free, and not yet
 * on an invoice that still stands — all of it, or for a per-visit price,
 * every visit of it. The desk's list and the builder's "From the chart"
 * (billing-server.ts) apply the same rule in SQL: change one, change both.
 */

import { isToothSite, type Mark } from "@/lib/charts/dental/state";
import { EMERGENCY_STEP, type StepRecord } from "@/lib/charts/dental/protocols";
import type { Billed } from "@/lib/charts/dental/billing-server";
import { unitOf, type PriceRow } from "@/lib/charts/dental/pricing";
import { sessionsOf } from "@/lib/charts/dental/treatment";

export type Money = {
  fee: number | null;
  unit: "item" | "session";
  /** Teeth of a bridge, or visits of a per-visit price; 1 otherwise. */
  units: number;
  /** fee × units, or null when unpriced. */
  amount: number | null;
  billedQty: number;
  billed: boolean;
  invoices: { id: string; number: string; status: string }[];
  /** Started or done, since billing from the chart began, and not all on an invoice yet. */
  toBill: boolean;
  /** The units still to bill — every unit, or a per-visit price's visits not yet billed. 0 when nothing waits. */
  dueUnits: number;
  /** fee × dueUnits, or null when unpriced. */
  due: number | null;
};

export function moneyOf(
  m: Mark,
  ctx: { marks: Mark[]; steps: StepRecord[]; prices: PriceRow[]; billing: Billed[]; billingSince: string | null; tz: string }
): Money {
  const unit = unitOf(m, ctx.prices);
  const own = ctx.steps.filter((s) => s.markId === m.id && !s.voidedAt && s.step !== EMERGENCY_STEP);
  // A price per visit counts visits only on treatments that have steps; one-tap work is one visit each time it is charted.
  const perVisit = unit === "session" && own.length > 0;
  const sessions = perVisit ? sessionsOf(own, ctx.tz).sessions : 0;
  const mates = m.groupId ? ctx.marks.filter((x) => x.groupId === m.groupId && !x.voidedAt) : [];
  const archParent = mates.some((x) => !isToothSite(x.site));
  const teeth = mates.length > 1 && !archParent ? mates.filter((x) => isToothSite(x.site)).length : 1;
  const units = perVisit ? Math.max(sessions, 1) : teeth;
  const b = ctx.billing.find((x) => x.markId === m.id);
  const billedQty = b?.qty ?? 0;
  const started = m.status === "done" || !!m.startedAt;
  const since = ctx.billingSince ? Date.parse(ctx.billingSince) : 0;
  const when = Date.parse(m.doneAt ?? m.startedAt ?? m.createdAt);
  const owed = perVisit ? sessions > billedQty : billedQty === 0;
  // A fee of 0 is the doctor saying "no charge": nothing waits to be billed.
  const toBill = m.kind === "procedure" && m.status !== "existing" && !m.voidedAt && m.fee !== 0 && started && when >= since && owed;
  const dueUnits = toBill ? (perVisit ? sessions - billedQty : units) : 0;
  return {
    fee: m.fee,
    unit,
    units,
    amount: m.fee == null ? null : m.fee * units,
    billedQty,
    billed: billedQty > 0,
    invoices: b?.invoices ?? [],
    toBill,
    dueUnits,
    due: m.fee == null ? null : m.fee * dueUnits,
  };
}
