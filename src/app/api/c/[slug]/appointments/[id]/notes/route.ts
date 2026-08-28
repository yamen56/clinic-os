import { NextResponse } from "next/server";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { createNote, defaultCategoryId, loadAppointmentNotes } from "@/lib/notes";

/**
 * The notes written about one visit.
 *
 * Reading and writing from the appointment rather than from the patient file is
 * the whole point: a doctor finishing a consultation is looking at the
 * appointment, and asking them to navigate to the patient, find the notes tab
 * and remember which visit it was about is how the note ends up unwritten.
 *
 * Both directions go through `lib/notes`, so a note filed here is the same kind
 * of record as one typed on the file — versioned from creation, never
 * deletable, and visible in both places at once.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await ctx.params;
  const g = await apiClinic(slug, "patients");
  if (!g.ok) return g.res;

  const notes = await inClinic(g.access, async (c) => {
    // Scoped to the clinic before anything is read back, so an appointment id
    // from another tenant returns nothing rather than somebody's notes.
    const appt = await c.query(
      `select 1 from appointments where id = $1 and clinic_id = $2`,
      [id, g.access.clinicId]
    );
    if (!appt.rowCount) return null;
    return loadAppointmentNotes(c, g.access.clinicId, id);
  });
  if (!notes) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ notes });
}

export async function POST(req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await ctx.params;
  const g = await apiClinic(slug, "patients");
  if (!g.ok) return g.res;

  let body: { body?: string; categoryId?: string | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  const text = (body.body ?? "").trim().slice(0, 20000);
  if (!text) return NextResponse.json({ error: "empty" }, { status: 400 });

  const out = await inClinic(g.access, async (c) => {
    // The patient comes from the appointment, never from the caller — that is
    // what makes it impossible to file a note against the wrong person's visit.
    const appt = (
      await c.query(`select patient_id from appointments where id = $1 and clinic_id = $2`, [
        id,
        g.access.clinicId,
      ])
    ).rows[0];
    if (!appt) return null;

    let cat = body.categoryId ?? null;
    if (cat) {
      const ok = await c.query(`select 1 from note_categories where id = $1 and clinic_id = $2`, [
        cat,
        g.access.clinicId,
      ]);
      if (!ok.rowCount) cat = null;
    }
    if (!cat) cat = await defaultCategoryId(c, g.access.clinicId);

    const noteId = await createNote(c, g.access.clinicId, {
      patientId: appt.patient_id,
      authorId: g.access.session.user.id,
      body: text,
      categoryId: cat,
      appointmentId: id,
    });
    await audit(c, {
      clinicId: g.access.clinicId,
      userId: g.access.session.user.id,
      impersonatedBy: g.access.session.impersonatedBy,
      action: "patient.note.create",
      entity: "patient_note",
      entityId: noteId,
      detail: { patientId: appt.patient_id, appointmentId: id },
    });
    return { id: noteId };
  });

  if (!out) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true, ...out });
}
