import { NextResponse } from "next/server";
import { withSystem } from "@/lib/db";
import { openFile } from "@/lib/storage";
import { rateLimit, clientIp } from "@/lib/booking-public";
import { rateLimited } from "@/lib/public-guard";

/**
 * A doctor's photo, on the booking page that has no session.
 *
 * The workspace already serves these at /api/c/[slug]/staff/[memberId]/photo,
 * but that route proves the caller is a colleague — which a patient choosing
 * between two doctors is not. So this is a second door, and it is deliberately
 * narrower than the first: it answers only for a doctor that *this* booking
 * link actually offers.
 *
 * That is what keeps it from becoming a way to walk a clinic's staff. The link
 * must be active, its clinic unsuspended, the member an active doctor of that
 * clinic, and — when the link names doctors — one of the named ones. Anything
 * else is a flat 404, with no distinction between "no such member", "not a
 * doctor" and "not on this link": each of those would otherwise confirm
 * something about somebody who never agreed to be listed here.
 *
 * Cached in memory the way the clinic logo is, and for the same reason: an
 * unauthenticated image is the cheapest amplification there is, because the
 * attacker sends a hundred bytes and we answer with a database round trip and
 * a fetch out of object storage we are billed for.
 */
const TTL_MS = 300_000;
const MAX_CACHED_BYTES = 512 * 1024;
const MAX_ENTRIES = 64;

type Entry = { bytes: Uint8Array<ArrayBuffer>; type: string; expires: number };
const cache = new Map<string, Entry>();

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

export async function GET(
  req: Request,
  ctx: { params: Promise<{ bslug: string; memberId: string }> }
) {
  const { bslug, memberId } = await ctx.params;
  if (!rateLimit(`docphoto:${clientIp(req)}`, 240, 10 * 60_000)) return rateLimited(600);

  const version = new URL(req.url).searchParams.get("v") ?? "";
  const key = `${bslug}/${memberId}?${version}`;
  const now = Date.now();

  const hit = cache.get(key);
  if (hit && hit.expires > now) {
    return new NextResponse(hit.bytes, {
      headers: {
        "Content-Type": hit.type,
        "Content-Length": String(hit.bytes.byteLength),
        "Cache-Control": "public, max-age=300",
      },
    });
  }

  const row = await withSystem(async (c) => {
    /*
      One query, so there is no window where the link is checked and the
      membership is read against a different state. `cardinality = 0` is the
      link's "every doctor", matching loadPublicLink.
    */
    const r = await c.query(
      `select u.avatar_path
         from booking_links bl
         join clinics cl on cl.id = bl.clinic_id
         join clinic_members cm on cm.clinic_id = bl.clinic_id
         join users u on u.id = cm.user_id
        where bl.slug = $1 and bl.active and cl.subscription_status <> 'suspended'
          and cm.id = $2 and cm.role = 'doctor' and cm.active
          and (cardinality(bl.doctor_member_ids) = 0 or cm.id = any(bl.doctor_member_ids))`,
      [bslug, memberId]
    );
    return r.rows[0] as { avatar_path: string | null } | undefined;
  });

  if (!row?.avatar_path) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const f = await openFile(row.avatar_path);
  if (!f) return NextResponse.json({ error: "gone" }, { status: 410 });

  const ext = row.avatar_path.split(".").pop()?.toLowerCase() ?? "jpg";
  const type = MIME[ext] ?? "image/jpeg";
  const bytes = new Uint8Array(f.data) as Uint8Array<ArrayBuffer>;
  if (bytes.byteLength <= MAX_CACHED_BYTES) {
    if (cache.size >= MAX_ENTRIES) {
      for (const [k, v] of cache) if (v.expires <= now) cache.delete(k);
      if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!);
    }
    cache.set(key, { bytes, type, expires: now + TTL_MS });
  }

  return new NextResponse(bytes, {
    headers: {
      "Content-Type": type,
      "Content-Length": String(f.size),
      "Cache-Control": "public, max-age=300",
    },
  });
}
