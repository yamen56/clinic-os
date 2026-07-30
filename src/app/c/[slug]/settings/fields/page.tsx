import { guardClinic } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { loadFieldDefinitions } from "@/lib/esign/fields";
import { FieldsClient } from "./fields-client";

export default async function FieldsSettingsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const access = await guardClinic(slug);

  const { defs, usage } = await inClinic(access, async (c) => {
    const defs = await loadFieldDefinitions(c, access.clinicId, { includeHidden: true });
    // How many templates reference each variable, so hiding or deleting one is
    // an informed decision rather than a surprise.
    const bodies = await c.query(
      `select body, body_ar from document_templates where clinic_id = $1 and is_active`,
      [access.clinicId]
    );
    const usage: Record<string, number> = {};
    for (const d of defs) {
      const token = new RegExp(`\\{\\{\\s*${d.key.replace(/\./g, "\\.")}\\s*\\}\\}`);
      usage[d.key] = bodies.rows.filter(
        (r) => token.test(r.body ?? "") || token.test(r.body_ar ?? "")
      ).length;
    }
    return { defs, usage };
  });

  return (
    <FieldsClient
      slug={slug}
      isOwner={access.role === "owner"}
      defs={JSON.parse(JSON.stringify(defs))}
      usage={usage}
    />
  );
}
