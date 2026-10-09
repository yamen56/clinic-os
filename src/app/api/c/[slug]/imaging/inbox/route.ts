import { NextResponse } from "next/server";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { nameWords } from "@/lib/imaging/ingest";

/*
  Images a machine sent that nobody could place — waiting on the Imaging page
  for somebody to say whose they are. Oldest first, because the oldest is the
  patient most likely to have left already.

  Each comes with up to three likely patients, from what the machine said
  about it: the same birth date counts most, then each word of the name they
  share. Filing becomes one tap on the right name instead of a search — the
  person still chooses; nothing is filed on a guess.
*/

type Hint = { machine?: { id?: string; name?: string; birthDate?: string | null } };

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const g = await apiClinic(slug, "patients");
  if (!g.ok) return g.res;
  const items = await inClinic(g.access, async (c) => {
    const rows = (
      await c.query(
        `select i.id, i.file_name, i.mime_type, i.size_bytes, i.kind, i.teeth, i.received_at, i.hint,
                i.dicom->>'modality' as modality, i.dicom->>'description' as description,
                i.dicom->>'studyDate' as study_date, jsonb_array_length(coalesce(i.dicom->'instances', '[]')) as instances,
                d.name as device_name, d.kind as device_kind
           from imaging_inbox i left join clinic_devices d on d.id = i.device_id
          where i.clinic_id = $1 and i.assigned_at is null and i.discarded_at is null
          order by i.received_at
          limit 100`,
        [g.access.clinicId]
      )
    ).rows;

    for (const row of rows) {
      const m = (row.hint as Hint | null)?.machine;
      const words = m?.name ? nameWords(m.name) : [];
      const birth = m?.birthDate && /^\d{4}-\d{2}-\d{2}$/.test(m.birthDate) ? m.birthDate : null;
      row.suggestions = [];
      if (!words.length && !birth) continue;
      const candidates = (
        await c.query(
          `select p.id, p.full_name, p.file_no, to_char(p.birth_date, 'YYYY-MM-DD') as birth_date
             from patients p
            where p.clinic_id = $1 and p.merged_into is null
              and (p.birth_date = $2::date
                   or exists (select 1 from unnest($3::text[]) w where ar_normalize(p.full_name) like '%' || ar_normalize(w) || '%'))
            limit 30`,
          [g.access.clinicId, birth, words]
        )
      ).rows as { id: string; full_name: string; file_no: number | null; birth_date: string | null }[];
      row.suggestions = candidates
        .map((p) => {
          const theirs = new Set(nameWords(p.full_name));
          const shared = words.filter((w) => theirs.has(w)).length;
          return { ...p, score: (birth && p.birth_date === birth ? 2 : 0) + shared };
        })
        .filter((p) => p.score >= 2)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);
    }
    return rows;
  });
  return NextResponse.json({ items }, { headers: { "Cache-Control": "no-store" } });
}
