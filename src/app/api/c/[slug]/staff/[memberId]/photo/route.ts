import { NextResponse } from "next/server";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { can } from "@/lib/auth";
import { saveFile, openFile, deleteFile } from "@/lib/storage";
import { audit } from "@/lib/audit";

/**
 * A staff member's photo: upload, read, remove.
 *
 * Addressed by membership rather than by user id, which is what makes the
 * authorisation simple and tight. A membership only exists inside one clinic, so
 * resolving it under this clinic's RLS already answers "is this person a
 * colleague?" — there is no way to ask for the photo of somebody at another
 * clinic, and no user id to enumerate.
 *
 * The file itself lives on `users`, since a photo belongs to the person and not
 * to a job; someone working at two clinics uploads it once.
 */

const MAX_BYTES = 5 * 1024 * 1024;
const TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/** The membership's user, and whether the caller may change their photo. */
async function resolve(slug: string, memberId: string) {
  const auth = await apiClinic(slug);
  if (!auth.ok) return { error: auth.res } as const;
  const { access } = auth;

  const row = await inClinic(access, async (c) => {
    const r = await c.query(
      `select cm.id, cm.user_id, u.avatar_path, u.full_name
         from clinic_members cm join users u on u.id = cm.user_id
        where cm.id = $1 and cm.clinic_id = $2`,
      [memberId, access.clinicId]
    );
    return r.rows[0] as
      | { id: string; user_id: string; avatar_path: string | null; full_name: string }
      | undefined;
  });
  if (!row) {
    return { error: NextResponse.json({ error: "not_found" }, { status: 404 }) } as const;
  }

  // Your own face is yours to set. Anyone else's needs the staff capability.
  const isSelf = row.user_id === access.session.user.id;
  return { access, row, canEdit: isSelf || can(access, "settings.staff") } as const;
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ slug: string; memberId: string }> }
) {
  const { slug, memberId } = await ctx.params;
  const r = await resolve(slug, memberId);
  if ("error" in r) return r.error;
  if (!r.row.avatar_path) return NextResponse.json({ error: "no_photo" }, { status: 404 });

  const file = await openFile(r.row.avatar_path);
  if (!file) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const ext = r.row.avatar_path.split(".").pop() ?? "jpg";
  return new NextResponse(new Uint8Array(file.data), {
    headers: {
      "Content-Type": ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg",
      "Content-Length": String(file.size),
      /*
        Private, and revalidated. A colleague's photo is not public, and the
        path changes whenever a new one is uploaded — but the browser is asked
        to check rather than trust, so a replaced photo does not linger behind
        a cached copy for the rest of the session.
      */
      "Cache-Control": "private, max-age=0, must-revalidate",
      ETag: `"${r.row.avatar_path}"`,
    },
  });
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ slug: string; memberId: string }> }
) {
  const { slug, memberId } = await ctx.params;
  const r = await resolve(slug, memberId);
  if ("error" in r) return r.error;
  if (!r.canEdit) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "no_file" }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "too_large" }, { status: 413 });

  const data = Buffer.from(await file.arrayBuffer());
  /*
    Sniffed from the bytes rather than taken from the browser's Content-Type,
    which any client can claim. This is an image that gets served back to other
    people, so it has to actually be one.
  */
  const kind = sniff(data);
  if (!kind || !TYPES[kind]) return NextResponse.json({ error: "bad_type" }, { status: 415 });

  const { access, row } = r;
  await inClinic(access, async (c) => {
    const saved = await saveFile(
      access.clinicId,
      "avatars",
      // The user id keeps one person's photos together; the timestamp defeats
      // any cache still holding the previous one.
      `${row.user_id}-${Date.now()}.${TYPES[kind]}`,
      data
    );
    await c.query(`update users set avatar_path = $2 where id = $1`, [row.user_id, saved.storagePath]);
    if (row.avatar_path) await deleteFile(row.avatar_path).catch(() => {});
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "staff.photo.update",
      entity: "clinic_member",
      entityId: memberId,
    });
  });

  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ slug: string; memberId: string }> }
) {
  const { slug, memberId } = await ctx.params;
  const r = await resolve(slug, memberId);
  if ("error" in r) return r.error;
  if (!r.canEdit) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!r.row.avatar_path) return NextResponse.json({ ok: true });

  const { access, row } = r;
  await inClinic(access, async (c) => {
    await c.query(`update users set avatar_path = null where id = $1`, [row.user_id]);
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "staff.photo.remove",
      entity: "clinic_member",
      entityId: memberId,
    });
  });
  // Removed from storage only after the row no longer points at it, so a failure
  // here leaves an orphaned file rather than a broken image.
  if (row.avatar_path) await deleteFile(row.avatar_path).catch(() => {});
  return NextResponse.json({ ok: true });
}

/** Magic numbers for the three formats accepted. */
function sniff(b: Buffer): string | null {
  if (b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") {
    return "image/webp";
  }
  return null;
}
