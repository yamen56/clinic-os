import { redirect } from "next/navigation";
import { guardClinic } from "@/lib/guard";
import { can } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";
import { TagsClient } from "./tags-client";

export default async function TagsSettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await guardClinic(slug);
  if (!can(access, "settings")) redirect(`/c/${slug}`);

  const tags = await inClinic(access, async (c) => {
    /*
      The usage count comes from the patients array rather than a join table,
      because that array is still where assignments live. It is what makes
      "delete this tag" an informed decision instead of a guess.
    */
    const r = await c.query(
      `select t.id, t.name, t.color,
              (select count(*) from patients p
                where p.clinic_id = t.clinic_id and t.name = any(p.tags))::int as used
         from clinic_tags t
        where t.clinic_id = $1
        order by t.sort, t.name`,
      [access.clinicId]
    );
    return r.rows;
  });

  return <TagsClient slug={slug} tags={JSON.parse(JSON.stringify(tags))} />;
}
