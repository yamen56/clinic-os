import { NextResponse } from "next/server";
import { z } from "zod";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { DEVICE_KINDS, MATCH_BY, newDeviceKey } from "@/lib/imaging/devices";

/*
  Register a machine. The key comes back in this response and never again —
  only its hash is kept — so the page shows it once, with the setup that
  uses it, and a lost key is replaced rather than recovered.

  `settings.clinic`: a device key can put images into any patient's file and
  read the day's list, which is clinic configuration, not a desk task.
*/

const bodySchema = z.object({
  name: z.string().trim().min(1).max(60),
  kind: z.enum(DEVICE_KINDS),
  matchBy: z.enum(MATCH_BY).default("none"),
});

/** Nobody needs more; a leaked key spread over fifty devices is harder to find. */
const MAX_DEVICES = 30;

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const g = await apiClinic(slug, "settings.clinic");
  if (!g.ok) return g.res;
  const access = g.access;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const d = parsed.data;
  const { key, hash, hint } = newDeviceKey();

  const row = await inClinic(access, async (c) => {
    const n = await c.query(`select count(*)::int as n from clinic_devices where clinic_id = $1 and revoked_at is null`, [access.clinicId]);
    if (n.rows[0].n >= MAX_DEVICES) return null;
    const r = await c.query(
      `insert into clinic_devices (clinic_id, name, kind, match_by, key_hash, key_hint, created_by)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning id, name, kind, match_by, key_hint, created_at, last_seen_at, images_received, revoked_at`,
      [access.clinicId, d.name, d.kind, d.matchBy, hash, hint, access.session.user.id]
    );
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "device.create",
      entity: "clinic_device",
      entityId: r.rows[0].id,
      detail: { name: d.name, kind: d.kind, matchBy: d.matchBy },
    });
    return r.rows[0];
  });
  if (!row) return NextResponse.json({ error: "too_many" }, { status: 409 });
  return NextResponse.json({ ok: true, device: row, key });
}
