import { NextResponse } from "next/server";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { loadWaitlist } from "@/lib/waitlist";

/** The live waitlist, for the tab inside Appointments — re-read when realtime says it changed. */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const g = await apiClinic(slug, "calendar");
  if (!g.ok) return g.res;
  const data = await inClinic(g.access, (c) => loadWaitlist(c, g.access.clinicId));
  return NextResponse.json(data);
}
