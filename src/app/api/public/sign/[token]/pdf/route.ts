import { NextResponse } from "next/server";
import { withSystem } from "@/lib/db";
import { rateLimit, clientIp } from "@/lib/booking-public";
import { resolveIn } from "@/lib/esign/public";
import { readFileBuffer } from "@/lib/storage";

/**
 * The source PDF of an uploaded document, for the signer to read.
 *
 * The token authorises exactly this one file. No storage path ever reaches the
 * browser, and a token that has expired or been used stops serving it.
 */
export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  if (!rateLimit(`sign-pdf:${clientIp(req)}`, 60, 10 * 60_000)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const path = await withSystem(async (c) => {
    const view = await resolveIn(c, token, { countAttempt: false });
    if (view.state !== "ready" && view.state !== "needs_code") return null;
    if (!view.document) return null;
    const r = await c.query(`select source_pdf_path from documents where id = $1`, [
      view.document.id,
    ]);
    return (r.rows[0]?.source_pdf_path as string | null) ?? null;
  });
  if (!path) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const data = await readFileBuffer(path);
  if (!data) return NextResponse.json({ error: "not_found" }, { status: 404 });

  return new NextResponse(new Uint8Array(data), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(data.length),
      "Content-Disposition": "inline",
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}
