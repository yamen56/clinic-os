import { NextResponse } from "next/server";
import { deviceAuth, inDeviceClinic } from "@/lib/imaging/devices";

/*
  The Bridge's heartbeat: what it is doing, every half minute. Settings →
  Devices reads it back to tick the setup steps and to say plainly what is
  wrong — "the folder is gone", "nothing has arrived from the machine yet",
  "12 images waiting for the internet" — without anybody walking to the
  imaging computer to look.

  Kept as the Bridge sent it, trimmed: it is a status report, not a record.
*/

const MAX_BYTES = 8 * 1024;

export async function POST(req: Request) {
  const g = await deviceAuth(req);
  if (!g.ok) return g.res;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "invalid" }, { status: 400 });
  let json = JSON.stringify({ ...body, at: new Date().toISOString() });
  if (json.length > MAX_BYTES) json = JSON.stringify({ error: "status_too_large", at: new Date().toISOString() });

  await inDeviceClinic(g.device, (c) => c.query(`update clinic_devices set bridge = $2::jsonb where id = $1`, [g.device.id, json]));
  return NextResponse.json(
    { ok: true, device: { name: g.device.name, kind: g.device.kind, matchBy: g.device.matchBy }, clinic: { name: g.device.clinicName } },
    { headers: { "Cache-Control": "no-store" } }
  );
}
