import { NextResponse } from "next/server";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { renderUrlToPdf } from "@/lib/pdf";
import { printKeyFor } from "@/lib/print-token";
import { appUrl } from "@/lib/urls";
import { fileResponseHeaders } from "@/lib/download";
import { MAX_EXPORT_RECORDS, loadPatientExportBatch } from "@/lib/patient-export";
import { buildPatientWorkbook, MAX_SHEET_RECORDS } from "@/lib/patient-sheet";
import { dictForClinic } from "@/lib/i18n";
import { patientFilterSql, type PatientFilters } from "@/lib/patients";
import { can, hasRecentAuth } from "@/lib/auth";

/**
 * Never cached, not even privately.
 *
 * `fileResponseHeaders` defaults to `private, max-age=3600`, which is right for
 * the stored files it was written for — a scan does not change and re-fetching
 * it costs a round trip for nothing. This response is different in two ways: it
 * is the entire patient database, and the browser cache is per profile rather
 * than per session. A receptionist signing in after the owner on the same
 * machine, at the same URL, would otherwise be handed the owner's copy out of
 * cache without the request ever reaching the owner-only check.
 *
 * Caught by the QA suite, which saw a member with full access get a 200 for the
 * spreadsheet and a 403 for the PDF — the same guard, differing only in which
 * of the two URLs had been fetched before.
 */
const NO_CACHE = "no-store, private";

/**
 * Every patient record the clinic holds, as one PDF — or, with `?format=xlsx`,
 * as a spreadsheet.
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
 *
 * The two formats share this door on purpose — one owner gate, one filter, one
 * audit row — and differ only in what they hand back and how much of it they can
 * carry. The spreadsheet's limit is an order of magnitude higher because nothing
 * in its path goes near a browser; see MAX_SHEET_RECORDS.
 */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const g = await apiClinic(slug, "patients");
  if (!g.ok) return g.res;
  const { access } = g;

  /*
    Was owner-only; now a capability the owner can hand out, because a practice
    manager who is not the account owner still has to be able to produce the
    clinic's records. The owner keeps it either way — `resolveCapabilities`
    grants an owner everything — so this is strictly a widening of who *can* be
    given it, never of who has it by default: an existing member's stored map is
    silent about `patients.export`, and silence here means no.
  */
  if (!can(access, "patients.export") && !access.session.user.isSuperAdmin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  /*
    And then the password, again, on top of the capability.

    Everything else in the product is one patient at a time, which is the job
    and leaves a trail shaped like the job. This hands over the entire record
    set in a single file — the one request where a session found unattended, or
    a cookie lifted from a machine, is the whole clinic rather than one screen.
    Ten minutes of grace, so producing both formats does not ask twice.

    A 403 the client knows how to recover from, not a redirect: the caller is a
    fetch behind a download button, and it retries this exact URL once the
    password has been given. See `ReauthPrompt`.
  */
  if (!(await hasRecentAuth(access.session.sessionId))) {
    return NextResponse.json({ error: "reauth_required" }, { status: 403 });
  }

  const url = new URL(req.url);
  const wantsSheet = url.searchParams.get("format") === "xlsx";
  const limit = wantsSheet ? MAX_SHEET_RECORDS : MAX_EXPORT_RECORDS;
  const filters: PatientFilters = {
    q: url.searchParams.get("q") ?? undefined,
    tag: url.searchParams.get("tag") ?? undefined,
    source: url.searchParams.get("source") ?? undefined,
    visit: url.searchParams.get("visit") ?? undefined,
    optedOut: url.searchParams.get("optedOut") ?? undefined,
  };

  /* Count before rendering. The print page applies the identical filter, so
     this is the number that will be in the document. */
  const { where, values } = patientFilterSql(access.clinicId, filters);
  const total = await inClinic(access, async (c) => {
    const r = await c.query(`select count(*)::int as n from patients p where ${where}`, values);
    return r.rows[0].n as number;
  });

  if (total === 0) return NextResponse.json({ error: "empty" }, { status: 404 });
  if (total > limit) {
    return NextResponse.json({ error: "too_many", count: total, max: limit }, { status: 413 });
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const safeSlug = slug.replace(/[^a-z0-9_-]/gi, "") || "clinic";

  /*
    The spreadsheet is built here rather than behind the print page: it is data,
    not a rendering, so it needs neither the signed print token nor the worker.
    That is also why it can carry ten times as many records — there is no
    30-second Chromium budget in the way.
  */
  if (wantsSheet) {
    const t = await dictForClinic(access.clinic.vocabulary);
    let buf: Buffer;
    try {
      const batch = await inClinic(access, async (c) => {
        const ids = (
          await c.query(
            `select p.id from patients p where ${where} order by p.full_name limit ${limit}`,
            values
          )
        ).rows.map((r) => r.id as string);
        return loadPatientExportBatch(c, access.clinicId, ids);
      });
      buf = Buffer.from(await buildPatientWorkbook(batch, t).xlsx.writeBuffer());
    } catch (e) {
      console.error("[patients export-all xlsx]", (e as Error).message);
      return NextResponse.json({ error: "render_failed" }, { status: 502 });
    }

    await inClinic(access, (c) =>
      audit(c, {
        clinicId: access.clinicId,
        userId: access.session.user.id,
        impersonatedBy: access.session.impersonatedBy,
        action: "patient.export_all",
        entity: "clinic",
        entityId: access.clinicId,
        detail: { count: total, bytes: buf.length, filters, format: "xlsx" },
      })
    );

    return new NextResponse(new Uint8Array(buf), {
      headers: fileResponseHeaders({
        declaredType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        fileName: `${safeSlug}-patients-${stamp}.xlsx`,
        size: buf.length,
        wantsDownload: true,
        cacheControl: NO_CACHE,
      }),
    });
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
      detail: { count: total, bytes: pdf.length, filters, format: "pdf" },
    })
  );

  return new NextResponse(new Uint8Array(pdf), {
    headers: fileResponseHeaders({
      declaredType: "application/pdf",
      fileName: `${safeSlug}-patients-${stamp}.pdf`,
      size: pdf.length,
      wantsDownload: true,
      cacheControl: NO_CACHE,
    }),
  });
}
