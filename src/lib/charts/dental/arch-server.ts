/**
 * A full arch changed after it was recorded: its implants moved, tilted,
 * added or taken off, the bridge on them made longer or shorter, split, or
 * made of something else.
 *
 * The surgery is rarely exactly the plan, so this is not a correction of a
 * mistake — it is the arch as it was placed. Every change keeps its line in
 * the history; an implant taken off is voided, never deleted; and the numbers
 * are clamped here with the same limits the screen drags within, because the
 * request is only a request.
 */

import type { PoolClient } from "pg";
import { BUILT_IN_BY_KEY } from "./catalog";
import { archTeeth } from "./full-arch";
import { clampPlace, inOrder, placeDetail, placeOf, sitesFor, whereText, type Place } from "./implant-place";
import { applyToMembers } from "./server";
import { setDetail, type DetailRow } from "./billing-server";
import type { Arch } from "./teeth";

export type ArchChange = {
  implants: { id: string; eventId: string; pos: number; tilt: number; depth: number; len: number; dia: number }[];
  teeth: string[];
  kind: "fixed" | "removable";
  material: string | null;
  cuts: string;
};

type GroupRow = {
  id: string;
  site: string;
  look: string;
  role: string | null;
  status: string;
  detail: Record<string, string> | null;
  voided_at: unknown;
  done_at: Date | null;
  appointment_id: string | null;
};

/** What a full arch's own entry may say about itself: known words only, the rest dropped. */
export function cleanArchDetail(detail: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  if (/^\d{1,2}$/.test(detail.implants ?? "")) out.implants = detail.implants;
  if (detail.kind === "fixed" || detail.kind === "removable") out.kind = detail.kind;
  const options = BUILT_IN_BY_KEY.get("implant_denture")?.details?.find((d) => d.key === "material")?.options ?? [];
  if (options.some((o) => o.key === detail.material)) out.material = detail.material;
  if (/^[0-9a-f]{1,4}$/.test(detail.cuts ?? "")) out.cuts = detail.cuts;
  return out;
}

export async function saveArch(
  c: PoolClient,
  ctx: { clinicId: string; patientId: string; userId: string; eventId: string },
  cur: DetailRow & { site: string; group_id: string | null; performed_by: string | null; done_at: Date | null; appointment_id: string | null },
  d: ArchChange
): Promise<{ error: "not_an_arch" | "invalid" } | { changed: string[] }> {
  if (cur.treatment_key !== "implant_denture" || (cur.site !== "upper" && cur.site !== "lower") || !cur.group_id) return { error: "not_an_arch" };
  const arch = cur.site as Arch;
  const row = archTeeth(arch);
  if (d.teeth.some((f) => !row.includes(f)) || new Set(d.teeth).size !== d.teeth.length) return { error: "invalid" };
  if (new Set(d.implants.map((i) => i.id)).size !== d.implants.length) return { error: "invalid" };

  const group = (
    await c.query(`select id, site, look, role, status, detail, voided_at, done_at, appointment_id from chart_marks where group_id = $1 and clinic_id = $2 for update`, [
      cur.group_id,
      ctx.clinicId,
    ])
  ).rows as GroupRow[];
  const live = group.filter((g) => !g.voided_at && g.id !== cur.id);
  const oldImplants = live.filter((g) => g.look === "implant");
  const oldTeeth = live.filter((g) => g.role === "pontic");

  // A new implant's id must be new: never another entry's, here or anywhere.
  const fresh = d.implants.filter((i) => !oldImplants.some((g) => g.id === i.id));
  if (fresh.length) {
    const taken = await c.query(`select 1 from chart_marks where id = any($1::uuid[])`, [fresh.map((i) => i.id)]);
    if (taken.rowCount) return { error: "invalid" };
  }

  const changed: string[] = [];
  const line = async (markId: string, action: "created" | "placed", id: string | null, reason: string | null) =>
    c.query(
      `insert into chart_mark_events (id, clinic_id, mark_id, action, by_user, reason) values (coalesce($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6)`,
      [id, ctx.clinicId, markId, action, ctx.userId, reason]
    );
  /*
    A part added to an arch stands as the rest of its kind does: placed already,
    planned, or there before — and placed on their day, at their visit. Dated
    today, it would read as treatment finished today: aftercare sent for it, and
    a visit credited with surgery that was not done at it.
  */
  type Standing = { status: string; done_at: Date | null; appointment_id: string | null };
  const like = (rows: GroupRow[]): Standing => (rows.length && rows.every((r) => r.status === rows[0].status) ? rows[0] : cur);
  const add = async (id: string | null, site: string, key: string, role: string, detail: Record<string, string>, as: Standing): Promise<string> => {
    const tr = BUILT_IN_BY_KEY.get(key)!;
    const r = await c.query(
      `insert into chart_marks (id, clinic_id, patient_id, site, surfaces, treatment_key, label, label_ar, abbr, look, kind, detail, status, group_id, role,
                                performed_by, recorded_by, done_at, appointment_id)
       values (coalesce($1::uuid, gen_random_uuid()), $2, $3, $4, '{}', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
       returning id`,
      [
        id,
        ctx.clinicId,
        ctx.patientId,
        site,
        tr.key,
        tr.en,
        tr.ar,
        tr.abbr ?? null,
        tr.look,
        tr.kind,
        JSON.stringify(detail),
        as.status,
        cur.group_id,
        role,
        cur.performed_by,
        ctx.userId,
        as.status === "done" ? (as.done_at ?? new Date()) : null,
        as.status === "done" ? as.appointment_id : null,
      ]
    );
    return r.rows[0].id as string;
  };

  /* ── The implants ──────────────────────────────────────────────────────── */
  const ordered = inOrder(d.implants.map((i) => ({ ...i, ...clampPlace(i) })));
  const places: Place[] = ordered.map((i) => ({ pos: i.pos, tilt: i.tilt, depth: i.depth, len: i.len, dia: i.dia }));
  const sites = sitesFor(arch, places);
  const placedAs = like(oldImplants);
  let moved = false;
  for (const [n, i] of ordered.entries()) {
    const detail = placeDetail(places[n]);
    const old = oldImplants.find((g) => g.id === i.id);
    if (!old) {
      await add(i.id, sites[n], "implant", "abutment", detail, placedAs);
      await line(i.id, "created", i.eventId, null);
      changed.push(i.id);
      moved = true;
      continue;
    }
    const was = placeDetail(placeOf({ site: old.site, detail: old.detail ?? {} }));
    const same = old.site === sites[n] && (Object.keys(detail) as (keyof typeof detail)[]).every((k) => was[k] === detail[k]);
    if (same) continue;
    await c.query(`update chart_marks set site = $2, detail = detail || $3::jsonb where id = $1`, [old.id, sites[n], JSON.stringify(detail)]);
    await line(old.id, "placed", i.eventId, `${whereText(arch, Number(was.pos))} → ${whereText(arch, places[n].pos)}`);
    changed.push(old.id);
    moved = true;
  }
  const off = oldImplants.filter((g) => !d.implants.some((i) => i.id === g.id)).map((g) => g.id);
  if (off.length) {
    changed.push(...(await applyToMembers(c, ctx.clinicId, off, "void", ctx.userId, null)));
    moved = true;
  }

  /* ── The bridge's teeth ────────────────────────────────────────────────── */
  const toothAs = like(oldTeeth);
  let reshaped = false;
  for (const f of d.teeth) {
    if (oldTeeth.some((g) => g.site === f)) continue;
    const id = await add(null, f, "implant_denture", "pontic", {}, toothAs);
    await line(id, "created", null, null);
    changed.push(id);
    reshaped = true;
  }
  const gone = oldTeeth.filter((g) => !d.teeth.includes(g.site)).map((g) => g.id);
  if (gone.length) {
    changed.push(...(await applyToMembers(c, ctx.clinicId, gone, "void", ctx.userId, null)));
    reshaped = true;
  }

  /* ── The arch itself ───────────────────────────────────────────────────── */
  const before = cur.detail ?? {};
  const count = String(ordered.length);
  // How many implants carry it is what it is priced by.
  if (before.implants !== count) await setDetail(c, ctx.clinicId, cur, "implants", count);
  const own = cleanArchDetail({ kind: d.kind, cuts: d.cuts, ...(d.material ? { material: d.material } : {}) });
  const redone = (Object.keys(own) as string[]).some((k) => (before[k] ?? "") !== own[k]);
  if (redone) await c.query(`update chart_marks set detail = detail || $2::jsonb where id = $1`, [cur.id, JSON.stringify(own)]);
  if (moved || reshaped || redone) {
    const at = places.map((p) => whereText(arch, p.pos)).join(" · ");
    await line(cur.id, "placed", ctx.eventId, `${ordered.length} at ${at}`.slice(0, 300));
    changed.push(cur.id);
  }
  return { changed: [...new Set(changed)] };
}
