import { NextResponse } from "next/server";
import { withSystem } from "@/lib/db";
import { loadPublicLink, clientIp } from "@/lib/booking-public";
import { rateLimitShared } from "@/lib/rate-limit-shared";
import { readJsonCapped } from "@/lib/public-guard";
import { normalizePhone } from "@/lib/phone";
import { findPatientByPhone } from "@/lib/patients";
import { sendVisitLink } from "@/lib/patient-visit";

/**
 * "Already booked? Change or cancel" on the booking page (0115).
 *
 * The patient types their number and their upcoming visits' links go to that
 * number's WhatsApp — never to the page. The phone is the identity check, as it
 * is for the code that books: whoever typed the number only learns anything if
 * they hold the phone. So the answer is the same whether the number has visits
 * here or not; which clinic somebody is booked at is itself health data.
 */
export async function POST(req: Request, ctx: { params: Promise<{ bslug: string }> }) {
  const { bslug } = await ctx.params;
  if (!(await rateLimitShared(`find:${bslug}:${clientIp(req)}`, 5, 10 * 60_000))) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  const data = await loadPublicLink(bslug);
  if (!data) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (data.clinic.patient_changes === "off") return NextResponse.json({ error: "off" }, { status: 403 });
  if (!data.clinic.wa_connected) return NextResponse.json({ error: "wa_offline" }, { status: 503 });

  const read = await readJsonCapped<{ phone?: string; locale?: string }>(req, 4 * 1024);
  if (!read.ok) return read.res;
  const phone = normalizePhone(String(read.body.phone ?? ""));
  if (!phone) return NextResponse.json({ error: "invalid_phone" }, { status: 422 });
  // Per number too: every call can put a message on somebody's phone.
  if (!(await rateLimitShared(`find-phone:${phone}`, 2, 10 * 60_000))) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  const lang = read.body.locale === "en" ? "en" : "ar";

  await withSystem(async (c) => {
    const patient = await findPatientByPhone(c, data.clinic.id, phone);
    if (!patient) return;
    const upcoming = (
      await c.query(
        `select id from appointments
          where clinic_id = $1 and patient_id = $2 and starts_at > now()
            and status in ('pending_approval', 'scheduled', 'confirmed')
          order by starts_at limit 3`,
        [data.clinic.id, patient.id]
      )
    ).rows as { id: string }[];
    for (const a of upcoming) await sendVisitLink(c, a.id, { lang });
  });
  return NextResponse.json({ ok: true });
}
