import { NextResponse } from "next/server";
import { z } from "zod";
import { withSystem } from "@/lib/db";
import { audit } from "@/lib/audit";
import { rateLimitShared } from "@/lib/rate-limit-shared";
import { floodKey } from "@/lib/flood-gate";
import { hashPairCode, newDeviceKey, normalizePairCode } from "@/lib/imaging/devices";

/*
  The Clinicti Bridge, newly installed, trades the code the doctor typed for
  its key.

  No key yet, so no other proof: the code is the credential. It is six
  characters from 31, lives fifteen minutes, works once, and an address gets
  twenty tries a quarter-hour — so guessing one is not a strategy. On a match
  the device gets a brand-new key that only the Bridge ever holds; any key it
  had before (a previous computer) stops working at that moment.
*/

const bodySchema = z.object({
  code: z.string().min(4).max(20),
  host: z.string().max(100).default(""),
  version: z.string().max(40).default(""),
});

export async function POST(req: Request) {
  const ip = floodKey(req.headers.get("x-forwarded-for"), req.headers.get("x-real-ip")) ?? "unknown";
  if (!(await rateLimitShared(`device-pair:${ip}`, 20, 15 * 60_000))) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": "900" } });
  }
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const { code, host, version } = parsed.data;
  if (normalizePairCode(code).length !== 6) return NextResponse.json({ error: "code_invalid" }, { status: 404 });

  const { key, hash, hint } = newDeviceKey();
  const paired = await withSystem(async (c) => {
    const r = await c.query(
      `update clinic_devices d
          set key_hash = $2, key_hint = $3, paired_at = now(), last_seen_at = now(),
              pair_code_hash = null, pair_expires_at = null, method = 'bridge',
              bridge = jsonb_build_object('host', $4::text, 'version', $5::text)
         from clinics cl
        where d.pair_code_hash = $1 and d.pair_expires_at > now() and d.revoked_at is null
          and cl.id = d.clinic_id and cl.deleted_at is null
        returning d.id, d.clinic_id, d.name, d.kind, d.match_by, cl.name as clinic_name, cl.timezone`,
      [hashPairCode(code), hash, hint, host, version]
    );
    const d = r.rows[0];
    if (!d) return null;
    await audit(c, {
      clinicId: d.clinic_id,
      action: "device.paired",
      entity: "clinic_device",
      entityId: d.id,
      detail: { host, version, ip },
    });
    return d;
  });
  if (!paired) return NextResponse.json({ error: "code_invalid" }, { status: 404 });
  return NextResponse.json(
    {
      ok: true,
      key,
      device: { id: paired.id, name: paired.name, kind: paired.kind, matchBy: paired.match_by },
      clinic: { name: paired.clinic_name, timezone: paired.timezone },
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
