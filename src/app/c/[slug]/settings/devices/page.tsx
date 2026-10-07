import { guardCap } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { appUrl } from "@/lib/urls";
import { DevicesClient, type DeviceRow } from "./devices-client";

/**
 * The clinic's imaging machines: which are connected, when each was last
 * heard from, and the key each one uses. `settings.clinic`, like the rest of
 * the clinic's configuration — a device key can put an image into any
 * patient's file.
 */
export default async function DevicesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await guardCap(slug, "settings.clinic");
  const rows = await inClinic(access, async (c) =>
    (
      await c.query(
        `select id, name, kind, match_by, key_hint, created_at, last_seen_at, images_received, revoked_at
           from clinic_devices where clinic_id = $1
          order by revoked_at nulls first, created_at`,
        [access.clinicId]
      )
    ).rows
  );
  return <DevicesClient slug={slug} base={appUrl()} initial={JSON.parse(JSON.stringify(rows)) as DeviceRow[]} />;
}
