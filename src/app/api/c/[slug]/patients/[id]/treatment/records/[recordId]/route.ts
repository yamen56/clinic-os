import { NextResponse } from "next/server";
import { z } from "zod";
import { isUuid } from "@/lib/uuid";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { auditView } from "@/lib/audit";
import { RECORD_SELECT, toRecord } from "@/lib/treatment/db";
import { cleanVitalsPatch } from "@/lib/treatment/vitals";

/*
  A visit's record — complaint, examination, diagnosis, plan — saved as it is
  typed (lib/use-autosave posts `{ patch }` here).

  The browser chooses the record's id, so the first keystroke and the row it
  makes are the same record. `?visit=` names the appointment it is about and
  is read only when the row is made; a visit has one record, so a second
  doctor's first save lands on the first doctor's row rather than beside it.

  What it said before is kept: one version per sitting — the same person
  within ten minutes rewrites their own latest version, so typing does not
  write a row per pause.
*/

const bodySchema = z.object({
  patch: z
    .object({
      complaint: z.string().max(4000).optional(),
      exam: z.string().max(8000).optional(),
      diagnosis: z.string().max(2000).optional(),
      plan: z.string().max(4000).optional(),
      /** Vital signs by name (0125): a number to set, null to clear. Checked by cleanVitalsPatch. */
      vitals: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
});

export async function POST(req: Request, ctx: { params: Promise<{ slug: string; id: string; recordId: string }> }) {
  const { slug, id, recordId } = await ctx.params;
  if (!isUuid(id) || !isUuid(recordId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const g = await apiClinic(slug, "patients.charts");
  if (!g.ok) return g.res;
  const access = g.access;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const p = parsed.data.patch;
  const vitals = p.vitals === undefined ? null : cleanVitalsPatch(p.vitals);
  if (p.vitals !== undefined && !vitals) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const visit = new URL(req.url).searchParams.get("visit");
  if (visit && !isUuid(visit)) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const me = access.session.user.id;

  const result = await inClinic(access, async (c) => {
    const patient = await c.query(`select 1 from patients where id = $1 and clinic_id = $2 and merged_into is null`, [id, access.clinicId]);
    if (!patient.rowCount) return { error: "not_found" as const };

    let target = (
      await c.query(`select id from visit_records where id = $1 and patient_id = $2 and clinic_id = $3 for update`, [recordId, id, access.clinicId])
    ).rows[0]?.id as string | undefined;

    if (!target) {
      let doctor: string | null = access.role === "doctor" ? access.memberId : null;
      if (visit) {
        // A foreign key does not see row security: the visit is checked against this patient by hand.
        const a = (await c.query(`select doctor_member_id from appointments where id = $1 and patient_id = $2 and clinic_id = $3`, [visit, id, access.clinicId])).rows[0];
        if (!a) return { error: "invalid_visit" as const };
        doctor = a.doctor_member_id ?? doctor;
      }
      // Any conflict: this id already made (a retry), or the visit already has its record.
      const made = (
        await c.query(
          `insert into visit_records (id, clinic_id, patient_id, appointment_id, doctor_member_id, recorded_by, updated_by)
           values ($1, $2, $3, $4, $5, $6, $6) on conflict do nothing returning id`,
          [recordId, access.clinicId, id, visit, doctor, me]
        )
      ).rows[0]?.id as string | undefined;
      target =
        made ??
        ((
          await c.query(`select id from visit_records where clinic_id = $1 and patient_id = $2 and (id = $3 or appointment_id = $4) for update`, [
            access.clinicId,
            id,
            recordId,
            visit,
          ])
        ).rows[0]?.id as string | undefined);
      if (!target) return { error: "not_found" as const };
    }

    await c.query(
      `update visit_records
          set complaint = coalesce($2, complaint), exam = coalesce($3, exam),
              diagnosis = coalesce($4, diagnosis), plan = coalesce($5, plan), updated_by = $6,
              -- A reading merged in; a cleared one (null) taken out.
              vitals = case when $7::jsonb is null then vitals else jsonb_strip_nulls(vitals || $7::jsonb) end
        where id = $1`,
      [target, p.complaint ?? null, p.exam ?? null, p.diagnosis ?? null, p.plan ?? null, me, vitals ? JSON.stringify(vitals) : null]
    );
    const row = (await c.query(`${RECORD_SELECT} where r.id = $1`, [target])).rows[0];

    const sitting = (
      await c.query(
        `select id from visit_record_versions
          where record_id = $1 and author_id = $2 and updated_at > now() - interval '10 minutes'
          order by created_at desc limit 1`,
        [target, me]
      )
    ).rows[0]?.id as string | undefined;
    if (sitting) {
      await c.query(`update visit_record_versions set complaint = $2, exam = $3, diagnosis = $4, plan = $5, vitals = $6 where id = $1`, [
        sitting,
        row.complaint,
        row.exam,
        row.diagnosis,
        row.plan,
        JSON.stringify(row.vitals ?? {}),
      ]);
    } else {
      await c.query(
        `insert into visit_record_versions (clinic_id, record_id, complaint, exam, diagnosis, plan, vitals, author_id) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [access.clinicId, target, row.complaint, row.exam, row.diagnosis, row.plan, JSON.stringify(row.vitals ?? {}), me]
      );
    }
    // Once an hour per person: a record typed over a visit is one line of the file's activity, not forty.
    await auditView(c, {
      clinicId: access.clinicId,
      userId: me,
      impersonatedBy: access.session.impersonatedBy,
      action: "treatment.record",
      entity: "patient",
      entityId: id,
      detail: { record: target },
    });
    return { record: toRecord(row) };
  });

  if ("error" in result) return NextResponse.json({ error: result.error }, { status: result.error === "not_found" ? 404 : 400 });
  return NextResponse.json({ ok: true, ...result });
}
