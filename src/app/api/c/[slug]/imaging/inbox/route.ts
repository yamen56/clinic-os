import { NextResponse } from "next/server";
import { apiClinic, inClinic } from "@/lib/clinic-api";

/*
  Images a machine sent that nobody could place — waiting on the Imaging page
  for somebody to say whose they are. Oldest first, because the oldest is the
  patient most likely to have left already.
*/
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const g = await apiClinic(slug, "patients");
  if (!g.ok) return g.res;
  const items = await inClinic(g.access, async (c) =>
    (
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
    ).rows
  );
  return NextResponse.json({ items }, { headers: { "Cache-Control": "no-store" } });
}
