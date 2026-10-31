import { NextResponse } from "next/server";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { dueBackList } from "@/lib/due-back";

/** Due back, for the list above the waitlist — re-read when realtime says an appointment changed. */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const g = await apiClinic(slug, "calendar");
  if (!g.ok) return g.res;
  const due = await inClinic(g.access, (c) => dueBackList(c, g.access.clinicId));
  return NextResponse.json({ due });
}
