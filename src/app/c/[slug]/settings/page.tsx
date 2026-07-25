import { guardClinic } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { ClinicProfileForm } from "./profile-form";

export default async function ClinicProfileSettings({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const access = await guardClinic(slug);
  const clinic = await inClinic(access, async (c) => {
    const r = await c.query(
      `select name, name_ar, phone_e164, address, address_ar, google_maps_url,
              brand_color, default_locale, timezone, logo_path
       from clinics where id = $1`,
      [access.clinicId]
    );
    return r.rows[0];
  });

  return (
    <ClinicProfileForm
      slug={slug}
      isOwner={access.role === "owner"}
      clinic={JSON.parse(JSON.stringify(clinic))}
    />
  );
}
