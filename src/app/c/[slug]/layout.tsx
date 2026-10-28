import { guardClinic } from "@/lib/guard";
import { hasFullControl } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";
import { ServiceWorkerRegistrar } from "@/components/pwa";
import { AutosaveGuard } from "@/components/autosave-guard";
import { Shell } from "./shell";
import { getLocale } from "@/lib/i18n";
import { dictSources } from "@/lib/i18n/asset";
import { I18nProvider } from "@/lib/i18n/client";
import { chartColorsFor } from "@/lib/brand-chart";
import { cookies } from "next/headers";
import { SIDEBAR_COOKIE, parseSidebarPref } from "@/lib/theme";

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
         -- The bell's count, and what this person wants done with a new one.
         (select count(*)::int from notifications where user_id = $2 and read_at is null) as notif_unread,
         (select notification_prefs from users where id = $2) as notification_prefs,
         now() as server_now,
         /*
           Whether this person has anything of their own on the Earnings screen:
           a share agreed with them now, or money already earned under one that
           has since ended. Either way it is theirs to look at; neither means
           they see anybody else's.

           A doctor with no arrangement gets no nav item and no page, rather
           than a screen explaining that the feature is not set up — which is
           the clinic's business and not a thing to advertise to staff.

           $3 is null while a super admin is impersonating, so both halves are
           false and support reaches the screen through invoices.analytics
           instead, which is the right door for it.
         */
         (
           exists(select 1 from clinic_members
                   where id = $3 and clinic_id = $1
                     and (commission_percent is not null or on_call_fee is not null))
           or exists(select 1 from invoice_line_doctors
                      where clinic_id = $1 and doctor_member_id = $3)
           or exists(select 1 from on_call_visits
                      where clinic_id = $1 and doctor_member_id = $3)
         ) as has_earnings,
         -- Claims are a Finance tab only for a clinic that deals with insurers,
         -- and for somebody with Insurance and nothing else in Finance it is
         -- the tab the sidebar entry has to point at.
         exists(select 1 from insurers where clinic_id = $1 and active) as has_insurers,
         -- The Devices entry, and its badge: results no machine said whose they are.
         exists(select 1 from clinic_devices where clinic_id = $1 and revoked_at is null) as has_devices,
         (select count(*)::int from imaging_inbox
           where clinic_id = $1 and assigned_at is null and discarded_at is null) as devices_waiting,
         -- The Lab work entry, once the clinic keeps a lab, and its badge: work back later than promised.
         exists(select 1 from dental_labs where clinic_id = $1 and active) as has_labs,
         (select count(*)::int from lab_cases
           where clinic_id = $1 and status = 'sent' and due_on < (now() at time zone (select timezone from clinics where id = $1))::date) as labs_late,
         -- The Stock entry's badge: face chart products in use that are running low or out.
         (select count(*)::int from aesthetic_products p
           where p.clinic_id = $1 and p.active and p.low_stock is not null
             and coalesce((select sum(m.qty) from stock_moves m where m.product_id = p.id), 0) <= p.low_stock) as stock_low,
         coalesce((
           select json_agg(json_build_object('id', a.id, 'title', a.title, 'body', a.body))
           from (
             select id, title, body from announcements where active order by created_at desc limit 3
           ) a
         ), '[]'::json) as announcements`,
      [access.clinicId, access.session.user.id, access.memberId]
    );
    return r.rows[0] as {
      unread: number;
      pending_documents: number;
      has_photo: boolean;
      notif_unread: number;
      notification_prefs: Record<string, unknown> | null;
      server_now: Date;
      has_earnings: boolean;
      has_insurers: boolean;
      has_devices: boolean;
      devices_waiting: number;
      has_labs: boolean;
      labs_late: number;
      stock_low: number;
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

    For a clinic on the default vocabulary the file is the one the root already
    loaded, so the extra provider costs nothing but a render. The agency's own
    workspace fetches its file once, then keeps it like any other.
  */
  const locale = await getLocale();

  /*
    The clinic's own colour for its charts.

    Overriding the two tokens here rather than inside a chart component means
    every bar, track and sparkline in the workspace follows without any of them
    knowing a clinic exists — and the admin panel, which is outside this layout,
    keeps the default. `display: contents` so the wrapper carries the variables
    without adding a box to the layout.

    Derived, never used raw: brand colours in this database run from a near-black
    navy to a bright yellow, and both are unreadable as a bar on white. See
    lib/brand-chart for how the hue is kept and the lightness and chroma are
    snapped back into the validated band.
  */
  const chartVars = chartColorsFor(clinic.brandColor);
  /* Read here so the first paint already has the sidebar at the width this person left it. */
  const sidebar = parseSidebarPref((await cookies()).get(SIDEBAR_COOKIE)?.value);

  return (
    <I18nProvider locale={locale} vocabulary={clinic.vocabulary} src={dictSources(clinic.vocabulary)}>
    {/*
      As --clinic-*, picked up by .clinic-chart-vars in globals.css, rather than
      as --color-chart inline: an inline value would outrank the dark theme,
      which lifts the bar and sinks the track to suit the night surface.
    */}
    <div
      className="clinic-chart-vars"
      style={
        {
          display: "contents",
          "--clinic-chart": chartVars.chart,
          "--clinic-chart-soft": chartVars.soft,
        } as React.CSSProperties
      }
    >
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
      sidebar={sidebar}
      isOwner={access.isOwner}
      caps={access.caps}
      userName={access.session.user.fullName}
      userId={access.session.user.id}
      memberId={access.memberId}
      hasPhoto={!!chrome.has_photo}
      isImpersonating={access.isImpersonating}
      unreadCount={chrome.unread}
      notifications={{
        unread: chrome.notif_unread,
        serverNow: new Date(chrome.server_now).toISOString(),
        prefs: {
          popups: chrome.notification_prefs?.popups !== false,
          sound: chrome.notification_prefs?.sound === true,
        },
      }}
      pendingDocuments={chrome.pending_documents}
      hasEarnings={!!chrome.has_earnings}
      hasInsurers={!!chrome.has_insurers}
      devices={{ connected: !!chrome.has_devices, waiting: chrome.devices_waiting }}
      labs={{ kept: !!chrome.has_labs && clinic.features.dental, late: chrome.labs_late }}
      stock={{ kept: !!clinic.features.aesthetic, low: chrome.stock_low }}
      fullControl={hasFullControl(access)}
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
      <AutosaveGuard />
      {children}
    </Shell>
    </div>
    </I18nProvider>
  );
}
