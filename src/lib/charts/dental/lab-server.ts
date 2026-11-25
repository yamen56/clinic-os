/**
 * What a lab is told to make, read from the chart.
 *
 * A lab works from an order: which teeth, which of them carry the bridge and
 * which it replaces, on teeth or on implants and which implants, what it is
 * made of. The chart has all of it, so nobody types it — and the order keeps
 * it as it was when it was sent, so a change of plan later does not rewrite
 * what the lab was asked for.
 */

import type { PoolClient } from "pg";
import { EVERY_TOOTH } from "./full-arch";
import type { LabSpec } from "./labs";
import type { ImplantRow } from "./protocols";

type MarkRow = { id: string; site: string; group_id: string | null; treatment_key: string; detail: Record<string, string> | null };

const TOOTH = /^[1-8][1-8]$/;

export async function labSpec(c: PoolClient, clinicId: string, m: MarkRow): Promise<LabSpec> {
  const mates = m.group_id
    ? (
        (
          await c.query(`select id, site, role, look, detail, treatment_key from chart_marks where group_id = $1 and clinic_id = $2 and voided_at is null`, [
            m.group_id,
            clinicId,
          ])
        ).rows as { id: string; site: string; role: string | null; look: string; detail: Record<string, string> | null; treatment_key: string }[]
      )
    : [];
  const inOrder = <T extends { site: string }>(rows: T[]) => [...rows].sort((a, b) => EVERY_TOOTH.indexOf(a.site) - EVERY_TOOTH.indexOf(b.site));
  const spec: LabSpec = { material: m.detail?.material ?? null };

  // The teeth of it: a full arch's are the ones its bridge replaces, a bridge's its own.
  const arch = mates.some((x) => !TOOTH.test(x.site));
  const teeth = arch ? mates.filter((x) => x.role === "pontic") : mates.length ? mates.filter((x) => TOOTH.test(x.site)) : TOOTH.test(m.site) ? [{ ...m, role: null, look: "" }] : [];
  const sites = teeth.map((x) => x.site);

  // Which of them stand on an implant: the arch's own, or ones placed at those teeth.
  const implants = arch
    ? mates.filter((x) => x.look === "implant")
    : sites.length
      ? ((
          await c.query(
            `select distinct on (x.site) x.id, x.site, x.detail
               from chart_marks x
              where x.clinic_id = $1 and x.patient_id = (select patient_id from chart_marks where id = $2)
                and x.site = any($3::text[]) and x.look = 'implant' and x.voided_at is null and x.status <> 'planned'
              order by x.site, x.created_at desc`,
            [clinicId, m.id, sites]
          )
        ).rows as { id: string; site: string; detail: Record<string, string> | null }[])
      : [];
  const onImplant = new Set(implants.map((x) => x.site));
  spec.teeth = inOrder(teeth).map((x) => ({
    site: x.site,
    role: x.role === "pontic" ? ("pontic" as const) : ("abutment" as const),
    ...(!arch && onImplant.has(x.site) ? { implant: true } : {}),
  }));

  if (implants.length) {
    // Their sizes as they were recorded when they were placed, else as the arch was planned.
    const rows = (
      await c.query(
        `select data from chart_mark_steps
          where clinic_id = $1 and voided_at is null and step = 'placement' and mark_id = any($2::uuid[])
          order by done_at`,
        [clinicId, arch ? [m.id] : implants.map((x) => x.id)]
      )
    ).rows.flatMap((r) => ((r.data as { implants?: ImplantRow[] })?.implants ?? []) as ImplantRow[]);
    spec.implants = inOrder(implants).map((x) => {
      const rec = rows.filter((r) => r.site === x.site).at(-1);
      const num = (v: string | undefined) => (v && Number.isFinite(Number(v)) ? Number(v) : null);
      return {
        site: x.site,
        ...(rec?.system ? { system: rec.system } : {}),
        diameter: rec?.diameter ?? num(x.detail?.dia),
        length: rec?.length ?? num(x.detail?.len),
      };
    });
  }
  return spec;
}
