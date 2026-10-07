import { NextResponse } from "next/server";
import { z } from "zod";
import { isUuid } from "@/lib/uuid";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { MATCH_BY, newDeviceKey } from "@/lib/imaging/devices";

/*
  Rename a device, change what its Patient ID means, give it a new key (the
  old one stops at once), or revoke it for good. A revoked device stays listed
  — the files it sent still name it — but its key opens nothing.
*/

const bodySchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("update"), name: z.string().trim().min(1).max(60).optional(), matchBy: z.enum(MATCH_BY).optional() }),
  z.object({ op: z.literal("rekey") }),
  z.object({ op: z.literal("revoke") }),
]);

const RETURNING = `returning id, name, kind, match_by, key_hint, created_at, last_seen_at, images_received, revoked_at`;

export async function PATCH(req: Request, ctx: { params: Promise<{ slug: string; deviceId: string }> }) {
  const { slug, deviceId } = await ctx.params;
  if (!isUuid(deviceId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const g = await apiClinic(slug, "settings.clinic");
  if (!g.ok) return g.res;
  const access = g.access;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const b = parsed.data;
  const fresh = b.op === "rekey" ? newDeviceKey() : null;

  const row = await inClinic(access, async (c) => {
    let r;
    if (b.op === "update") {
      r = await c.query(
        `update clinic_devices set name = coalesce($3, name), match_by = coalesce($4, match_by)
          where id = $1 and clinic_id = $2 and revoked_at is null ${RETURNING}`,
        [deviceId, access.clinicId, b.name ?? null, b.matchBy ?? null]
      );
    } else if (b.op === "rekey") {
      r = await c.query(
        `update clinic_devices set key_hash = $3, key_hint = $4
          where id = $1 and clinic_id = $2 and revoked_at is null ${RETURNING}`,
        [deviceId, access.clinicId, fresh!.hash, fresh!.hint]
      );
    } else {
      r = await c.query(
        `update clinic_devices set revoked_at = now(), revoked_by = $3
          where id = $1 and clinic_id = $2 and revoked_at is null ${RETURNING}`,
        [deviceId, access.clinicId, access.session.user.id]
      );
    }
    if (!r.rowCount) return null;
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: `device.${b.op}`,
      entity: "clinic_device",
      entityId: deviceId,
      detail: b.op === "update" ? { name: b.name, matchBy: b.matchBy } : {},
    });
    return r.rows[0];
  });
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true, device: row, ...(fresh ? { key: fresh.key } : {}) });
}
