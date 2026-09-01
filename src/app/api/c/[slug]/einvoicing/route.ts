import { NextResponse } from "next/server";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { can } from "@/lib/auth";
import { TAXPAYER_TYPES } from "@/lib/einvoice/settings";

/**
 * Autosave endpoint for a clinic's JoFotara registration (owner only).
 *
 * Mirrors the clinic settings route: an allowlist of columns, a per-key
 * validation switch, unknown keys silently dropped, one update, one audit row.
 * Two things it does differently, both because of what is stored here:
 *
 *   - it never returns the secret key, or any indication of it beyond whether
 *     one exists — the settings screen is handed `hasSecret`, never the value;
 *   - an empty secret means "leave it alone", not "clear it". The field renders
 *     blank because we will not send the key to a browser, so saving the form
 *     after editing something else must not wipe the credential.
 */

const TEXT_COLS: Record<string, number> = {
  registered_name: 200,
  tax_number: 40,
  income_source_sequence: 40,
  client_id: 200,
  secret_key: 400,
};

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const g = await apiClinic(slug, "invoices");
  if (!g.ok) return g.res;
  const access = g.access;
  if (!can(access, "settings.clinic")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  // The module has no capability of its own, so this is the gate.
  if (!access.clinic.features.einvoicing) {
    return NextResponse.json({ error: "not_licensed" }, { status: 403 });
  }

  let body: { patch?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  const patch = body.patch ?? {};

  return inClinic(access, async (c) => {
    // The row is created on first save rather than at clinic creation: a clinic
    // that never files should not carry an empty registration around.
    await c.query(
      `insert into clinic_einvoice_settings (clinic_id) values ($1) on conflict do nothing`,
      [access.clinicId]
    );

    const sets: string[] = [];
    const vals: unknown[] = [access.clinicId];
    const push = (col: string, v: unknown) => {
      vals.push(v);
      sets.push(`${col} = $${vals.length}`);
    };

    for (const [k, raw] of Object.entries(patch)) {
      if (k in TEXT_COLS) {
        const v = String(raw ?? "").trim().slice(0, TEXT_COLS[k]);
        // See the note above: blank is "unchanged", not "delete the key".
        if (k === "secret_key" && !v) continue;
        push(k, v);
      } else if (k === "enabled") {
        push("enabled", raw === true);
      } else if (k === "file_by_default") {
        push("file_by_default", raw === true);
      } else if (k === "taxpayer_type") {
        if (!(TAXPAYER_TYPES as readonly string[]).includes(String(raw))) continue;
        push("taxpayer_type", String(raw));
      } else if (k === "environment") {
        if (!["production", "sandbox"].includes(String(raw))) continue;
        push("environment", String(raw));
      }
    }
    if (!sets.length) return NextResponse.json({ ok: true });

    await c.query(
      `update clinic_einvoice_settings set ${sets.join(", ")} where clinic_id = $1`,
      vals
    );
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "einvoicing.settings.update",
      entity: "clinic",
      entityId: access.clinicId,
      // Field names only. The values are a tax registration and a secret, and an
      // audit log is not the place to copy either of them to.
      detail: { fields: Object.keys(patch) },
    });
    return NextResponse.json({ ok: true });
  });
}
