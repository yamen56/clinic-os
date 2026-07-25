import { redirect } from "next/navigation";
import { guardClinic } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { InboxClient } from "./inbox-client";

export default async function ConversationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ open?: string }>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const access = await guardClinic(slug);
  if (access.role === "doctor") redirect(`/c/${slug}`);

  const data = await inClinic(access, async (c) => {
    const quickReplies = (
      await c.query(`select id, title, body from quick_replies where clinic_id = $1 order by sort`, [
        access.clinicId,
      ])
    ).rows;
    const clinic = (
      await c.query(`select timezone from clinics where id = $1`, [access.clinicId])
    ).rows[0];
    return { quickReplies, tz: clinic.timezone as string };
  });

  return (
    <InboxClient
      slug={slug}
      tz={data.tz}
      selfId={access.session.user.id}
      initialOpenId={sp.open ?? null}
      initialQuickReplies={JSON.parse(JSON.stringify(data.quickReplies))}
    />
  );
}
