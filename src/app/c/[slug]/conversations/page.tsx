import { redirect } from "next/navigation";
import { guardClinic } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { InboxClient } from "./inbox-client";
import { can } from "@/lib/auth";

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
  // Without the patient inbox there is still the team. A support visit has neither.
  if (!can(access, "conversations")) redirect(access.memberId ? `/c/${slug}/conversations/team` : `/c/${slug}`);

  const data = await inClinic(access, async (c) => {
    const quickReplies = (
      await c.query(`select id, title, body from quick_replies where clinic_id = $1 order by sort`, [
        access.clinicId,
      ])
    ).rows;
    return { quickReplies };
  });

  return (
    <InboxClient
      slug={slug}
      tz={access.clinic.timezone}
      selfId={access.session.user.id}
      initialOpenId={sp.open ?? null}
      initialQuickReplies={JSON.parse(JSON.stringify(data.quickReplies))}
      hasTeam={!!access.memberId}
    />
  );
}
