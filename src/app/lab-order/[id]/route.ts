import { NextResponse } from "next/server";
import { isUuid } from "@/lib/uuid";
import { withSystem } from "@/lib/db";
import { verifyPrintKeyFor, printKeyFor } from "@/lib/print-token";
import { renderUrlToPdf } from "@/lib/pdf";
import { fileResponseHeaders } from "@/lib/download";
import { appUrl } from "@/lib/urls";
import { orderRef } from "@/lib/charts/dental/labs";
import { ORDER_KIND, PRINT_KIND } from "@/lib/charts/dental/lab-order";

export const dynamic = "force-dynamic";

/**
 * A lab order, as its lab opens it: the PDF, from the link in the clinic's
 * WhatsApp message (lab-order.ts). The same link is the clinic's Print.
 *
 * The link's key names one case and lasts sixty days. The case is read again on
 * every open, so the order is the one the lab is working to now — the trip it
 * is on, the date it is due — and one the clinic called off stops opening.
 * Drawn fresh each time by the worker's Chromium, from a page that only that
 * renderer can open.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const sp = new URL(req.url).searchParams;
  const refused = new NextResponse("This lab order link is not valid. Ask the clinic to send it again.", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
  });
  if (!isUuid(id) || !verifyPrintKeyFor(id, ORDER_KIND, sp.get("exp") ?? undefined, sp.get("sig") ?? undefined, [ORDER_KIND])) return refused;

  const row = await withSystem(async (c) => (await c.query(`select status from lab_cases where id = $1`, [id])).rows[0] as { status: string } | undefined);
  if (!row) return refused;
  if (row.status === "cancelled") {
    return new NextResponse("The clinic has cancelled this lab order.", {
      status: 410,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
    });
  }

  let pdf: Buffer;
  try {
    const { exp, sig } = printKeyFor(id, PRINT_KIND);
    pdf = await renderUrlToPdf(`${appUrl()}/lab-print/${id}?kind=${PRINT_KIND}&exp=${exp}&sig=${sig}`);
  } catch (e) {
    console.error("[lab order pdf]", (e as Error).message);
    return new NextResponse("The order could not be drawn just now. Please try again in a minute.", {
      status: 502,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      ...fileResponseHeaders({
        declaredType: "application/pdf",
        fileName: `Lab order ${orderRef(id)}.pdf`,
        size: pdf.length,
        wantsDownload: sp.has("download"),
        cacheControl: "private, no-store",
      }),
      "X-Robots-Tag": "noindex",
    },
  });
}
