import { guardClinic } from "@/lib/guard";
import { redirect } from "next/navigation";
import { getDict } from "@/lib/i18n";
import { PageHeader } from "@/components/ui/card";
import { SettingsNav } from "./settings-nav";

export default async function SettingsLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const access = await guardClinic(slug);
  if (access.role === "doctor") redirect(`/c/${slug}`);
  const t = await getDict();

  return (
    <>
      <PageHeader title={t.settings.title} />
      <div className="grid gap-6 lg:grid-cols-[13rem_1fr]">
        <SettingsNav slug={slug} isOwner={access.role === "owner"} />
        <div className="min-w-0">{children}</div>
      </div>
    </>
  );
}
