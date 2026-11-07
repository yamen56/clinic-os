import { redirect } from "next/navigation";
import { guardClinic } from "@/lib/guard";
import { can } from "@/lib/auth";
import { isUuid } from "@/lib/uuid";
import { TeamClient } from "./team-client";

/**
 * The team chat. Every member of the staff reaches it, whatever their access:
 * it shows only what colleagues wrote to them. A support visit has no membership
 * of its own, so it has no team to talk to.
 */
export default async function TeamPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ t?: string; m?: string; reply?: string }>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const access = await guardClinic(slug);
  if (!access.memberId) redirect(`/c/${slug}`);
  return (
    <TeamClient
      slug={slug}
      tz={access.clinic.timezone}
      meId={access.session.user.id}
      showPatients={can(access, "conversations")}
      initialOpenId={sp.t && isUuid(sp.t) ? sp.t : null}
      initialMessageId={sp.m && isUuid(sp.m) ? sp.m : null}
      initialReply={sp.reply === '1'}
    />
  );
}
