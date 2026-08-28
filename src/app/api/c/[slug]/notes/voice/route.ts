import { NextResponse } from "next/server";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { saveFile } from "@/lib/storage";
import { createNote, defaultCategoryId } from "@/lib/notes";

/*
  A voice note.

  Ten megabytes is about twenty minutes of the Opus-in-WebM that every browser
  records by default — far more than the thirty seconds this exists for, and
  small enough that a bad recording cannot fill the clinic's storage.
*/
const MAX_SIZE = 10 * 1024 * 1024;
const ALLOWED = /^audio\/(webm|ogg|mp4|mpeg|wav|aac|x-m4a)/;

/**
 * Records a spoken note against a patient.
 *
 * A note, not a file: a doctor between patients says in fifteen seconds what
 * would take two minutes to type, and it belongs in the same list as everything
 * else written about that patient rather than in a folder of attachments. The
 * typed body stays available alongside it, so staff can add a line of context.
 *
 * The duration is taken from the browser, which is the only thing that knows it
 * without decoding the audio server-side. It is display metadata — a wrong value
 * mislabels a player and nothing more — so it is clamped rather than trusted.
 */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const g = await apiClinic(slug, "patients");
  if (!g.ok) return g.res;
  const access = g.access;

  const form = await req.formData();
  const file = form.get("audio");
  const patientId = String(form.get("patientId") ?? "");
  const categoryId = String(form.get("categoryId") ?? "") || null;
  const appointmentId = String(form.get("appointmentId") ?? "") || null;
  const body = String(form.get("body") ?? "").slice(0, 20000);
  const seconds = Math.max(0, Math.min(3600, Number(form.get("seconds")) || 0));

  if (!(file instanceof File)) return NextResponse.json({ error: "no_audio" }, { status: 400 });
  if (file.size > MAX_SIZE) return NextResponse.json({ error: "too_large" }, { status: 413 });
  if (!ALLOWED.test(file.type || "")) {
    return NextResponse.json({ error: "bad_type" }, { status: 415 });
  }
  if (!patientId) return NextResponse.json({ error: "missing" }, { status: 400 });

  const buf = Buffer.from(await file.arrayBuffer());

  const out = await inClinic(access, async (c) => {
    const p = await c.query(`select 1 from patients where id = $1 and clinic_id = $2`, [
      patientId,
      access.clinicId,
    ]);
    if (!p.rowCount) return null;

    // Category is verified against this clinic's own rows: it arrives from a
    // form, and a note filed under another clinic's category would be invisible
    // in every filter this one offers.
    let cat = categoryId;
    if (cat) {
      const ok = await c.query(
        `select 1 from note_categories where id = $1 and clinic_id = $2`,
        [cat, access.clinicId]
      );
      if (!ok.rowCount) cat = null;
    }
    if (!cat) cat = await defaultCategoryId(c, access.clinicId);

    // And the visit, if one was named, must be this patient's own.
    let visit = appointmentId;
    if (visit) {
      const ok = await c.query(
        `select 1 from appointments where id = $1 and clinic_id = $2 and patient_id = $3`,
        [visit, access.clinicId, patientId]
      );
      if (!ok.rowCount) visit = null;
    }

    const ext = (file.type.split("/")[1] ?? "webm").split(";")[0];
    const { storagePath } = await saveFile(
      access.clinicId,
      `patients/${patientId}/notes`,
      `voice-${Date.now()}.${ext}`,
      buf
    );
    const id = await createNote(c, access.clinicId, {
      patientId,
      authorId: access.session.user.id,
      body,
      categoryId: cat,
      appointmentId: visit,
      audio: { path: storagePath, mime: file.type, seconds: Math.round(seconds) },
    });
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "patient.note.voice",
      entity: "patient_note",
      entityId: id,
      detail: { patientId, seconds: Math.round(seconds), appointmentId: visit },
    });
    return { id };
  });

  if (!out) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true, ...out });
}
