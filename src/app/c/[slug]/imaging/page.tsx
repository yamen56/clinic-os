import { guardCap } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { can } from "@/lib/auth";
import { ImagingStation, type StationDevice } from "./station-client";

/*
  The imaging station: this page, left open in Chrome or Edge on the computer
  beside the x-ray machine. It watches the folder the x-ray software saves to
  and sends each new image to the patient a doctor is waiting on. Uploading is
  what opening a patient's file already allows, so that is the gate.

  It is also where the clinic's imaging inbox lives — what a connected machine
  sent that could not be matched to anybody — and which machines are talking.
*/
export default async function ImagingStationPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await guardCap(slug, "patients");
  const devices = await inClinic(access, async (c) =>
    (
      await c.query(
        `select id, name, kind, method, paired_at, revoked_at, last_seen_at, bridge->>'host' as host from clinic_devices
          where clinic_id = $1 and revoked_at is null order by created_at`,
        [access.clinicId]
      )
    ).rows
  );
  return (
    <ImagingStation
      slug={slug}
      devices={JSON.parse(JSON.stringify(devices)) as StationDevice[]}
      canManageDevices={can(access, "settings.clinic")}
    />
  );
}
