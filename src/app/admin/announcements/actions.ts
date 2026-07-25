"use server";

import { revalidatePath } from "next/cache";
import { requireSuperAdmin } from "@/lib/auth";
import { withSystem } from "@/lib/db";
import { audit } from "@/lib/audit";

export async function createAnnouncementAction(data: { title: string; body: string }) {
  const s = await requireSuperAdmin();
  if (!data.title.trim()) return { error: "invalid" };
  await withSystem(async (c) => {
    const r = await c.query(
      `insert into announcements (title, body, created_by) values ($1, $2, $3) returning id`,
      [data.title.trim().slice(0, 120), data.body.trim().slice(0, 500), s.user.id]
    );
    await audit(c, {
      userId: s.user.id,
      action: "admin.announcement.create",
      entity: "announcement",
      entityId: r.rows[0].id,
      detail: { title: data.title },
    });
  });
  revalidatePath("/admin/announcements");
  return {};
}

export async function toggleAnnouncementAction(id: string, active: boolean) {
  await requireSuperAdmin();
  await withSystem((c) => c.query(`update announcements set active = $2 where id = $1`, [id, active]));
  revalidatePath("/admin/announcements");
}

export async function deleteAnnouncementAction(id: string) {
  await requireSuperAdmin();
  await withSystem((c) => c.query(`delete from announcements where id = $1`, [id]));
  revalidatePath("/admin/announcements");
}
