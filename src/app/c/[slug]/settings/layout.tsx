import { guardClinic } from "@/lib/guard";
import { redirect } from "next/navigation";
import { dictForClinic } from "@/lib/i18n";
import { PageHeader } from "@/components/ui/card";
import { SettingsNav } from "./settings-nav";
import { can } from "@/lib/auth";

export default async function SettingsLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const access = await guardClinic(slug);
  if (!can(access, "settings")) redirect(`/c/${slug}`);
  const t = await dictForClinic(access.clinic.vocabulary);

  return (
    <>
      <PageHeader title={t.settings.title} />
      <div className="grid gap-6 lg:grid-cols-[13rem_1fr]">
        <SettingsNav slug={slug} canClinic={can(access, "settings.clinic")} canStaff={can(access, "settings.staff")} />
        <div className="min-w-0">{children}</div>
      </div>
    </>
  );
}
