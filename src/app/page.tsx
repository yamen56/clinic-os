import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getDict } from "@/lib/i18n";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Avatar } from "@/components/ui/misc";

export default async function Home() {
  const s = await getSession();
  if (!s) redirect("/login");
  if (s.memberships.length === 1 && !s.user.isSuperAdmin) {
    redirect(`/c/${s.memberships[0].clinicSlug}`);
  }
  if (s.memberships.length === 0 && s.user.isSuperAdmin) redirect("/admin");
  const t = await getDict();

  // Multi-clinic user (or admin with memberships): pick a workspace
  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center gap-4 p-6">
      <h1 className="text-xl font-semibold">{t.common.appName}</h1>
      <div className="grid gap-3">
        {s.user.isSuperAdmin && (
          <Link href="/admin">
            <Card className="flex items-center gap-3 p-4 transition-shadow hover:shadow-pop">
              <Avatar name="⚙" color="var(--color-ink-700)" />
              <div>
                <div className="font-medium">{t.admin.title}</div>
                <div className="text-sm text-ink-500">Makan Scaling</div>
              </div>
            </Card>
          </Link>
        )}
        {s.memberships.map((m) => (
          <Link key={m.clinicId} href={`/c/${m.clinicSlug}`}>
            <Card className="flex items-center gap-3 p-4 transition-shadow hover:shadow-pop">
              <Avatar name={m.clinicName} />
              <div>
                <div className="font-medium">{m.clinicNameAr || m.clinicName}</div>
                <div className="text-sm text-ink-500">{m.role}</div>
              </div>
            </Card>
          </Link>
        ))}
      </div>
    </main>
  );
}
