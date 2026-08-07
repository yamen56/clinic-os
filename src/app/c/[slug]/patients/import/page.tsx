import { redirect } from "next/navigation";
import { guardClinic } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { can } from "@/lib/auth";
import { ImportClient } from "./import-client";

export default async function ImportPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await guardClinic(slug);
  if (!can(access, "patients")) redirect(`/c/${slug}`);

  // Past imports, so an operator can find and undo the one they regret rather
  // than having to remember which of today's three attempts was wrong.
  const batches = await inClinic(access, async (c) =>
    (
      await c.query(
        `select b.id, b.filename, b.row_count, b.created_count, b.matched_count,
                b.skipped_count, b.undone_at, b.created_at, u.full_name as by_name
           from import_batches b left join users u on u.id = b.created_by
          where b.clinic_id = $1 order by b.created_at desc limit 10`,
        [access.clinicId]
      )
    ).rows
  );

  return (
    <ImportClient
      slug={slug}
      tz={access.clinic.timezone}
      batches={JSON.parse(JSON.stringify(batches))}
    />
  );
}
