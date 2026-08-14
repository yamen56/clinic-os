import { guardClinic } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { ServiceWorkerRegistrar } from "@/components/pwa";
import { Shell } from "./shell";
import { dictForClinic, getLocale } from "@/lib/i18n";
import { I18nProvider } from "@/lib/i18n/client";

export default async function ClinicLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const access = await guardClinic(slug);

  // The clinic row arrives with the session, so the chrome costs one query:
  // the unread badge and the announcement strip, fetched together.
  const chrome = await inClinic(access, async (c) => {
    const r = await c.query(
      `select
         (select coalesce(sum(unread_count), 0)::int from conversations where clinic_id = $1) as unread,
         (select count(*)::int from documents
           where clinic_id = $1 and status in ('sent', 'partially_signed')) as pending_documents,
         (select avatar_path is not null from users where id = $2) as has_photo,
         coalesce((
           select json_agg(json_build_object('id', a.id, 'title', a.title, 'body', a.body))
           from (
             select id, title, body from announcements where active order by created_at desc limit 3
           ) a
         ), '[]'::json) as announcements`,
      [access.clinicId, access.session.user.id]
    );
    return r.rows[0] as {
      unread: number;
      pending_documents: number;
      has_photo: boolean;
      announcements: { id: string; title: string; body: string }[];
    };
  });

  const dismissed = (access.session.user.settings?.dismissedAnnouncements ?? []) as string[];
  const clinic = access.clinic;

  /*
    A second provider, inside the root one.

    The root layout mounts the visitor's dictionary before it knows which
    workspace is being opened — it has to, because /login and the public pages
    need one too. By the time we are here the clinic is known, so this remounts
    the context with that clinic's vocabulary. React takes the nearest provider,
    so every client component below reads the right words without being told.

    For a clinic on the default vocabulary this is the same object the root
    already provided, so the extra provider costs nothing but a render.
  */
  const locale = await getLocale();
  const dict = await dictForClinic(clinic.vocabulary);

  return (
    <I18nProvider dict={dict} locale={locale}>
    <Shell
      clinic={{
        id: clinic.id,
        name: clinic.name,
        nameAr: clinic.nameAr,
        slug: clinic.slug,
        brandColor: clinic.brandColor,
        logoPath: clinic.logoPath,
      }}
      role={access.role}
      isOwner={access.isOwner}
      caps={access.caps}
      userName={access.session.user.fullName}
      userId={access.session.user.id}
      memberId={access.memberId}
      hasPhoto={!!chrome.has_photo}
      isImpersonating={access.isImpersonating}
      unreadCount={chrome.unread}
      pendingDocuments={chrome.pending_documents}
      announcements={chrome.announcements.filter((a) => !dismissed.includes(a.id))}
    >
      {/*
        The worker is registered here rather than in the root layout, so it is
        scoped to the staff workspace. The public pages under this app are
        one-time patient links — a signing link, an invoice, a booking form.
        Leaving a service worker and a cache behind in a patient's browser
        after they have signed once is not something they asked for, and the
        registration competes with the page they actually came for.
      */}
      <ServiceWorkerRegistrar />
      {children}
    </Shell>
    </I18nProvider>
  );
}
