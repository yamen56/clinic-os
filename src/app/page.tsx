import { redirect } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { getSession, landingPathFor } from "@/lib/auth";
import { getDict } from "@/lib/i18n";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Avatar } from "@/components/ui/misc";

export default async function Home() {
  const s = await getSession();
  if (!s) redirect("/login");
  const landing = landingPathFor({
    isSuperAdmin: s.user.isSuperAdmin,
    clinicSlugs: s.memberships.map((m) => m.clinicSlug),
  });
  if (landing !== "/") redirect(landing);
  const t = await getDict();

  // Multi-clinic user (or admin with memberships): pick a workspace
  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center gap-4 p-6">
      <h1 className="font-display text-xl font-bold">{t.common.appName}</h1>
      <div className="grid gap-3">
        {s.user.isSuperAdmin && (
          <Link href="/admin">
            <Card className="flex items-center gap-3 p-4 transition-shadow hover:shadow-pop">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-100 text-brand-700">
                <ShieldCheck className="h-4.5 w-4.5" strokeWidth={1.75} />
              </span>
              <div>
                <div className="font-medium">{t.admin.title}</div>
                <div className="text-sm text-ink-500">Clinicti</div>
              </div>
            </Card>
          </Link>
        )}
        {s.memberships.map((m) => {
          /*
            A removed workspace stays on this list rather than vanishing —
            somebody who worked there should see what happened to it, not find
            their clinic quietly missing — but it is not a link. Clicking
            through would only reach the same message with a page load in
            between.
          */
          if (m.deletedAt) {
            return (
              <Card key={m.clinicId} className="flex items-center gap-3 p-4 opacity-60">
                <Avatar name={m.clinicName} />
                <div>
                  <div className="font-medium">{m.clinicNameAr || m.clinicName}</div>
                  <div className="text-sm text-ink-500">{t.auth.removedTitle}</div>
                </div>
              </Card>
            );
          }
          return (
            <Link key={m.clinicId} href={`/c/${m.clinicSlug}`}>
              <Card className="flex items-center gap-3 p-4 transition-shadow hover:shadow-pop">
                <Avatar name={m.clinicName} />
                <div>
                  <div className="font-medium">{m.clinicNameAr || m.clinicName}</div>
                  <div className="text-sm text-ink-500">
                    {m.isOwner ? t.staff.owner : t.staff.roles[m.role]}
                  </div>
                </div>
              </Card>
            </Link>
          );
        })}
      </div>
    </main>
  );
}
