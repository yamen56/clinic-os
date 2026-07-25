import { NextResponse } from "next/server";
import { apiClinic, inClinic } from "@/lib/clinic-api";

/** Autosave endpoint for a single patient note. */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string; noteId: string }> }) {
  const { slug, noteId } = await ctx.params;
  const g = await apiClinic(slug);
  if (!g.ok) return g.res;

  let body: { patch?: { body?: string; kind?: string } };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  const patch = body.patch ?? {};

  return inClinic(g.access, async (c) => {
    const sets: string[] = [];
    const vals: unknown[] = [noteId, g.access.clinicId];
    if (typeof patch.body === "string") {
      vals.push(patch.body.slice(0, 20000));
      sets.push(`body = $${vals.length}`);
    }
    if (patch.kind === "clinical" || patch.kind === "admin") {
      vals.push(patch.kind);
      sets.push(`kind = $${vals.length}`);
    }
    if (!sets.length) return NextResponse.json({ ok: true });
    const r = await c.query(
      `update patient_notes set ${sets.join(", ")} where id = $1 and clinic_id = $2`,
      vals
    );
    if (!r.rowCount) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  });
}
