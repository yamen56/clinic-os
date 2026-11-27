import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { provisionClinic } from "./clinic-provision";
import { resolveFeatures } from "./features";
import { asPlan } from "./plans";
import { asSpecialty, isSpecialty } from "./specialties";
import { loadFlow, reissueIds, writeFlowGraph } from "./automation/store";
import { readFileBuffer, saveFile } from "./storage";

/**
 * A clinic's branches (2026-11-27, Yamen: "a clinic can have multiple
 * branches, and of course it's optional").
 *
 * A branch is a workspace of its own — its own patients, WhatsApp number,
 * staff and booking link — grouped with the main clinic under one owner
 * (`clinic_groups`, migration 0120). The owner and anyone who works at more
 * than one branch keep one login and move between them with the clinic
 * switcher; the owner sees the branches side by side in Finance → Analytics.
 *
 * Making one copies, from the main clinic, the parts the agency ticks: so a
 * new branch opens with the same services and prices, hours, forms and flows
 * instead of a blank workspace somebody has to rebuild by hand.
 */

import { BRANCH_PARTS, type BranchPart } from "./branches-parts";
export { BRANCH_PARTS, type BranchPart };

export type NewBranch = {
  mainClinicId: string;
  name: string;
  nameAr?: string | null;
  slug: string;
  phoneE164?: string | null;
  address?: string | null;
  addressAr?: string | null;
  planPrice?: number;
  copy: BranchPart[];
  /** Members of the main clinic to add here too, by user id. The owners always are. */
  staffUserIds: string[];
};

/** The group a clinic is in, made on first use from the clinic's own name. */
export async function ensureGroup(c: PoolClient, clinicId: string): Promise<string> {
  const cl = (await c.query(`select group_id, name, name_ar from clinics where id = $1 for update`, [clinicId])).rows[0];
  if (!cl) throw new Error("not_found");
  if (cl.group_id) return cl.group_id as string;
  const g = (await c.query(`insert into clinic_groups (name, name_ar) values ($1, $2) returning id`, [cl.name, cl.name_ar])).rows[0];
  await c.query(`update clinics set group_id = $2 where id = $1`, [clinicId, g.id]);
  return g.id as string;
}

/**
 * Creates a branch of `mainClinicId`, inside the caller's transaction.
 * Throws `slug_taken` like provisionClinic, so the caller rolls back.
 */
export async function createBranch(c: PoolClient, b: NewBranch): Promise<{ clinicId: string; slug: string }> {
  const main = (await c.query(`select * from clinics where id = $1 and deleted_at is null`, [b.mainClinicId])).rows[0];
  if (!main) throw new Error("not_found");
  const groupId = await ensureGroup(c, main.id);
  const owners = (
    await c.query(
      `select u.id, u.email, u.full_name, m.role from clinic_members m join users u on u.id = m.user_id
        where m.clinic_id = $1 and m.is_owner and m.active order by m.created_at`,
      [main.id]
    )
  ).rows;
  if (!owners.length) throw new Error("no_owner");
  const primary = owners[0];

  const p = await provisionClinic(c, {
    name: b.name,
    nameAr: b.nameAr ?? null,
    slug: b.slug,
    phoneE164: b.phoneE164 ?? null,
    // The same licence as the main clinic: a branch is the same customer.
    plan: asPlan(main.plan),
    planPrice: b.planPrice ?? 0,
    memberLimit: main.member_limit ?? null,
    features: resolveFeatures(main.features),
    specialty: asSpecialty(main.specialty),
    departments: ((main.specialties ?? []) as string[]).filter(isSpecialty).filter((s) => s !== main.specialty),
    ownerEmail: primary.email,
    ownerName: primary.full_name,
    ownerRole: primary.role,
    subscriptionStatus: main.subscription_status === "trial" ? "trial" : "active",
    trialEndsAt: main.trial_ends_at ?? null,
    paidUntil: main.paid_until ? String(main.paid_until instanceof Date ? main.paid_until.toISOString().slice(0, 10) : main.paid_until) : null,
    defaultLocale: main.default_locale,
    currency: main.currency,
    timezone: main.timezone,
    vocabulary: main.vocabulary,
  });
  const id = p.clinicId;
  await c.query(
    `update clinics set group_id = $2, address = $3, address_ar = $4, google_maps_url = null where id = $1`,
    [id, groupId, b.address ?? null, b.addressAr ?? null]
  );

  // The other owners own this branch too; the chosen staff join with the job and access they have at the main clinic.
  for (const o of owners.slice(1)) {
    await c.query(
      `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions) values ($1, $2, $3, true, '{"level":"full"}')
       on conflict (clinic_id, user_id) do nothing`,
      [id, o.id, o.role]
    );
  }
  if (b.staffUserIds.length) {
    await c.query(
      `insert into clinic_members (clinic_id, user_id, role, permissions, title, specialty, color, license_no, syndicate_no)
       select $1, m.user_id, m.role, m.permissions, m.title, m.specialty, m.color, m.license_no, m.syndicate_no
         from clinic_members m
        where m.clinic_id = $2 and m.active and not m.is_owner and m.user_id = any($3::uuid[])
       on conflict (clinic_id, user_id) do nothing`,
      [id, main.id, b.staffUserIds]
    );
  }

  const parts = new Set(b.copy);
  const serviceMap = parts.has("services") ? await copyServices(c, main.id, id) : new Map<string, string>();
  if (parts.has("hours")) {
    await c.query(
      `update clinics t set working_hours = s.working_hours, blocked_dates = s.blocked_dates from clinics s where t.id = $1 and s.id = $2`,
      [id, main.id]
    );
  }
  if (parts.has("invoicing")) {
    await c.query(
      `update clinics t set invoice_tax_rate = s.invoice_tax_rate, invoice_tax_label = s.invoice_tax_label,
              invoice_footer = s.invoice_footer, payment_instructions = s.payment_instructions
         from clinics s where t.id = $1 and s.id = $2`,
      [id, main.id]
    );
  }
  if (parts.has("branding")) await copyBranding(c, main, id);
  const templateMap = parts.has("documents") ? await copyDocuments(c, main.id, id) : new Map<string, string>();
  if (parts.has("automations")) await copyAutomations(c, main.id, id, { services: serviceMap, templates: templateMap });

  return { clinicId: id, slug: p.slug };
}

/** Sections, then services pointing at their new sections. Returns old → new service ids. */
async function copyServices(c: PoolClient, from: string, to: string): Promise<Map<string, string>> {
  const sections = new Map<string, string>();
  for (const s of (await c.query(`select * from service_sections where clinic_id = $1 order by sort`, [from])).rows) {
    const r = await c.query(
      `insert into service_sections (clinic_id, name, name_ar, color, active, sort) values ($1, $2, $3, $4, $5, $6) returning id`,
      [to, s.name, s.name_ar, s.color, s.active, s.sort]
    );
    sections.set(s.id, r.rows[0].id);
  }
  const services = new Map<string, string>();
  for (const s of (await c.query(`select * from services where clinic_id = $1 order by sort`, [from])).rows) {
    const r = await c.query(
      `insert into services (clinic_id, name, name_ar, description, duration_min, price, color, bookable_online, buffer_after_min,
                             active, sort, location_kind, section_id, fee_code, chart_key, chart_variant, price_unit, chart_owned,
                             course_sessions, course_interval_days)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20) returning id`,
      [
        to, s.name, s.name_ar, s.description, s.duration_min, s.price, s.color, s.bookable_online, s.buffer_after_min,
        s.active, s.sort, s.location_kind, s.section_id ? sections.get(s.section_id) ?? null : null, s.fee_code,
        s.chart_key, s.chart_variant, s.price_unit, s.chart_owned, s.course_sessions, s.course_interval_days,
      ]
    );
    services.set(s.id, r.rows[0].id);
  }
  return services;
}

/** The colour, and a copy of the logo file — the main clinic's folder may be purged one day. */
async function copyBranding(c: PoolClient, main: { brand_color: string; logo_path: string | null }, to: string) {
  let logo: string | null = null;
  if (main.logo_path) {
    const buf = await readFileBuffer(main.logo_path).catch(() => null);
    if (buf) logo = (await saveFile(to, "logo", main.logo_path.split("/").pop() ?? "logo.png", buf)).storagePath;
  }
  await c.query(`update clinics set brand_color = $2, logo_path = coalesce($3, logo_path) where id = $1`, [to, main.brand_color, logo]);
}

/**
 * The main clinic's forms in place of the library's fresh copies. Uploaded
 * PDFs keep pointing at the main clinic's file — read-only sources, and a
 * branch that edits one uploads its own.
 */
async function copyDocuments(c: PoolClient, from: string, to: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  await c.query(`delete from document_templates where clinic_id = $1`, [to]);
  for (const d of (await c.query(`select * from document_templates where clinic_id = $1 and is_active`, [from])).rows) {
    const r = await c.query(
      `insert into document_templates (clinic_id, name, name_ar, category, source, body, body_ar, language, source_pdf_path,
                                       signer_config, fields_schema, version, is_active, library_key, questions_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) returning id`,
      [
        to, d.name, d.name_ar, d.category, d.source, d.body, d.body_ar, d.language, d.source_pdf_path,
        JSON.stringify(d.signer_config ?? null), JSON.stringify(d.fields_schema ?? null), d.version, d.is_active, d.library_key, d.questions_at,
      ]
    );
    map.set(d.id, r.rows[0].id);
  }
  return map;
}

/** Ids a flow's settings may name, and what to do with them in a workspace where they do not exist. */
function remapConfig(cfg: Record<string, unknown>, maps: { services: Map<string, string>; templates: Map<string, string>; automations: Map<string, string> }) {
  const out: Record<string, unknown> = { ...cfg };
  const one = (m: Map<string, string>, v: unknown) => (typeof v === "string" && v ? m.get(v) ?? "" : v);
  const many = (m: Map<string, string>, v: unknown) => (Array.isArray(v) ? v.map((x) => m.get(String(x))).filter(Boolean) : v);
  if ("service_ids" in out) out.service_ids = many(maps.services, out.service_ids);
  if ("service_id" in out) out.service_id = one(maps.services, out.service_id);
  if ("template_id" in out) out.template_id = one(maps.templates, out.template_id);
  if ("automation_id" in out) out.automation_id = one(maps.automations, out.automation_id);
  // People are the branch's own: a flow that named somebody at the main clinic names nobody here.
  for (const k of ["member_ids", "doctor_member_ids"]) if (k in out) out[k] = [];
  for (const k of ["member_id", "doctor_member_id"]) if (k in out) out[k] = "";
  return out;
}

/**
 * The main clinic's flows, its system messages and its staff alerts, in place
 * of the defaults the branch was provisioned with. Each flow keeps whether it
 * was on, its template and its wording.
 */
async function copyAutomations(c: PoolClient, from: string, to: string, maps: { services: Map<string, string>; templates: Map<string, string> }) {
  await c.query(`delete from automations where clinic_id = $1`, [to]);
  const flows = (await c.query(`select id from automations where clinic_id = $1 order by created_at`, [from])).rows.map((r) => r.id as string);
  const automations = new Map<string, string>();
  for (const fid of flows) automations.set(fid, randomUUID());
  const all = { ...maps, automations };
  for (const fid of flows) {
    const f = await loadFlow(c, from, fid);
    if (!f) continue;
    const row = (await c.query(`select active, recipe_key, recipe_specialty, settings from automations where id = $1`, [fid])).rows[0];
    await c.query(
      `insert into automations (id, clinic_id, name, description, trigger_type, trigger_config, active, settings, canvas, recipe_key, recipe_specialty)
       values ($1, $2, $3, $4, $5, $6, $7, $8, '{"trigger": null}', $9, $10)`,
      [
        automations.get(fid), to, f.name, f.description, f.trigger, JSON.stringify(remapConfig(f.triggerConfig, all)),
        row.active, JSON.stringify(row.settings ?? {}), row.recipe_key, row.recipe_specialty,
      ]
    );
    const fresh = reissueIds(f.nodes.map((n) => ({ ...n, config: remapConfig(n.config, all) })), f.edges);
    await writeFlowGraph(c, to, automations.get(fid)!, fresh.nodes, fresh.edges);
  }
  await c.query(`delete from clinic_system_messages where clinic_id = $1`, [to]);
  await c.query(
    `insert into clinic_system_messages (clinic_id, key, enabled, body_ar, body_en)
     select $1, key, enabled, body_ar, body_en from clinic_system_messages where clinic_id = $2`,
    [to, from]
  );
  await c.query(`delete from clinic_staff_alerts where clinic_id = $1`, [to]);
  await c.query(
    `insert into clinic_staff_alerts (clinic_id, kind, roles, minutes_before, at_hour, threshold, enabled, sort, weekday)
     select $1, kind, roles, minutes_before, at_hour, threshold, enabled, sort, weekday from clinic_staff_alerts where clinic_id = $2`,
    [to, from]
  );
}
