import { NextResponse } from "next/server";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { renderUrlToPdf } from "@/lib/pdf";
import { printKeyFor } from "@/lib/print-token";
import { appUrl } from "@/lib/urls";
import { fileResponseHeaders } from "@/lib/download";
import { MAX_EXPORT_RECORDS } from "@/lib/patient-export";
import { patientFilterSql, type PatientFilters } from "@/lib/patients";

/**
 * Every patient record the clinic holds, as one PDF.
 *
 * Asked for when a clinic is backing itself up, moving to another system, or
 * being wound down — the moments when "it is all in the software" needs to stop
 * being true.
 *
 * Restricted to the clinic owner. A receptionist can already open any single
 * file, which is the job; walking out with the entire database in one click is
 * not, and the distinction between the two is exactly what this gate is. Change
 * the `isOwner` check below to open it to anyone with the patients module.
 *
 * The whole set is rendered in a single Chromium pass. Anything larger than
 * MAX_EXPORT_RECORDS is refused with the number, rather than quietly truncated:
 * a medical export that silently stops at four hundred is worse than one that
 * did not happen.
 */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const g = await apiClinic(slug, "patients");
  if (!g.ok) return g.res;
  const { access } = g;

  if (!access.isOwner && !access.session.user.isSuperAdmin) {
    return NextResponse.json({ error: "owner_only" }, { status: 403 });
  }

  const url = new URL(req.url);
  const filters: PatientFilters = {
    q: url.searchParams.get("q") ?? undefined,
    tag: url.searchParams.get("tag") ?? undefined,
    source: url.searchParams.get("source") ?? undefined,
    visit: url.searchParams.get("visit") ?? undefined,
  };

  /* Count before rendering. The print page applies the identical filter, so
     this is the number that will be in the document. */
  const { where, values } = patientFilterSql(access.clinicId, filters);
  const total = await inClinic(access, async (c) => {
    const r = await c.query(`select count(*)::int as n from patients p where ${where}`, values);
    return r.rows[0].n as number;
  });

  if (total === 0) return NextResponse.json({ error: "empty" }, { status: 404 });
  if (total > MAX_EXPORT_RECORDS) {
    return NextResponse.json(
      { error: "too_many", count: total, max: MAX_EXPORT_RECORDS },
      { status: 413 }
    );
  }

  const { exp, sig } = printKeyFor(access.clinicId, "patients");
  const qs = new URLSearchParams({ kind: "patients", exp: String(exp), sig });
  for (const [k, v] of Object.entries(filters)) if (v) qs.set(k, v);

  let pdf: Buffer;
  try {
    pdf = await renderUrlToPdf(`${appUrl()}/patients-print/${access.clinicId}?${qs}`);
  } catch (e) {
    console.error("[patients export-all]", (e as Error).message);
    return NextResponse.json({ error: "render_failed" }, { status: 502 });
  }

  /* Audited with the count and the filter. This is the whole patient database
     leaving the building; "who, when, and how much" is the least the record
     of it should say. */
  await inClinic(access, (c) =>
    audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "patient.export_all",
      entity: "clinic",
      entityId: access.clinicId,
      detail: { count: total, bytes: pdf.length, filters },
    })
  );

  const stamp = new Date().toISOString().slice(0, 10);
  const safeSlug = slug.replace(/[^a-z0-9_-]/gi, "") || "clinic";

  return new NextResponse(new Uint8Array(pdf), {
    headers: fileResponseHeaders({
      declaredType: "application/pdf",
      fileName: `${safeSlug}-patients-${stamp}.pdf`,
      size: pdf.length,
      wantsDownload: true,
    }),
  });
}
