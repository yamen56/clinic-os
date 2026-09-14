import { guardCap } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { monthDateRange } from "@/lib/dates";
import {
  clinicExpenses,
  expensesByCategory,
  listExpenses,
  type ExpenseCategoryTotal,
  type ExpenseRow,
} from "@/lib/expenses";
import { ExpensesClient } from "./expenses-client";

/**
 * What the clinic spent, month by month.
 *
 * The ledger lives here and the profit line lives on `/earnings`, which is the
 * split the earnings screen itself already argues for: a total nobody can take
 * apart is a total nobody believes, and this is where it comes apart.
 */
export default async function ExpensesPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ m?: string }>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const access = await guardCap(slug, "expenses");

  // Clamped, because this is a URL: a two-thousand-month offset is a date
  // library exception rather than an empty page.
  const offset = Math.min(0, Math.max(-60, Number(sp.m) || 0));
  const tz = access.clinic.timezone;
  /*
    Calendar dates, not the UTC instants `monthRangeUtc` returns. `spent_on` is a
    `date`, and comparing it against `…-08-31T21:00:00Z` would pull the 31st of
    August into September for every clinic east of UTC.
  */
  const { from, to } = monthDateRange(tz, offset);

  const data = await inClinic(access, async (c) => {
    const scope = { clinicId: access.clinicId, from, to };
    const total = await clinicExpenses(c, scope);
    const rows: ExpenseRow[] = await listExpenses(c, scope);
    const byCategory: ExpenseCategoryTotal[] = await expensesByCategory(c, scope);

    const categories = (
      await c.query(
        `select id, name, name_ar, color, is_system, active, sort
           from expense_categories where clinic_id = $1 order by sort, name`,
        [access.clinicId]
      )
    ).rows;

    const schedules = (
      await c.query(
        `select s.id, s.category_id, s.amount, s.vendor, s.note, s.method,
                s.day_of_month, s.active, s.last_posted_on, ec.name as category_name,
                ec.name_ar as category_name_ar
           from expense_schedules s
           left join expense_categories ec on ec.id = s.category_id
          where s.clinic_id = $1
          order by s.day_of_month, s.vendor`,
        [access.clinicId]
      )
    ).rows;

    return { total, rows, byCategory, categories, schedules };
  });

  return (
    <ExpensesClient
      slug={slug}
      currency={access.clinic.currency}
      timezone={tz}
      offset={offset}
      monthFrom={from}
      monthTo={to}
      total={data.total}
      rows={JSON.parse(JSON.stringify(data.rows))}
      byCategory={JSON.parse(JSON.stringify(data.byCategory))}
      categories={JSON.parse(JSON.stringify(data.categories))}
      schedules={JSON.parse(JSON.stringify(data.schedules))}
    />
  );
}
