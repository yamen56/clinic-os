import { NextResponse } from "next/server";
import { clientIp } from "@/lib/booking-public";
import { rateLimitShared } from "@/lib/rate-limit-shared";
import { readJsonCapped } from "@/lib/public-guard";
import { cancelVisit } from "@/lib/patient-visit";

/** The patient cancels their own visit — the desk's own path, with the patient as the one who did it. */
export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  if (!(await rateLimitShared(`visit-cancel:${clientIp(req)}`, 10, 10 * 60_000))) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  const read = await readJsonCapped<{ reason?: string | null; locale?: string }>(req, 4 * 1024);
  if (!read.ok) return read.res;
  const reason = typeof read.body.reason === "string" ? read.body.reason : null;
  const r = await cancelVisit(token, reason, read.body.locale === "en" ? "en" : "ar");
  if ("error" in r) return NextResponse.json(r, { status: r.error === "not_found" ? 404 : 403 });
  return NextResponse.json(r);
}
