import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { withSystem } from "@/lib/db";
import { notifyUser } from "@/lib/notify";
import { NT, asLocale } from "@/lib/notification-text";

/**
 * Sends the signed-in person a notification, so they can see for themselves
 * that this device receives them.
 *
 * "Are notifications working on my phone?" had no answer short of waiting for
 * a real patient to book. This goes the whole way — a row in the app, the
 * realtime pop-up, and the worker's push to every device they registered — so
 * whatever does not arrive is the part that is broken.
 *
 * One every fifteen seconds at most, through the same at-most-once key every
 * other notification uses, so a finger resting on the button sends one.
 */
export async function POST(req: Request) {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const { slug } = (await req.json().catch(() => ({}))) as { slug?: string };

  await withSystem(async (c) => {
    const me = (await c.query(`select locale from users where id = $1`, [s.user.id])).rows[0];
    const clinic = slug
      ? (
          await c.query(
            `select cl.id, cl.slug from clinics cl
               join clinic_members cm on cm.clinic_id = cl.id and cm.user_id = $2 and cm.active
              where cl.slug = $1`,
            [slug, s.user.id]
          )
        ).rows[0]
      : null;
    const L = NT[asLocale(me?.locale)];
    await notifyUser(c, s.user.id, {
      clinicId: clinic?.id ?? null,
      kind: "test",
      title: L.testTitle,
      body: L.testBody,
      url: clinic ? `/c/${clinic.slug}/notifications` : undefined,
      dedupeKey: `test:${Math.floor(Date.now() / 15_000)}`,
    });
  });
  return NextResponse.json({ ok: true });
}
