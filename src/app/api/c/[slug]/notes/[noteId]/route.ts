import { NextResponse } from "next/server";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { saveNoteVersion } from "@/lib/notes";

/**
 * Autosave endpoint for a single patient note.
 *
 * Goes through `saveNoteVersion` rather than updating the row, so the text the
 * note held before this keystroke survives. That is the whole point of removing
 * the delete button: editing a note down to nothing would otherwise destroy
 * exactly as much as deleting it, and more quietly.
 *
 * `saveNoteVersion` also returns early when nothing changed, which is what stops
 * an autosave that fires on focus-and-blur from filing forty identical versions.
 */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string; noteId: string }> }) {
  const { slug, noteId } = await ctx.params;
  const g = await apiClinic(slug, "patients");
  if (!g.ok) return g.res;

  let body: { patch?: { body?: string; categoryId?: string | null } };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  const patch = body.patch ?? {};
  if (patch.body === undefined && patch.categoryId === undefined) {
    return NextResponse.json({ ok: true });
  }

  return inClinic(g.access, async (c) => {
    const ok = await saveNoteVersion(
      c,
      g.access.clinicId,
      noteId,
      {
        body: typeof patch.body === "string" ? patch.body.slice(0, 20000) : undefined,
        categoryId: patch.categoryId,
      },
      g.access.session.user.id
    );
    if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  });
}
