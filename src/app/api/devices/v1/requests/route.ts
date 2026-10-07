import { NextResponse } from "next/server";
import { deviceAuth, inDeviceClinic } from "@/lib/imaging/devices";
import { IMAGING_REQUEST_OPEN_FOR } from "@/lib/imaging/ingest";

/*
  Who a doctor is waiting on an image for, oldest first — the same list the
  imaging station shows. A bridge that can put a patient on the machine (a
  worklist, a command line to the x-ray software) reads it here; one that
  cannot simply uploads, and the image answers the oldest of these.
*/
export async function GET(req: Request) {
  const g = await deviceAuth(req);
  if (!g.ok) return g.res;
  const rows = await inDeviceClinic(g.device, async (c) =>
    (
      await c.query(
        `select r.id, r.teeth, r.kind, r.created_at,
                p.id as patient_id, p.file_no, p.full_name, to_char(p.birth_date, 'YYYY-MM-DD') as birth_date, p.gender,
                u.full_name as requested_by
           from imaging_requests r
           join patients p on p.id = r.patient_id
           left join users u on u.id = r.requested_by
          where r.clinic_id = $1 and r.fulfilled_at is null and r.cancelled_at is null
            and r.created_at > now() - interval '${IMAGING_REQUEST_OPEN_FOR}'
          order by r.created_at`,
        [g.device.clinicId]
      )
    ).rows
  );
  return NextResponse.json(
    {
      requests: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        teeth: r.teeth,
        createdAt: r.created_at,
        requestedBy: r.requested_by,
        patient: {
          id: r.patient_id,
          fileNo: r.file_no,
          name: r.full_name,
          birthDate: r.birth_date,
          sex: r.gender === "male" ? "M" : r.gender === "female" ? "F" : null,
        },
      })),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
