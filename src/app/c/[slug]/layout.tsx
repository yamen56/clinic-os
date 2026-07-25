import { guardClinic } from "@/lib/guard";
import { withCtx, withSystem } from "@/lib/db";
import { Shell } from "./shell";

export default async function ClinicLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const access = await guardClinic(slug);

  const { clinic, unread, announcements } = await withCtx(
    { userId: access.session.user.id, clinicId: access.clinicId, role: access.role, isAdmin: access.session.user.isSuperAdmin },
    async (c) => {
      const clinic = (
        await c.query(
          "select id, name, name_ar, slug, logo_path, brand_color, timezone, default_locale, subscription_status from clinics where id = $1",
          [access.clinicId]
        )
      ).rows[0];
      const unread = (
        await c.query(
          "select coalesce(sum(unread_count), 0)::int as n from conversations where clinic_id = $1",
          [access.clinicId]
        )
      ).rows[0].n;
      const announcements = (
        await c.query("select id, title, body from announcements where active order by created_at desc limit 3")
      ).rows;
      return { clinic, unread, announcements };
    }
  );

  const dismissed = (access.session.user.settings?.dismissedAnnouncements ?? []) as string[];

  return (
    <Shell
      clinic={{
        id: clinic.id,
        name: clinic.name,
        nameAr: clinic.name_ar,
        slug: clinic.slug,
        brandColor: clinic.brand_color,
        logoPath: clinic.logo_path,
      }}
      role={access.role}
      permissions={access.permissions}
      userName={access.session.user.fullName}
      userId={access.session.user.id}
      isImpersonating={access.isImpersonating}
      unreadCount={unread}
      announcements={announcements.filter((a) => !dismissed.includes(a.id))}
    >
      {children}
    </Shell>
  );
}
