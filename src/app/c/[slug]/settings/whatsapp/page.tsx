import { guardClinic } from "@/lib/guard";
import { WhatsappClient } from "./whatsapp-client";
import { can } from "@/lib/auth";

export default async function WhatsappSettingsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const access = await guardClinic(slug);
  return <WhatsappClient slug={slug} canEdit={can(access, "settings")} />;
}
