import { NextResponse } from "next/server";
import { deviceAuth, inDeviceClinic } from "@/lib/imaging/devices";
import { dayRangeUtc } from "@/lib/dates";

/*
  Today's patients, for a machine's worklist.

  An OPG or a sensor's software can pull the day's patients from a DICOM
  Modality Worklist instead of having them typed in; a local relay serves
  that worklist from this list. The point is the Patient ID: when it is the
  Clinicti file number, every image the machine takes carries it back, and
  the device (set to "the machine uses Clinicti numbers") files it to the
  right patient with nobody touching anything.

  Only the clinic's own day, only who is booked, and only what a worklist
  needs: no phone numbers, no notes.
*/
export async function GET(req: Request) {
  const g = await deviceAuth(req);
  if (!g.ok) return g.res;
  const day = new URL(req.url).searchParams.get("date");
  const range = dayRangeUtc(g.device.timezone, day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : undefined);
  const rows = await inDeviceClinic(g.device, async (c) =>
    (
      await c.query(
        `select a.id, a.starts_at, a.ends_at, a.status,
                p.id as patient_id, p.file_no, p.full_name, to_char(p.birth_date, 'YYYY-MM-DD') as birth_date, p.gender,
                du.full_name as doctor, s.name as service
           from appointments a
           join patients p on p.id = a.patient_id
           left join clinic_members dm on dm.id = a.doctor_member_id
           left join users du on du.id = dm.user_id
           left join services s on s.id = a.service_id
          where a.clinic_id = $1 and a.starts_at >= $2 and a.starts_at < $3
            and a.status in ('scheduled', 'confirmed', 'completed')
          order by a.starts_at`,
        [g.device.clinicId, range.start, range.end]
      )
    ).rows
  );
  return NextResponse.json(
    {
      date: range.day,
      timezone: g.device.timezone,
      appointments: rows.map((r) => ({
        id: r.id,
        startsAt: r.starts_at,
        endsAt: r.ends_at,
        status: r.status,
        doctor: r.doctor,
        service: r.service,
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
