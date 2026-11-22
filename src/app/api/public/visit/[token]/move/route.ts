import { NextResponse } from "next/server";
import { clientIp } from "@/lib/booking-public";
import { rateLimitShared } from "@/lib/rate-limit-shared";
import { readJsonCapped } from "@/lib/public-guard";
import { moveVisit } from "@/lib/patient-visit";

/**
 * The patient moves their own visit to another time. Every rule is checked
 * again here, under the schedule lock — see moveVisit.
 */
export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  // Fleet-wide: each success writes, messages the patient and tells the doctor.
  if (!(await rateLimitShared(`visit-move:${clientIp(req)}`, 10, 10 * 60_000))) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  if (!(await rateLimitShared(`visit-move-token:${token.slice(0, 22)}`, 6, 10 * 60_000))) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  const read = await readJsonCapped<{ startISO?: string; locale?: string }>(req, 4 * 1024);
  if (!read.ok) return read.res;
  if (typeof read.body.startISO !== "string") return NextResponse.json({ error: "missing" }, { status: 400 });
  const r = await moveVisit(token, read.body.startISO, read.body.locale === "en" ? "en" : "ar");
  if ("error" in r) {
    const status = r.error === "not_found" ? 404 : r.error === "not_allowed" ? 403 : 409;
    return NextResponse.json(r, { status });
  }
  return NextResponse.json(r);
}
