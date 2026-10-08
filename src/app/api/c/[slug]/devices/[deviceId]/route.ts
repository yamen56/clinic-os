import { NextResponse } from "next/server";
import { z } from "zod";
import { isUuid } from "@/lib/uuid";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { DEVICE_RETURNING, MATCH_BY, PAIR_MINUTES, formatPairCode, newDeviceKey, newPairCode } from "@/lib/imaging/devices";

type Params = { params: Promise<{ slug: string; deviceId: string }> };

/*
  One device: how it is doing, for the setup screen that ticks each step as
  it starts working — paired, folder watched, machine answered, first image
  in — and where its last image went.
*/
export async function GET(_req: Request, ctx: Params) {
  const { slug, deviceId } = await ctx.params;
  if (!isUuid(deviceId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const g = await apiClinic(slug, "settings.clinic");
  if (!g.ok) return g.res;
  const out = await inClinic(g.access, async (c) => {
    const d = await c.query(
      `select id, name, kind, match_by, method, key_hint, created_at, last_seen_at, images_received, revoked_at, paired_at, pair_expires_at, bridge
         from clinic_devices where id = $1 and clinic_id = $2`,
      [deviceId, g.access.clinicId]
    );
    if (!d.rowCount) return null;
    // The newest thing it sent: into a patient's file, or waiting in the inbox.
    const last = await c.query(
      `(select f.created_at as at, f.file_name, p.full_name as patient, false as inbox
          from patient_files f join patients p on p.id = f.patient_id
         where f.clinic_id = $2 and f.device_id = $1 order by f.created_at desc limit 1)
       union all
       (select i.received_at, i.file_name, null, true from imaging_inbox i
         where i.clinic_id = $2 and i.device_id = $1 order by i.received_at desc limit 1)
       order by at desc limit 1`,
      [deviceId, g.access.clinicId]
    );
    return { device: d.rows[0], lastImage: last.rows[0] ?? null };
  });
  if (!out) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(out, { headers: { "Cache-Control": "no-store" } });
}

/*
  Rename a device, change what its Patient ID means, give it a new pairing
  code (the Bridge moved to another computer), a new key (other software), or
  revoke it for good. A revoked device stays listed — the files it sent still
  name it — but its key opens nothing.
*/
const bodySchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("update"), name: z.string().trim().min(1).max(60).optional(), matchBy: z.enum(MATCH_BY).optional() }),
  z.object({ op: z.literal("pair") }),
  z.object({ op: z.literal("rekey") }),
  z.object({ op: z.literal("revoke") }),
]);

export async function PATCH(req: Request, ctx: Params) {
  const { slug, deviceId } = await ctx.params;
  if (!isUuid(deviceId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const g = await apiClinic(slug, "settings.clinic");
  if (!g.ok) return g.res;
  const access = g.access;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const b = parsed.data;
  const fresh = b.op === "rekey" ? newDeviceKey() : null;
  const pair = b.op === "pair" ? newPairCode() : null;

  const row = await inClinic(access, async (c) => {
    let r;
    if (b.op === "update") {
      r = await c.query(
        `update clinic_devices set name = coalesce($3, name), match_by = coalesce($4, match_by)
          where id = $1 and clinic_id = $2 and revoked_at is null ${DEVICE_RETURNING}`,
        [deviceId, access.clinicId, b.name ?? null, b.matchBy ?? null]
      );
    } else if (b.op === "pair") {
      // The old Bridge keeps working until the new one pairs: pairing replaces the key.
      r = await c.query(
        `update clinic_devices set method = 'bridge', pair_code_hash = $3, pair_expires_at = now() + make_interval(mins => $4)
          where id = $1 and clinic_id = $2 and revoked_at is null ${DEVICE_RETURNING}`,
        [deviceId, access.clinicId, pair!.hash, PAIR_MINUTES]
      );
    } else if (b.op === "rekey") {
      r = await c.query(
        `update clinic_devices set key_hash = $3, key_hint = $4
          where id = $1 and clinic_id = $2 and revoked_at is null ${DEVICE_RETURNING}`,
        [deviceId, access.clinicId, fresh!.hash, fresh!.hint]
      );
    } else {
      r = await c.query(
        `update clinic_devices set revoked_at = now(), revoked_by = $3, pair_code_hash = null
          where id = $1 and clinic_id = $2 and revoked_at is null ${DEVICE_RETURNING}`,
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
  return NextResponse.json({
    ok: true,
    device: row,
    ...(fresh ? { key: fresh.key } : {}),
    ...(pair ? { pairCode: formatPairCode(pair.code) } : {}),
  });
}
