import { NextResponse } from "next/server";
import { withSystem } from "@/lib/db";
import { clientIp, rateLimit } from "@/lib/booking-public";
import { takePublicSlot, overloaded } from "@/lib/public-guard";
import { rightsOf, visitFromToken, visitSlots } from "@/lib/patient-visit";

/** The other times one day has for this visit: same services, same doctor. */
export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  if (!rateLimit(`visit-slots:${clientIp(req)}`, 120, 10 * 60_000)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  const date = new URL(req.url).searchParams.get("date") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ error: "missing" }, { status: 400 });
  const lease = takePublicSlot();
  if (!lease) return overloaded();
  try {
    const out = await withSystem(async (c) => {
      const v = await visitFromToken(c, token);
      if (!v) return { status: 404 as const, body: { error: "not_found" } };
      if (!rightsOf(v).move) return { status: 403 as const, body: { error: "not_allowed" } };
      return { status: 200 as const, body: { slots: await visitSlots(c, v, date) } };
    });
    return NextResponse.json(out.body, { status: out.status, headers: { "Cache-Control": "no-store" } });
  } finally {
    lease.release();
  }
}
