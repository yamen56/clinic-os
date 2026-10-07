import { NextResponse } from "next/server";
import { deviceAuth } from "@/lib/imaging/devices";

/*
  "Is my key right, and whose machine am I?" — the first call any bridge or
  relay makes, and the one Settings → Devices tells the clinic to try. Answers
  with the clinic and the device as the clinic named them, nothing more.
*/
export async function GET(req: Request) {
  const g = await deviceAuth(req);
  if (!g.ok) return g.res;
  const d = g.device;
  return NextResponse.json(
    {
      device: { id: d.id, name: d.name, kind: d.kind, matchBy: d.matchBy },
      clinic: { name: d.clinicName, timezone: d.timezone },
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
