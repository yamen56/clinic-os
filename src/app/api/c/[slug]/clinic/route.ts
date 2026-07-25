import { NextResponse } from "next/server";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { normalizePhone } from "@/lib/phone";

const TEXT_COLS: Record<string, number> = {
  name: 80,
  name_ar: 80,
  address: 300,
  address_ar: 300,
  google_maps_url: 500,
  invoice_prefix: 12,
  invoice_footer: 1000,
  payment_instructions: 1000,
  invoice_tax_label: 40,
};

/** Autosave endpoint for clinic settings (owner only). */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const g = await apiClinic(slug);
  if (!g.ok) return g.res;
  const access = g.access;
  if (access.role !== "owner") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  let body: { patch?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  const patch = body.patch ?? {};

  return inClinic(access, async (c) => {
    const sets: string[] = [];
    const vals: unknown[] = [access.clinicId];
    const push = (col: string, v: unknown) => {
      vals.push(v);
      sets.push(`${col} = $${vals.length}`);
    };

    for (const [k, raw] of Object.entries(patch)) {
      if (k in TEXT_COLS) {
        const v = String(raw ?? "").slice(0, TEXT_COLS[k]);
        if (k === "name" && !v.trim()) continue;
        push(k, v || null);
      } else if (k === "phone_e164") {
        const s = String(raw ?? "").trim();
        if (!s) {
          push(k, null);
          continue;
        }
        const e = normalizePhone(s);
        if (!e) return NextResponse.json({ error: "invalid_phone" }, { status: 422 });
        push(k, e);
      } else if (k === "brand_color") {
        const v = String(raw ?? "");
        if (/^#[0-9a-fA-F]{6}$/.test(v)) push(k, v);
      } else if (k === "default_locale") {
        if (raw === "ar" || raw === "en") push(k, raw);
      } else if (k === "timezone") {
        const v = String(raw ?? "");
        if (/^[A-Za-z_]+\/[A-Za-z_]+$/.test(v)) push(k, v);
      } else if (k === "invoice_tax_rate") {
        const n = Number(raw);
        if (Number.isFinite(n) && n >= 0 && n <= 100) push(k, n);
      } else if (k === "message_window_start" || k === "message_window_end") {
        const v = String(raw ?? "");
        if (/^\d{2}:\d{2}$/.test(v)) push(k, v);
      } else if (k === "daily_outbound_cap") {
        const n = Number(raw);
        if (Number.isInteger(n) && n >= 10 && n <= 5000) push(k, n);
      } else if (k === "working_hours" || k === "blocked_dates" || k === "settings") {
        if (raw && typeof raw === "object") push(k, JSON.stringify(raw));
      }
    }

    if (sets.length) {
      await c.query(`update clinics set ${sets.join(", ")} where id = $1`, vals);
      await audit(c, {
        clinicId: access.clinicId,
        userId: access.session.user.id,
        impersonatedBy: access.session.impersonatedBy,
        action: "clinic.settings.update",
        entity: "clinic",
        entityId: access.clinicId,
        detail: { fields: Object.keys(patch) },
      });
    }
    return NextResponse.json({ ok: true });
  });
}
