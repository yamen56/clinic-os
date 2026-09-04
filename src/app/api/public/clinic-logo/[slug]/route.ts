import { NextResponse } from "next/server";
import { withSystem } from "@/lib/db";
import { openFile } from "@/lib/storage";
import { rateLimit, clientIp } from "@/lib/booking-public";
import { rateLimited } from "@/lib/public-guard";

/**
 * A clinic's logo, on the pages that have no session — the booking link, the
 * invoice, the signing page.
 *
 * Unauthenticated and, before this, unmetered: every request cost a database
 * lookup and a fetch out of object storage. That is the cheapest kind of
 * amplification to run against someone, because the attacker sends a hundred
 * bytes and we answer with a round trip to two services and a bill for the
 * egress. `Cache-Control` asks a browser to stop; an attacker is not a browser.
 *
 * So the answer is held here for as long as we already ask browsers to hold it.
 * The first request pays, the rest are memory, and a flood becomes CPU we
 * already own rather than storage traffic we are billed for.
 */
const TTL_MS = 300_000;
/** Only small files are worth holding, and only a few of them — see below. */
const MAX_CACHED_BYTES = 512 * 1024;
const MAX_ENTRIES = 32;

type Entry = { bytes: Uint8Array<ArrayBuffer>; type: string; expires: number };
const cache = new Map<string, Entry>();

export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  /*
    Generous, because one public page can legitimately ask several times — the
    booking wizard, its metadata card and a print view all reference it — and
    because the cache below means a hit costs almost nothing. This is here to
    bound the *misses*, which are the expensive ones.
  */
  if (!rateLimit(`logo:${clientIp(req)}`, 240, 10 * 60_000)) return rateLimited(600);

  // `?v=` is the version some callers append so replacing a logo is visible
  // immediately; it has to be part of the key or this cache would defeat it.
  const version = new URL(req.url).searchParams.get("v") ?? "";
  const key = `${slug}?${version}`;
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

  const clinic = await withSystem(async (c) => {
    const r = await c.query(`select logo_path from clinics where slug = $1`, [slug]);
    return r.rows[0] ?? null;
  });
  if (!clinic?.logo_path) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const f = await openFile(clinic.logo_path);
  if (!f) return NextResponse.json({ error: "gone" }, { status: 410 });

  const type = clinic.logo_path.endsWith(".png") ? "image/png" : "image/jpeg";
  const bytes = new Uint8Array(f.data) as Uint8Array<ArrayBuffer>;
  if (bytes.byteLength <= MAX_CACHED_BYTES) {
    // Bounded, and swept by age first. Holding every clinic's logo forever would
    // turn a defence against one attack into a slow memory leak, which is the
    // same outage arriving later.
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
