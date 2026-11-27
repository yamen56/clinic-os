import { withCtx } from "./db";
import { dayRangeUtc, monthRangeUtc } from "./dates";
import { owedSql } from "./invoices";
import type { Membership } from "./auth";

/**
 * A clinic's branches side by side (2026-11-27) — the owner's view of the
 * group: today, this month's money, what is still owed, new patients and
 * no-shows, one row per branch and a total.
 *
 * Each branch is read in its own context, one after another, by somebody who
 * holds `invoices.analytics` in *that* branch: a row is shown only where the
 * person could open that branch's own Analytics, so this page cannot be a way
 * round the access editor of a branch they only work at.
 */

export type BranchFigures = {
  slug: string;
  name: string;
  currency: string;
  today: number;
  collected: number;
  owed: number;
  newPatients: number;
  noShows: number;
};

export async function branchFigures(
  userId: string,
  branches: Pick<Membership, "clinicId" | "clinicSlug" | "clinicName" | "clinicNameAr" | "timezone" | "currency" | "role">[],
  locale: string
): Promise<BranchFigures[]> {
  const out: BranchFigures[] = [];
  for (const b of branches) {
    const day = dayRangeUtc(b.timezone);
    const month = monthRangeUtc(b.timezone);
    const row = await withCtx({ userId, clinicId: b.clinicId, role: b.role }, async (c) =>
      (
        await c.query(
          `select
             (select count(*)::int from appointments where clinic_id = $1 and starts_at >= $2 and starts_at < $3
                and status not in ('cancelled')) as today,
             (select coalesce(sum(p.amount), 0)::float8 from payments p join invoices v on v.id = p.invoice_id and v.status <> 'void'
               where p.clinic_id = $1 and p.paid_at >= $4 and p.paid_at < $5) as collected,
             (select coalesce(sum(i.total - i.amount_paid), 0)::float8 from invoices i where i.clinic_id = $1 and ${owedSql("i")}) as owed,
             (select count(*)::int from patients where clinic_id = $1 and merged_into is null and created_at >= $4 and created_at < $5) as new_patients,
             (select count(*)::int from appointments where clinic_id = $1 and status = 'no_show' and starts_at >= $4 and starts_at < $5) as no_shows`,
          [b.clinicId, day.start, day.end, month.start, month.end]
        )
      ).rows[0]
    );
    out.push({
      slug: b.clinicSlug,
      name: (locale === "en" ? null : b.clinicNameAr) || b.clinicName,
      currency: b.currency,
      today: row.today,
      collected: Number(row.collected),
      owed: Number(row.owed),
      newPatients: row.new_patients,
      noShows: row.no_shows,
    });
  }
  return out;
}
