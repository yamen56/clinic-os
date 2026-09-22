import { NextResponse } from "next/server";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import {
  patientFilterSql,
  patientListRowsSql,
  toPatientListRow,
  PATIENT_PAGE_SIZE,
  type PatientFilters,
} from "@/lib/patients";

/**
 * The next page of the patient list.
 *
 * The list is rendered on the server and its first page arrives with the
 * document; this is only for "load more", so it returns rows and nothing else —
 * no count, no tag list, both of which the page already has and neither of
 * which changes as somebody pages down.
 *
 * **Keyset, not offset.** `offset 100` re-walks the hundred rows it is about to
 * discard, so paging gets slower the further down somebody goes, and any insert
 * above the window shifts every later page by one — which shows up as a record
 * appearing twice or not at all. The cursor is the last row the client actually
 * has, so neither happens and every page costs the same.
 */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const g = await apiClinic(slug, "patients");
  if (!g.ok) return g.res;

  const url = new URL(req.url);
  const filters: PatientFilters = {
    q: url.searchParams.get("q") ?? undefined,
    tag: url.searchParams.get("tag") ?? undefined,
    source: url.searchParams.get("source") ?? undefined,
    visit: url.searchParams.get("visit") ?? undefined,
    optedOut: url.searchParams.get("optedOut") ?? undefined,
  };

  /*
    Both halves of the cursor or neither. A timestamp without its id is not a
    position in this ordering — it is a position in a tie — and honouring it
    would skip whatever shares that millisecond.
  */
  const cursorTs = url.searchParams.get("cursorTs");
  const cursorId = url.searchParams.get("cursorId");
  const hasCursor = Boolean(cursorTs && cursorId);
  if ((cursorTs || cursorId) && !hasCursor) {
    return NextResponse.json({ error: "bad_cursor" }, { status: 400 });
  }
  // A malformed uuid would otherwise reach the database as a cast error rather
  // than an answer.
  if (hasCursor && !/^[0-9a-f-]{36}$/i.test(cursorId!)) {
    return NextResponse.json({ error: "bad_cursor" }, { status: 400 });
  }

  const { where, values } = patientFilterSql(g.access.clinicId, filters);
  const sql = patientListRowsSql(where, hasCursor ? values.length + 1 : null);
  if (hasCursor) values.push(cursorTs, cursorId);

  const rows = await inClinic(g.access, async (c) => (await c.query(sql, values)).rows);

  return NextResponse.json({
    patients: rows.map(toPatientListRow),
    // Whether asking again is worth it, decided here rather than inferred by the
    // client from a row count it would have to know the page size to read.
    hasMore: rows.length === PATIENT_PAGE_SIZE,
  });
}
