import Link from "next/link";
import { guardClinic } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { dictForClinic } from "@/lib/i18n";
import { PageHeader, Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PhotoPicker } from "@/components/photo-picker";
import { LanguageToggle } from "@/components/language-toggle";
import { InstallApp } from "@/components/pwa";
import { logoutAction } from "@/app/login/actions";
import { CLINICTI_PRIVACY_URL, CLINICTI_TERMS_URL } from "@/components/powered-by";
import { CAPABILITY_GROUPS, accessLevelOf, resolveCapabilities } from "@/lib/permissions";
import { PenTool, Bell, LogOut, ChevronLeft, Building2, Lock } from "lucide-react";

/**
 * A member's own account.
 *
 * Reachable by every role, and deliberately not under /settings — that section
 * needs a capability most doctors do not have, and everyone needs to be able to
 * see who they are signed in as, change their photo and language, and sign out.
 * On a phone this is the only place those live: the desktop sidebar shows them
 * in its footer, which does not exist on a small screen.
 */
export default async function ProfilePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await guardClinic(slug);
  const t = await dictForClinic(access.clinic.vocabulary);
  const base = `/c/${slug}`;

  const me = await inClinic(access, async (c) => {
    const r = await c.query(
      `select u.full_name, u.email, u.avatar_path is not null as has_photo,
              u.signature_png_path is not null as has_signature,
              cm.color, cm.title, cm.specialty,
              (select count(*) from notifications n where n.user_id = u.id and n.read_at is null)::int as unread
         from users u
         left join clinic_members cm on cm.id = $2
        where u.id = $1`,
      [access.session.user.id, access.memberId]
    );
    return r.rows[0] as {
      full_name: string;
      email: string;
      has_photo: boolean;
      has_signature: boolean;
      color: string | null;
      title: string | null;
      specialty: string | null;
      unread: number;
    };
  });

  const caps = resolveCapabilities(null, { isOwner: access.isOwner, role: access.role });
  void caps;
  const level = access.isOwner ? "full" : accessLevelOf(null);
  const sections = CAPABILITY_GROUPS.filter((g) => access.caps[g.section]).length;

  const rows: { href: string; icon: React.ReactNode; label: string; hint?: string; badge?: number }[] = [
    {
      href: `${base}/signature`,
      icon: <PenTool className="h-[18px] w-[18px] text-ink-400" />,
      label: t.settings.mySignature,
      hint: me?.has_signature ? t.mySignature.saved : t.mySignature.firstTime,
    },
    {
      href: `${base}/notifications`,
      icon: <Bell className="h-[18px] w-[18px] text-ink-400" />,
      label: t.nav.notifications,
      badge: me?.unread ?? 0,
    },
  ];

  return (
    <>
      <PageHeader title={t.profile.title} sub={t.profile.sub} />

      <div className="grid gap-4">
        <Card className="p-5">
          <div className="grid gap-4">
            {access.memberId ? (
              <PhotoPicker
                slug={slug}
                memberId={access.memberId}
                name={me?.full_name ?? access.session.user.fullName}
                hasPhoto={!!me?.has_photo}
                color={me?.color ?? undefined}
                size={64}
              />
            ) : null}

            <div className="grid gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[17px] font-semibold">
                  {me?.title ? `${me.title} ` : ""}
                  {me?.full_name ?? access.session.user.fullName}
                </span>
                <Badge status={access.role === "doctor" ? "confirmed" : "neutral"}>
                  {t.staff.roles[access.role]}
                </Badge>
                {access.isOwner && (
                  <Badge status="brand">
                    <Lock className="h-3 w-3" />
                    {t.staff.owner}
                  </Badge>
                )}
              </div>
              <span className="num text-[13px] text-ink-500">{me?.email}</span>
              {me?.specialty && <span className="text-[13px] text-ink-500">{me.specialty}</span>}
            </div>
          </div>
        </Card>

        {/* What this account may reach, stated rather than discovered by bumping into it. */}
        <Card className="p-5">
          <div className="flex items-center gap-2.5">
            <Building2 className="h-[18px] w-[18px] shrink-0 text-ink-400" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">{access.clinic.nameAr || access.clinic.name}</div>
              <div className="text-[12px] text-ink-500">
                {level === "full"
                  ? t.staff.fullAccess
                  : t.staff.partialAccess
                      .replace("{n}", String(sections))
                      .replace("{total}", String(CAPABILITY_GROUPS.length))}
              </div>
            </div>
          </div>
        </Card>

        <Card>
          <ul className="divide-y divide-line">
            {rows.map((r) => (
              <li key={r.href}>
                <Link
                  href={r.href}
                  className="flex touch-manipulation items-center gap-3 px-5 py-3.5 transition-colors duration-140 ease-out hover:bg-sunken active:bg-sunken"
                >
                  {r.icon}
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{r.label}</span>
                    {r.hint && <span className="block text-[12px] text-ink-500">{r.hint}</span>}
                  </span>
                  {!!r.badge && (
                    <span className="rounded-full bg-brand-100 px-1.5 py-0.5 text-[11px] font-semibold text-brand-700 tnum">
                      {r.badge > 99 ? "99+" : r.badge}
                    </span>
                  )}
                  <ChevronLeft className="h-4 w-4 shrink-0 text-ink-300 rtl:rotate-180" />
                </Link>
              </li>
            ))}
          </ul>
        </Card>

        <Card className="p-5">
          <div className="grid justify-items-start gap-3">
            <LanguageToggle />
            <InstallApp presentation="button" />
          </div>
        </Card>

        {/*
          The one place a signed-in clinic can go back and read what it agreed
          to. The mobile "more" sheet would be the obvious alternative and is
          already at the height it overflows at, and a party to an agreement
          should not have to find it through a marketing site.
        */}
        <p className="flex items-center justify-center gap-3 text-xs text-ink-400">
          <a
            href={CLINICTI_TERMS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="no-underline transition-colors hover:text-ink-700"
          >
            {t.invite.terms}
          </a>
          <span aria-hidden="true">·</span>
          <a
            href={CLINICTI_PRIVACY_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="no-underline transition-colors hover:text-ink-700"
          >
            {t.invite.privacy}
          </a>
        </p>

        <form action={logoutAction}>
          <button className="flex w-full touch-manipulation items-center justify-center gap-2 rounded-card border border-line bg-surface px-4 py-3 text-sm font-medium text-danger transition-colors duration-140 ease-out hover:bg-danger-soft">
            <LogOut className="h-4 w-4" />
            {t.auth.signOut}
          </button>
        </form>
      </div>
    </>
  );
}
