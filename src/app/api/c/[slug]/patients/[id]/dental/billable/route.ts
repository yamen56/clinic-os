import { NextResponse } from "next/server";
import { isUuid } from "@/lib/uuid";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { ownInvoicesOnly } from "@/lib/invoice-scope";
import { billableMarks, chartLines } from "@/lib/charts/dental/billing-server";
import { dictFor } from "@/lib/i18n/client-dict";
import { getLocale } from "@/lib/i18n";

/*
  The patient's chart work waiting to be billed, as invoice lines.

  The invoice builder asks for it when reception picks a patient, and offers
  the lines as "From the chart". An invoice typed by hand from the services
  list bills the same crown without saying so, and the chart would go on
  calling it unbilled — until somebody pressed Bill and the patient paid
  twice. Offered here, the line reception adds is the linked one.

  The lines are worded as Bill words them, in the language the services list
  gives its lines on the same screen.
*/
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const g = await apiClinic(slug, "invoices");
  if (!g.ok) return g.res;
  const access = g.access;
  if (!access.clinic.features.dental) return NextResponse.json({ ok: true, lines: [] });
  const locale = await getLocale();

  const lines = await inClinic(access, async (c) => {
    const p = await c.query(`select 1 from patients where id = $1 and clinic_id = $2 and merged_into is null`, [id, access.clinicId]);
    if (!p.rowCount) return null;
    // A doctor who sees only their own invoices is offered only their own work.
    const own = ownInvoicesOnly(access);
    if (own && !access.memberId) return [];
    const ids = await billableMarks(c, access.clinicId, id, own ? access.memberId! : null);
    return chartLines(c, access.clinicId, id, ids, locale, dictFor(locale).invoices.chartLine);
  });

  if (!lines) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true, lines });
}
