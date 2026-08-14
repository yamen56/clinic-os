import { guardAdminCap } from "@/lib/guard";
import { withSystem } from "@/lib/db";
import { getDict } from "@/lib/i18n";
import { PageHeader } from "@/components/ui/card";
import { AnnouncementsClient } from "./announcements-client";

export default async function AnnouncementsPage() {
  await guardAdminCap("announcements");
  const t = await getDict();
  const rows = await withSystem(async (c) => {
    const r = await c.query(
      `select a.id, a.title, a.body, a.active, a.created_at, u.full_name as author
       from announcements a left join users u on u.id = a.created_by
       order by a.created_at desc limit 50`
    );
    return r.rows;
  });

  return (
    <>
      <PageHeader title={t.admin.announcements} sub="Shown at the top of every clinic dashboard." />
      <AnnouncementsClient announcements={JSON.parse(JSON.stringify(rows))} />
    </>
  );
}
