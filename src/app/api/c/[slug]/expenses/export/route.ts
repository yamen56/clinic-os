import { NextResponse } from "next/server";
import { apiClinic, inClinic } from "@/lib/clinic-api";

/** Expenses as CSV (Excel-friendly UTF-8 BOM). The accountant's deliverable. */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const g = await apiClinic(slug, "expenses");
  if (!g.ok) return g.res;

  const url = new URL(req.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  const rows = await inClinic(g.access, async (c) => {
    const conds = ["e.clinic_id = $1"];
    const vals: unknown[] = [g.access.clinicId];
    // Calendar dates on both sides — `spent_on` is a `date`, and a timestamp
    // bound would move a day for every clinic east of UTC.
    if (from) {
      vals.push(from);
      conds.push(`e.spent_on >= $${vals.length}::date`);
    }
    if (to) {
      vals.push(to);
      conds.push(`e.spent_on < $${vals.length}::date`);
    }
    const r = await c.query(
      `select e.spent_on, e.amount, e.method, e.vendor, e.note,
              ec.name as category, u.full_name as recorded_by,
              e.schedule_id is not null as recurring
         from expenses e
         left join expense_categories ec on ec.id = e.category_id
         left join users u on u.id = e.created_by
        where ${conds.join(" and ")}
        order by e.spent_on desc
        limit 5000`,
      vals
    );
    return r.rows;
  });

  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [
    ["date", "amount", "currency", "method", "category", "paid_to", "note", "recurring", "recorded_by"].join(","),
  ];
  for (const r of rows) {
    lines.push(
      [
        // Already a plain day, and never put through a zone conversion.
        String(r.spent_on).slice(0, 10),
        Number(r.amount).toFixed(2),
        g.access.clinic.currency,
        r.method,
        /*
          Everything a person can type goes through `esc`. The payments export
          escapes only half its columns, which is safe there because the rest
          are enum-constrained or generated — `vendor`, `note` and a
          clinic-named `category` are none of those, and a comma in "Amman Lab,
          Ltd" would otherwise split the row.
        */
        esc(r.category),
        esc(r.vendor),
        esc(r.note),
        r.recurring ? "yes" : "no",
        esc(r.recorded_by),
      ].join(",")
    );
  }

  return new NextResponse("﻿" + lines.join("\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="expenses-${slug}.csv"`,
      // Not cached: one member's export must not sit in a shared browser
      // profile for the next.
      "Cache-Control": "no-store, private",
    },
  });
}
