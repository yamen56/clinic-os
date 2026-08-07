import { NextResponse } from "next/server";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { normalizePhone } from "@/lib/phone";

const TEXT_FIELDS = new Set(["full_name", "notes_summary", "whatsapp_name"]);

/** Autosave endpoint for a patient file. Accepts a partial patch; last write wins, all versions audited. */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await ctx.params;
  const g = await apiClinic(slug);
  if (!g.ok) return g.res;
  const access = g.access;

  let body: { patch?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  const patch = body.patch ?? {};

  return inClinic(access, async (c) => {
    const cur = await c.query(
      `select * from patients where id = $1 and clinic_id = $2 and merged_into is null for update`,
      [id, access.clinicId]
    );
    if (!cur.rowCount) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const before = cur.rows[0];

    const sets: string[] = [];
    const vals: unknown[] = [id, access.clinicId];
    const changed: Record<string, { from: unknown; to: unknown }> = {};
    const push = (col: string, val: unknown) => {
      vals.push(val);
      sets.push(`${col} = $${vals.length}`);
      changed[col] = { from: before[col], to: val };
    };

    for (const [key, raw] of Object.entries(patch)) {
      if (TEXT_FIELDS.has(key)) {
        const v = String(raw ?? "").slice(0, key === "notes_summary" ? 5000 : 200);
        if (key === "full_name" && !v.trim()) continue;
        push(key, v);
      } else if (key === "phone_e164" || key === "secondary_phone_e164") {
        const rawStr = String(raw ?? "").trim();
        if (!rawStr) {
          push(key, null);
          continue;
        }
        const e164 = normalizePhone(rawStr);
        if (!e164) return NextResponse.json({ error: "invalid_phone", field: key }, { status: 422 });
        if (key === "phone_e164") {
          const dup = await c.query(
            `select id, full_name from patients
             where clinic_id = $1 and phone_e164 = $2 and id <> $3 and merged_into is null`,
            [access.clinicId, e164, id]
          );
          if (dup.rowCount) {
            return NextResponse.json(
              { error: "phone_taken", other: dup.rows[0] },
              { status: 409 }
            );
          }
        }
        push(key, e164);
      } else if (key === "birth_date") {
        const v = String(raw ?? "");
        push(key, /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
      } else if (key === "gender") {
        push(key, raw === "male" || raw === "female" ? raw : null);
      } else if (key === "status") {
        if (raw === "lead" || raw === "active" || raw === "archived") push(key, raw);
      } else if (key === "insurer_id") {
        /*
          Verified against this clinic's own list rather than trusted. The value
          comes from a select the client rendered, but an id from another
          clinic's insurers would otherwise be accepted and would leak that
          company's name back onto this patient's file.
        */
        const v = String(raw ?? "").trim();
        if (!v) {
          push(key, null);
        } else {
          const ok = await c.query(`select 1 from insurers where id = $1 and clinic_id = $2`, [
            v,
            access.clinicId,
          ]);
          if (!ok.rowCount) return NextResponse.json({ error: "unknown_insurer" }, { status: 422 });
          push(key, v);
        }
      } else if (key === "insurance_no") {
        push(key, String(raw ?? "").slice(0, 60));
      } else if (key === "insurance_valid_until") {
        const v = String(raw ?? "");
        push(key, /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
      } else if (key === "custom_fields" && raw && typeof raw === "object") {
        const merged = { ...before.custom_fields, ...(raw as Record<string, unknown>) };
        push("custom_fields", JSON.stringify(merged));
      }
    }

    if (sets.length) {
      await c.query(`update patients set ${sets.join(", ")} where id = $1 and clinic_id = $2`, vals);
      // Both versions land in the audit log (concurrent-edit reconciliation trail)
      await audit(c, {
        clinicId: access.clinicId,
        userId: access.session.user.id,
        impersonatedBy: access.session.impersonatedBy,
        action: "patient.update",
        entity: "patient",
        entityId: id,
        detail: { changed },
      });
    }
    const after = await c.query(`select * from patients where id = $1`, [id]);
    return NextResponse.json({ ok: true, patient: after.rows[0] });
  });
}
