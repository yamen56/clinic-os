import { NextResponse } from "next/server";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { DateTime } from "luxon";

/** Payments as CSV (Excel-friendly UTF-8 BOM). */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const g = await apiClinic(slug);
  if (!g.ok) return g.res;
  const url = new URL(req.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  const rows = await inClinic(g.access, async (c) => {
    const conds = ["pay.clinic_id = $1"];
    const vals: unknown[] = [g.access.clinicId];
    if (from) {
      vals.push(from);
      conds.push(`pay.paid_at >= $${vals.length}`);
    }
    if (to) {
      vals.push(to);
      conds.push(`pay.paid_at < $${vals.length}`);
    }
    const r = await c.query(
      `select pay.paid_at, pay.amount, pay.method, pay.reference,
              i.number as invoice_number, i.currency, p.full_name as patient, u.full_name as recorded_by
       from payments pay
       join invoices i on i.id = pay.invoice_id
       join patients p on p.id = pay.patient_id
       left join users u on u.id = pay.recorded_by
       where ${conds.join(" and ")}
       order by pay.paid_at desc limit 5000`,
      vals
    );
    return r.rows;
  });

  const tz = g.access.clinic.timezone;

  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [
    ["date", "amount", "currency", "method", "invoice", "patient", "reference", "recorded_by"].join(","),
    ...rows.map((r) =>
      [
        DateTime.fromJSDate(new Date(r.paid_at)).setZone(tz).toFormat("yyyy-MM-dd HH:mm"),
        Number(r.amount).toFixed(2),
        r.currency,
        r.method,
        r.invoice_number,
        esc(r.patient),
        esc(r.reference),
        esc(r.recorded_by),
      ].join(",")
    ),
  ];
  return new NextResponse("﻿" + lines.join("\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="payments-${slug}.csv"`,
    },
  });
}
