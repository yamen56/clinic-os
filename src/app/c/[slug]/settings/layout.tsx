import { guardClinic } from "@/lib/guard";
import { redirect } from "next/navigation";
import { can } from "@/lib/auth";
import { SettingsFrame } from "./settings-nav";

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

  return (
    <SettingsFrame
      slug={slug}
      caps={access.caps}
      has={{
        einvoicing: access.clinic.features.einvoicing,
        dental: !!access.clinic.features.dental,
        face: !!access.clinic.features.aesthetic,
        devices: access.clinic.features.devices,
      }}
    >
      {children}
    </SettingsFrame>
  );
}
