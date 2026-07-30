import type { PoolClient } from "pg";
import { withSystem } from "./db";

export type PublicLink = {
  link: {
    id: string;
    slug: string;
    doctor_member_id: string | null;
    service_ids: string[];
    min_notice_min: number;
    max_days_ahead: number;
    slot_granularity_min: number;
    approval_mode: "instant" | "approval";
  };
  clinic: {
    id: string;
    name: string;
    name_ar: string | null;
    slug: string;
    logo_path: string | null;
    brand_color: string;
    address: string | null;
    address_ar: string | null;
    phone_e164: string | null;
    google_maps_url: string | null;
    timezone: string;
    default_locale: "ar" | "en";
    working_hours: Record<string, [string, string][]>;
    blocked_dates: string[];
    wa_connected: boolean;
  };
  services: {
    id: string;
    name: string;
    name_ar: string | null;
    duration_min: number;
    price: string;
    color: string;
  }[];
  doctors: { id: string; name: string; title: string | null; specialty: string | null }[];
};

/** Loads everything the public booking page needs, or null if inactive/unknown. */
export async function loadPublicLink(bslug: string): Promise<PublicLink | null> {
  return withSystem(async (c: PoolClient) => {
    const link = (
      await c.query(
        `select bl.*, cl.id as clinic_id from booking_links bl
         join clinics cl on cl.id = bl.clinic_id
         where bl.slug = $1 and bl.active and cl.subscription_status <> 'suspended'`,
        [bslug]
      )
    ).rows[0];
    if (!link) return null;

    const clinic = (
      await c.query(
        `select cl.id, cl.name, cl.name_ar, cl.slug, cl.logo_path, cl.brand_color, cl.address, cl.address_ar,
                cl.phone_e164, cl.google_maps_url, cl.timezone, cl.default_locale, cl.working_hours, cl.blocked_dates,
                coalesce(ws.status = 'connected', false) as wa_connected
         from clinics cl left join whatsapp_sessions ws on ws.clinic_id = cl.id
         where cl.id = $1`,
        [link.clinic_id]
      )
    ).rows[0];

    const serviceFilter = (link.service_ids ?? []).length
      ? `and s.id = any($2::uuid[])`
      : "";
    const params: unknown[] = [link.clinic_id];
    if (serviceFilter) params.push(link.service_ids);
    const services = (
      await c.query(
        `select s.id, s.name, s.name_ar, s.duration_min, s.price, s.color
         from services s where s.clinic_id = $1 and s.active and s.bookable_online ${serviceFilter}
         order by s.sort, s.name`,
        params
      )
    ).rows;

    const doctors = (
      await c.query(
        `select cm.id, u.full_name as name, cm.title, cm.specialty
         from clinic_members cm join users u on u.id = cm.user_id
         where cm.clinic_id = $1 and cm.role = 'doctor' and cm.active
           and ($2::uuid is null or cm.id = $2)
         order by u.full_name`,
        [link.clinic_id, link.doctor_member_id]
      )
    ).rows;

    return {
      link: {
        id: link.id,
        slug: link.slug,
        doctor_member_id: link.doctor_member_id,
        service_ids: link.service_ids ?? [],
        min_notice_min: link.min_notice_min,
        max_days_ahead: link.max_days_ahead,
        slot_granularity_min: link.slot_granularity_min,
        approval_mode: link.approval_mode,
      },
      clinic,
      services,
      doctors,
    } as PublicLink;
  });
}

/**
 * The caller's address, as observed by our own proxy.
 *
 * `X-Forwarded-For` is a chain, and only the entry the *closest* proxy appended
 * is trustworthy — everything to its left is whatever the client chose to send.
 * Reading the raw header made the rate-limit key attacker-controlled: sending a
 * different fake value each time produced a fresh bucket every request and the
 * limit never applied. Take the rightmost entry instead.
 */
export function clientIp(req: Request): string {
  const chain = req.headers.get("x-forwarded-for");
  if (!chain) return req.headers.get("x-real-ip")?.trim() || "local";
  const parts = chain.split(",").map((p) => p.trim()).filter(Boolean);
  return parts[parts.length - 1] || "local";
}

/** Naive fixed-window rate limiter for public endpoints. */
const buckets = new Map<string, { count: number; reset: number }>();
export function rateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  // Fixed windows accumulate one bucket per key forever; public endpoints are
  // keyed by caller, so sweep expired entries rather than grow without bound.
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) if (v.reset < now) buckets.delete(k);
  }
  const b = buckets.get(key);
  if (!b || b.reset < now) {
    buckets.set(key, { count: 1, reset: now + windowMs });
    return true;
  }
  b.count++;
  return b.count <= max;
}
