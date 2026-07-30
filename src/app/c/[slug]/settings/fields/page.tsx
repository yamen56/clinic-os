import { guardCap } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { loadFieldDefinitions } from "@/lib/esign/fields";
import { FieldsClient } from "./fields-client";
import { can } from "@/lib/auth";

export default async function FieldsSettingsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  /*
    Guarded rather than rendered read-only, unlike the other settings screens.
    The nav hides this one without `settings.clinic`, and a screen that is hidden
    from the menu but still opens by URL is a boundary that does not mean
    anything. Hours and services stay visible-but-locked deliberately — knowing
    the clinic's opening times is not the same as editing the field definitions
    every document is built from.
  */
  const access = await guardCap(slug, "settings.clinic");

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
      isOwner={can(access, "settings.clinic")}
      defs={JSON.parse(JSON.stringify(defs))}
      usage={usage}
    />
  );
}
