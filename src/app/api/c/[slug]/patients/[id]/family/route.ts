import { NextResponse } from "next/server";
import { isUuid } from "@/lib/uuid";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { loadFamily } from "@/lib/families";

/**
 * The other members of a patient's family (0127), for the booking panel's
 * "also book" and the inbox's patient panel. Names, roles and how each is
 * reached only — never what anybody owes.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const g = await apiClinic(slug, ["patients", "calendar", "conversations"]);
  if (!g.ok) return g.res;
  const family = await inClinic(g.access, (c) => loadFamily(c, g.access.clinicId, id, null));
  return NextResponse.json({
    members: (family?.members ?? [])
      .filter((m) => m.id !== id)
      .map((m) => ({ id: m.id, name: m.name, role: m.role, gender: m.gender, nextAt: m.nextAt, isContact: m.isContact })),
  });
}
