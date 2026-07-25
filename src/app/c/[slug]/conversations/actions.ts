"use server";

import { requireClinic } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";

export async function addQuickReplyAction(
  slug: string,
  data: { title: string; body: string }
): Promise<{ id?: string; error?: string }> {
  const access = await requireClinic(slug);
  if (!data.title.trim() || !data.body.trim()) return { error: "invalid" };
  return inClinic(access, async (c) => {
    const r = await c.query(
      `insert into quick_replies (clinic_id, title, body, sort)
       values ($1, $2, $3, (select coalesce(max(sort), 0) + 1 from quick_replies where clinic_id = $1))
       returning id`,
      [access.clinicId, data.title.trim().slice(0, 60), data.body.trim().slice(0, 2000)]
    );
    return { id: r.rows[0].id as string };
  });
}

export async function deleteQuickReplyAction(slug: string, id: string) {
  const access = await requireClinic(slug);
  await inClinic(access, (c) =>
    c.query(`delete from quick_replies where id = $1 and clinic_id = $2`, [id, access.clinicId])
  );
}
