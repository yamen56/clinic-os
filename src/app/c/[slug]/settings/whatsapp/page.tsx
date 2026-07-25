import { guardClinic } from "@/lib/guard";
import { WhatsappClient } from "./whatsapp-client";

export default async function WhatsappSettingsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const access = await guardClinic(slug);
  return <WhatsappClient slug={slug} canEdit={access.role !== "doctor"} />;
}
