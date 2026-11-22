import { NextResponse } from "next/server";
import { withSystem } from "@/lib/db";
import { clientIp, rateLimit } from "@/lib/booking-public";
import { takePublicSlot, overloaded } from "@/lib/public-guard";
import { rightsOf, visitDayCounts, visitFromToken } from "@/lib/patient-visit";

/** How many other times each day has for this visit — the date strip on "Change the time". */
export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  if (!rateLimit(`visit-days:${clientIp(req)}`, 60, 10 * 60_000)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  const lease = takePublicSlot();
  if (!lease) return overloaded();
  try {
    const out = await withSystem(async (c) => {
      const v = await visitFromToken(c, token);
      if (!v) return { status: 404 as const, body: { error: "not_found" } };
      if (!rightsOf(v).move) return { status: 403 as const, body: { error: "not_allowed" } };
      return { status: 200 as const, body: { counts: await visitDayCounts(c, v) } };
    });
    return NextResponse.json(out.body, { status: out.status, headers: { "Cache-Control": "no-store" } });
  } finally {
    lease.release();
  }
}
