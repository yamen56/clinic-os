import type { PoolClient } from "pg";

/**
 * Loading a clinic's services, and the sections they sit in.
 *
 * Sections arrived in migration 0047 and reached four screens. The other six
 * kept their own `select id, name from services` and so kept showing one flat
 * list — which is how the invoice builder ended up offering the first six
 * services as chips and nothing else at all. This is the one loader they all
 * use, so a screen cannot quietly opt out of knowing about sections again.
 *
 * The ordering is the idiom 0047 established, which was copied verbatim into
 * three files before this existed: unfiled last (`false < true`), then the
 * clinic's own order of sections, then of services within each.
 */

export type ServiceRow = {
  id: string;
  name: string;
  name_ar: string | null;
  price: string;
  duration_min: number;
  color: string;
  bookable_online: boolean;
  section_id: string | null;
};

export type SectionRow = {
  id: string;
  name: string;
  name_ar: string | null;
  color: string;
};

export type ServicesAndSections = { services: ServiceRow[]; sections: SectionRow[] };

/**
 * `sections` is empty for a clinic that has never made one, and every picker
 * built on this renders exactly as it did before sections existed when that is
 * the case. That invariant is the first thing `qa-service-sections` asserts,
 * and it is the reason none of this needed a backfill.
 */
export async function loadServicesWithSections(
  c: PoolClient,
  clinicId: string,
  opts: { onlyActive?: boolean; onlyBookableOnline?: boolean } = {}
): Promise<ServicesAndSections> {
  const where = ["s.clinic_id = $1"];
  if (opts.onlyActive !== false) where.push("s.active");
  if (opts.onlyBookableOnline) where.push("s.bookable_online");

  const services = (
    await c.query(
      `select s.id, s.name, s.name_ar, s.price, s.duration_min, s.color,
              s.bookable_online, s.section_id
         from services s
         left join service_sections sec on sec.id = s.section_id
        where ${where.join(" and ")}
        order by (s.section_id is null), sec.sort, sec.name, s.sort, s.name`,
      [clinicId]
    )
  ).rows as ServiceRow[];

  /*
    Inactive sections are left out, which is also the first thing that has ever
    read this column: 0047 shipped `active` and nothing ever filtered on it or
    set it, so it looked like a working switch and was not. A service still
    pointing at a hidden section falls into the unfiled group rather than
    vanishing — the same place a deleted section's services land.
  */
  const sections = (
    await c.query(
      `select id, name, name_ar, color from service_sections
        where clinic_id = $1 and active order by sort, name`,
      [clinicId]
    )
  ).rows as SectionRow[];

  return { services, sections };
}

/**
 * The clinic's own word for a service or a section.
 *
 * Written out once because it was copied into four components, each with its
 * own small differences, and because the SQL shortcut for it — `coalesce(name_ar,
 * name)` — is wrong in English and is flagged as a bug where it still survives:
 * a clinic with Arabic names set would have them shown to an English reader.
 */
export function serviceLabel(
  x: { name: string; name_ar: string | null },
  locale: string
): string {
  return locale === "ar" ? x.name_ar || x.name : x.name;
}

/**
 * The least a picker needs to know.
 *
 * Declared separately from `ServiceRow` so a screen that already selects four
 * columns is not made to fetch a price and a duration it will not render. The
 * grouping below is generic over both.
 */
export type ServiceLike = { id: string; name: string; name_ar: string | null; section_id: string | null };
export type SectionLike = { id: string; name: string; name_ar: string | null; color?: string };

export type ServiceGroup<S extends ServiceLike = ServiceRow, K extends SectionLike = SectionRow> = {
  section: K | null;
  services: S[];
};

/**
 * Services under their section headings, in the order the query returned them.
 *
 * Returns a single unlabelled group when the clinic has no sections, so callers
 * can render one loop either way rather than branching — the branch is what
 * drifted across six screens the first time.
 */
export function groupBySection<S extends ServiceLike, K extends SectionLike>(
  services: S[],
  sections: K[]
): ServiceGroup<S, K>[] {
  if (!sections.length) return services.length ? [{ section: null, services }] : [];
  const byId = new Map(sections.map((s) => [s.id, s]));
  const groups: ServiceGroup<S, K>[] = [];
  for (const s of services) {
    const section = (s.section_id && byId.get(s.section_id)) || null;
    const last = groups[groups.length - 1];
    if (last && last.section?.id === section?.id) last.services.push(s);
    else groups.push({ section, services: [s] });
  }
  return groups;
}
