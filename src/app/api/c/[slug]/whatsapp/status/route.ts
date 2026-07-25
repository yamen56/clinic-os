import { NextResponse } from "next/server";
import { apiClinic, inClinic } from "@/lib/clinic-api";

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const g = await apiClinic(slug);
  if (!g.ok) return g.res;
  const data = await inClinic(g.access, async (c) => {
    const r = await c.query(
      `select ws.status, ws.qr, ws.phone_number, ws.display_name, ws.connected_at, ws.last_seen_at,
              ws.error, ws.outbound_today, ws.paused_until, cl.daily_outbound_cap
       from whatsapp_sessions ws join clinics cl on cl.id = ws.clinic_id
       where ws.clinic_id = $1`,
      [g.access.clinicId]
    );
    return r.rows[0] ?? { status: "disconnected" };
  });
  return NextResponse.json(data);
}
