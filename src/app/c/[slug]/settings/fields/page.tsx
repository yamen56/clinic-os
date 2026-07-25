import { guardClinic } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { FieldsClient } from "./fields-client";

export default async function FieldsSettingsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const access = await guardClinic(slug);
  const defs = await inClinic(access, async (c) => {
    const r = await c.query(
      `select id, key, label, label_ar, field_type, options from custom_field_defs
       where clinic_id = $1 order by sort`,
      [access.clinicId]
    );
    return r.rows;
  });
  return <FieldsClient slug={slug} isOwner={access.role === "owner"} defs={JSON.parse(JSON.stringify(defs))} />;
}
