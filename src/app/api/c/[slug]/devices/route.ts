import { NextResponse } from "next/server";
import { z } from "zod";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { DEVICE_KINDS, DEVICE_RETURNING, MATCH_BY, PAIR_MINUTES, formatPairCode, newDeviceKey, newPairCode } from "@/lib/imaging/devices";

/*
  Register a machine.

  The usual way is `bridge`: the answer is a six-letter pairing code the
  doctor types into the Clinicti Bridge on the imaging computer, and the
  Bridge collects its own key — nobody sees or copies one. `api` is for other
  software (a PACS, a script): the key comes back here, once, and only its
  hash is kept.

  `settings.clinic`: a device can put an image into any patient's file and
  read the day's list, which is clinic configuration, not a desk task.
*/

const bodySchema = z.object({
  name: z.string().trim().min(1).max(60),
  kind: z.enum(DEVICE_KINDS),
  matchBy: z.enum(MATCH_BY).default("none"),
  method: z.enum(["bridge", "api"]).default("api"),
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
  // A bridge's first key is never shown; pairing replaces it with one only the Bridge holds.
  const { key, hash, hint } = newDeviceKey();
  const pair = d.method === "bridge" ? newPairCode() : null;

  const row = await inClinic(access, async (c) => {
    const n = await c.query(`select count(*)::int as n from clinic_devices where clinic_id = $1 and revoked_at is null`, [access.clinicId]);
    if (n.rows[0].n >= MAX_DEVICES) return null;
    const r = await c.query(
      `insert into clinic_devices (clinic_id, name, kind, match_by, method, key_hash, key_hint, created_by, pair_code_hash, pair_expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, case when $9::text is null then null else now() + make_interval(mins => $10) end)
       ${DEVICE_RETURNING}`,
      [access.clinicId, d.name, d.kind, d.matchBy, d.method, hash, hint, access.session.user.id, pair?.hash ?? null, PAIR_MINUTES]
    );
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "device.create",
      entity: "clinic_device",
      entityId: r.rows[0].id,
      detail: { name: d.name, kind: d.kind, matchBy: d.matchBy, method: d.method },
    });
    return r.rows[0];
  });
  if (!row) return NextResponse.json({ error: "too_many" }, { status: 409 });
  return NextResponse.json({
    ok: true,
    device: row,
    ...(pair ? { pairCode: formatPairCode(pair.code) } : { key }),
  });
}
